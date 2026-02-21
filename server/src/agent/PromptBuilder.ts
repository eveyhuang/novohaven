/**
 * PromptBuilder — assembles the full prompt from layered sources.
 *
 * Layers:
 * 1. Agent personality/instructions (from agent_configs.system_prompt)
 * 2. Available tools summary (from registered tool plugins)
 * 3. Relevant skills (keyword-based initially, vector search in Phase 7)
 * 4. Active execution context (if a workflow is running)
 * 5. Company standards (if referenced)
 * 6. Session history (last N turns from session_messages)
 */
import Database from 'better-sqlite3';
import { MessageAttachment, ToolDefinition } from '../plugins/types';
import { AgentConfig } from '../types';

export interface BuiltPrompt {
  systemPrompt: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    attachments?: MessageAttachment[];
    toolCallId?: string;
    toolCalls?: Array<{ id: string; name: string; args: Record<string, any> }>;
  }>;
}

export class PromptBuilder {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Build the full prompt for a turn.
   */
  build(opts: {
    sessionId: string;
    agentConfig: AgentConfig;
    tools: ToolDefinition[];
    historyLimit?: number;
  }): BuiltPrompt {
    const { sessionId, agentConfig, tools, historyLimit = 50 } = opts;

    // Build system prompt from layers
    const systemParts: string[] = [];

    // Layer 1: Agent personality
    if (agentConfig.system_prompt) {
      systemParts.push(agentConfig.system_prompt);
    }

    // Layer 2: Available tools
    if (tools.length > 0) {
      const toolSummary = tools.map(t => `- **${t.name}**: ${t.description}`).join('\n');
      systemParts.push(`\n## Available Tools\nYou have access to the following tools:\n${toolSummary}`);
      const toolNames = tools.map(t => `\`${t.name}\``).join(', ');
      systemParts.push(
        [
          '\n## Tool Call Rules',
          `When a tool is needed, call the tool function directly using its exact name: ${toolNames}.`,
          'Do not output pseudo tool markup or examples such as `<skill:execute>...</skill:execute>`, `skill:execute`, `tool: ...`, or code blocks that describe tool calls.',
          'If execution is needed, perform the actual tool call first, then report concrete results from the tool output.',
        ].join('\n')
      );
      systemParts.push(
        [
          '\n## Completion And Reuse Rules',
          'If the user asks for a file (CSV/JSON/Markdown/etc.), you must return the real generated file path or inline file content from tool output.',
          'Do not claim a file was created unless a tool output confirms it.',
          'After a successful ad-hoc multi-step task (especially browser + extraction + file output), propose reusability by creating a draft with `skill_create` unless an existing suitable skill/workflow was already used.',
          'If an existing skill/workflow was used but required fixes, submit improvements via `skill_edit`.',
        ].join('\n')
      );
    }

    // Layer 3: Relevant skills (keyword search)
    const skillContext = this.getRelevantSkillsContext(sessionId);
    if (skillContext) {
      systemParts.push(`\n## Available Skills\n${skillContext}`);
    }

    // Layer 4: Active execution context
    const executionContext = this.getActiveExecutionContext(sessionId);
    if (executionContext) {
      systemParts.push(`\n## Active Workflow\n${executionContext}`);
    }

    // Layer 5: Company standards summary
    const standardsContext = this.getCompanyStandardsContext();
    if (standardsContext) {
      systemParts.push(`\n## Company Standards\n${standardsContext}`);
    }

    const systemPrompt = systemParts.join('\n\n');

    // Layer 6: Session history
    // Only include user and final assistant messages (no intermediate tool call/result messages)
    // Tool call loops are handled in-memory during the current turn by AgentRunner
    const history = this.db.prepare(
      `SELECT * FROM session_messages
       WHERE session_id = ? AND role IN ('user', 'assistant') AND tool_calls IS NULL
       ORDER BY created_at ASC LIMIT ?`
    ).all(sessionId, historyLimit) as any[];

    const messages = history.map((m: any) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    return { systemPrompt, messages };
  }

  /**
   * Search for relevant skills based on the latest user message.
   * Initially uses keyword matching; vector search added in Phase 7.
   */
  private getRelevantSkillsContext(sessionId: string): string | null {
    // Get the latest user message for context
    const lastMsg = this.db.prepare(
      "SELECT content FROM session_messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1"
    ).get(sessionId) as any;

    if (!lastMsg) return null;

    const query = String(lastMsg.content || '').toLowerCase().trim();
    const tokens = this.tokenizeQuery(query);
    if (!query || tokens.length === 0) return null;

    const session = this.db.prepare(
      'SELECT user_id FROM sessions WHERE id = ?'
    ).get(sessionId) as { user_id?: number } | undefined;
    const userId = session?.user_id || 1;

    const candidates = [
      ...(this.db.prepare(`
        SELECT id, name, description, tags, 'skill' as type
        FROM skills
        WHERE status = 'active' AND (created_by = ? OR created_by IS NULL)
        ORDER BY updated_at DESC
        LIMIT 200
      `).all(userId) as any[]),
      ...(this.db.prepare(`
        SELECT id, name, description, tags, 'workflow' as type
        FROM workflows
        WHERE status = 'active' AND (created_by = ? OR created_by IS NULL)
        ORDER BY updated_at DESC
        LIMIT 200
      `).all(userId) as any[]),
    ];

    const ranked = candidates.map((candidate) => {
      const steps = this.db.prepare(
        'SELECT step_name, step_type, prompt_template, input_config FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
      ).all(candidate.id, candidate.type) as any[];
      const score = this.scoreAssetRelevance(query, tokens, candidate, steps);
      return { candidate, steps, score };
    })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (ranked.length === 0) return null;

    const top = ranked[0];
    const lines = ranked.map(({ candidate, steps, score }) => {
      const stepTypes = steps.map((s: any) => s.step_type).filter(Boolean);
      const inputs = this.extractRequiredInputsFromSteps(steps);
      const inputText = inputs.length > 0 ? ` | required: ${inputs.join(', ')}` : '';
      const stepText = stepTypes.length > 0 ? ` | steps: ${stepTypes.join(' -> ')}` : '';
      return `- [${candidate.type} #${candidate.id}] ${candidate.name} (score ${score})${stepText}${inputText}`;
    });

    return [
      `Top match to execute first: [${top.candidate.type} #${top.candidate.id}] ${top.candidate.name}.`,
      'Prefer executing a high-confidence existing skill/workflow before proposing a new one.',
      'Relevant assets:',
      ...lines,
      'Use `skill_search` for deeper lookup and `skill_execute` when required inputs are available.',
    ].join('\n');
  }

  private tokenizeQuery(query: string): string[] {
    const normalized = String(query || '').toLowerCase().trim();
    if (!normalized) return [];

    const tokens = new Set<string>();
    const asciiTokens = normalized.split(/[^a-z0-9_]+/).filter((t) => t.length >= 2);
    asciiTokens.forEach((t) => tokens.add(t));

    const cjkChunks = normalized.match(/[\u3400-\u9fff]+/g) || [];
    for (const chunk of cjkChunks) {
      if (chunk.length >= 2) tokens.add(chunk);
      if (chunk.length >= 3) {
        for (let i = 0; i <= chunk.length - 2; i++) {
          tokens.add(chunk.slice(i, i + 2));
        }
      }
    }

    if (tokens.size === 0 && normalized.length >= 2) {
      tokens.add(normalized);
    }
    return Array.from(tokens);
  }

  private parseTags(raw: any): string[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map((t) => String(t));
    try {
      const parsed = JSON.parse(String(raw));
      if (Array.isArray(parsed)) return parsed.map((t) => String(t));
    } catch {}
    return [];
  }

  private scoreAssetRelevance(query: string, tokens: string[], candidate: any, steps: any[]): number {
    const name = String(candidate?.name || '').toLowerCase();
    const desc = String(candidate?.description || '').toLowerCase();
    const tags = this.parseTags(candidate?.tags).join(' ').toLowerCase();
    const stepText = steps
      .map((s: any) => `${s.step_name || ''} ${s.step_type || ''} ${s.prompt_template || ''}`)
      .join(' ')
      .toLowerCase();
    const blob = `${name} ${desc} ${tags} ${stepText}`;

    let score = 0;
    if (name.includes(query)) score += 80;
    if (desc.includes(query)) score += 30;
    if (tags.includes(query)) score += 35;

    for (const token of tokens) {
      if (name.includes(token)) score += 18;
      if (desc.includes(token)) score += 10;
      if (tags.includes(token)) score += 14;
      if (stepText.includes(token)) score += 8;
    }

    const csvIntent = /\bcsv\b|spreadsheet|导出|表格|输出文件/.test(query);
    if (csvIntent) {
      if (/\bcsv\b|spreadsheet|导出|表格|\.csv/.test(blob)) score += 12;
      else score -= 4;
    }

    const workflowIntent = /\bworkflow\b|pipeline|multi[-\s]?step|流程|链路|步骤/.test(query);
    if (workflowIntent && candidate?.type === 'workflow') score += 8;

    if (score < 18) return 0;
    return score;
  }

  private extractRequiredInputsFromSteps(steps: any[]): string[] {
    const vars = new Set<string>();
    for (const step of steps) {
      try {
        const config = JSON.parse(step.input_config || '{}');
        if (config.variables && !Array.isArray(config.variables)) {
          for (const [name, varDef] of Object.entries(config.variables) as any[]) {
            if (!varDef?.optional) vars.add(`{{${name}}}`);
          }
        }
      } catch {}

      const prompt = String(step.prompt_template || '');
      const matches = prompt.match(/\{\{([^}]+)\}\}/g) || [];
      for (const match of matches) {
        const key = match.replace(/\{\{|\}\}/g, '').trim();
        if (!key || key.startsWith('step_')) continue;
        vars.add(`{{${key}}}`);
      }
    }
    return Array.from(vars);
  }

  /**
   * Get context about any active workflow execution in this session.
   */
  private getActiveExecutionContext(sessionId: string): string | null {
    const session = this.db.prepare('SELECT active_execution_id FROM sessions WHERE id = ?').get(sessionId) as any;
    if (!session?.active_execution_id) return null;

    const execution = this.db.prepare(
      'SELECT * FROM executions WHERE id = ?'
    ).get(session.active_execution_id) as any;

    if (!execution || execution.status === 'completed' || execution.status === 'failed') return null;

    // Get current step info
    const steps = this.db.prepare(
      'SELECT * FROM step_executions WHERE execution_id = ? ORDER BY step_order ASC'
    ).all(execution.id) as any[];

    const currentStep = steps.find((s: any) => s.status === 'running' || s.status === 'pending_review');
    const completedCount = steps.filter((s: any) => s.status === 'completed').length;

    let context = `Workflow execution #${execution.id} is in progress (${completedCount}/${steps.length} steps complete).`;
    if (currentStep) {
      context += `\nCurrent step: "${currentStep.step_name}" (${currentStep.status})`;
      if (currentStep.status === 'pending_review') {
        context += '\nThis step needs human approval. Ask the user to review.';
      }
    }

    return context;
  }

  /**
   * Get a summary of available company standards.
   */
  private getCompanyStandardsContext(): string | null {
    try {
      const standards = this.db.prepare(
        'SELECT name, type FROM company_standards LIMIT 10'
      ).all() as any[];

      if (standards.length === 0) return null;

      const lines = standards.map((s: any) => `- ${s.name} (${s.type})`);
      return `Available company standards that can be referenced in prompts:\n${lines.join('\n')}`;
    } catch {
      // Table may not exist yet
      return null;
    }
  }
}

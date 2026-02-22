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
    toolCalls?: Array<{ id: string; name: string; args: Record<string, any>; providerData?: Record<string, any> }>;
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
    currentUserText?: string;
  }): BuiltPrompt {
    const { sessionId, agentConfig, tools, historyLimit = 50, currentUserText } = opts;

    // Build system prompt from layers
    const systemParts: string[] = [];

    // Layer 1: Agent personality
    if (agentConfig.system_prompt) {
      systemParts.push(agentConfig.system_prompt);
    }

    const languageHint = this.detectLanguageFromText(currentUserText || '') || this.detectLatestUserLanguage(sessionId);
    systemParts.push(
      [
        '\n## Language Rules',
        'Always reply in the same language as the current user message for this turn.',
        'Do not switch languages unless the user explicitly asks you to.',
        'If the user uses mixed languages, follow the dominant language in that current message.',
        languageHint ? `Detected current user language: ${languageHint}.` : '',
      ].filter(Boolean).join('\n')
    );

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
          '\n## Input Collection Rules',
          'When required inputs are missing, ask for exactly ONE input at a time.',
          'Do not ask for multiple variables in the same message.',
          'After the user provides that input, continue and ask for the next missing input if needed.',
          'Use clear user-facing input labels (for example "product URL") and avoid raw placeholders like `{{product_url}}` in user-visible messages.',
          'Only ask for inputs that are declared as required by the selected skill/workflow.',
          'Do not ask for extra fields (such as "requirements") unless the tool explicitly reports them as missing required inputs.',
          'For image inputs that may include multiple images, support collecting multiple uploads for the same input.',
          'If an image input supports multiple images, confirm whether the user wants to add more images before executing.',
          'When executing with multiple images for one input, pass imageInputs as an index array (for example {"product_images":[1,2]}).',
          'If the user asks to continue/repeat (for example "same for this one"), reuse missing required inputs from recent successful execution memory in the current task.',
          'If the user uploads files and a matching workflow/skill is already identified, call skill_execute directly instead of browsing files with file_read/file_list first.',
          'If all required inputs are already available, execute immediately instead of asking for more clarification.',
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

    const taskSelectionContext = this.getTaskSelectionContext(sessionId);
    if (taskSelectionContext) {
      systemParts.push(`\n## Selected Asset\n${taskSelectionContext}`);
    }

    const executionMemoryContext = this.getSessionExecutionMemoryContext(sessionId);
    if (executionMemoryContext) {
      systemParts.push(`\n## Session Execution Memory\n${executionMemoryContext}`);
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
      `SELECT * FROM (
         SELECT * FROM session_messages
         WHERE session_id = ? AND role IN ('user', 'assistant') AND tool_calls IS NULL
         ORDER BY created_at DESC LIMIT ?
       )
       ORDER BY created_at ASC`
    ).all(sessionId, historyLimit) as any[];
    const boundaryId = this.getLatestTaskBoundaryId(sessionId);
    const scopedHistory = boundaryId
      ? history.filter((m: any) => Number(m.id) > boundaryId)
      : history;

    const messages = scopedHistory.map((m: any) => ({
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

  private detectLatestUserLanguage(sessionId: string): string | null {
    const lastMsg = this.db.prepare(
      "SELECT content FROM session_messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1"
    ).get(sessionId) as any;
    return this.detectLanguageFromText(String(lastMsg?.content || ''));
  }

  private detectLanguageFromText(raw: string): string | null {
    const text = String(raw || '').trim();
    if (!text) return null;

    if (/[\u4e00-\u9fff]/u.test(text)) return 'Chinese';
    if (/[\u3040-\u30ff]/u.test(text)) return 'Japanese';
    if (/[\uac00-\ud7af]/u.test(text)) return 'Korean';
    if (/[\u0400-\u04ff]/u.test(text)) return 'Cyrillic-script language';
    if (/[\u0600-\u06ff]/u.test(text)) return 'Arabic';

    const latinMatches = text.match(/[A-Za-z]/g) || [];
    if (latinMatches.length >= 3) return 'English';
    return null;
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
      'SELECT * FROM workflow_executions WHERE id = ?'
    ).get(session.active_execution_id) as any;

    if (!execution || ['completed', 'failed', 'cancelled'].includes(String(execution.status || ''))) return null;

    // Get current step info
    const steps = this.db.prepare(
      `SELECT se.*, rs.step_name
       FROM step_executions se
       LEFT JOIN recipe_steps rs ON rs.id = se.step_id
       WHERE se.execution_id = ?
       ORDER BY se.step_order ASC`
    ).all(execution.id) as any[];

    const currentStep = steps.find((s: any) => ['running', 'awaiting_review', 'pending'].includes(String(s.status || '')));
    const completedCount = steps.filter((s: any) => s.status === 'completed').length;

    let context = `Workflow execution #${execution.id} is in progress (${completedCount}/${steps.length} steps complete).`;
    if (currentStep) {
      context += `\nCurrent step: "${currentStep.step_name || `Step ${currentStep.step_order}`}" (${currentStep.status})`;
      if (currentStep.status === 'awaiting_review') {
        context += '\nThis step needs human approval. Ask the user to review.';
      }
    }

    return context;
  }

  private getTaskSelectionContext(sessionId: string, scanLimit: number = 500): string | null {
    const rows = this.db.prepare(
      `SELECT id, metadata
       FROM session_messages
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT ?`
    ).all(sessionId, scanLimit) as Array<{ id: number; metadata: string | null }>;

    for (const row of rows) {
      if (!row.metadata) continue;
      try {
        const metadata = JSON.parse(row.metadata);
        if (metadata?.taskBoundary === true) break;
        const sel = metadata?.taskSelection;
        if (sel?.type === 'workflow' && Number.isFinite(Number(sel.id))) {
          return `User selected workflow #${Number(sel.id)} (${String(sel.name || 'Unnamed workflow')}). Use this workflow for execution in this task and do not substitute another skill/workflow unless user explicitly changes selection.`;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private getSessionExecutionMemoryContext(sessionId: string, maxEntries: number = 3): string | null {
    type MemoryRow = {
      task_boundary_id: number | null;
      asset_type: string;
      asset_id: number;
      asset_name: string | null;
      execution_id: number | null;
      execution_status: string | null;
      inputs_json: string;
      step_outputs_json: string;
      latest_output_summary: string | null;
      created_at: string;
    };

    let rows: MemoryRow[] = [];
    try {
      rows = this.db.prepare(
        `SELECT task_boundary_id, asset_type, asset_id, asset_name, execution_id,
                execution_status, inputs_json, step_outputs_json, latest_output_summary, created_at
         FROM session_execution_memory
         WHERE session_id = ?
         ORDER BY id DESC
         LIMIT 20`
      ).all(sessionId) as MemoryRow[];
    } catch {
      return null;
    }
    if (rows.length === 0) return null;

    const boundaryId = this.getLatestTaskBoundaryId(sessionId);
    const scopedRows = rows.filter((row) => {
      if (boundaryId == null) return row.task_boundary_id == null;
      return Number(row.task_boundary_id) === Number(boundaryId);
    });
    const sourceRows = scopedRows.length > 0 ? scopedRows : rows;
    const selected = sourceRows
      .filter((row) => String(row.execution_status || '').toLowerCase() === 'completed')
      .slice(0, maxEntries);
    if (selected.length === 0) return null;

    const lines: string[] = [
      'Use these recent completed execution memories in this task segment when the user requests continuation (for example "same as before").',
      'Prefer reusing missing required inputs from the latest matching workflow/skill execution unless user overrides them.',
      'Recent executions:',
    ];

    for (const row of selected) {
      let inputs: Record<string, any> = {};
      let stepOutputs: Array<{ stepOrder?: number; content?: string }> = [];
      try {
        const parsed = JSON.parse(row.inputs_json || '{}');
        if (parsed && typeof parsed === 'object') inputs = parsed;
      } catch {}
      try {
        const parsed = JSON.parse(row.step_outputs_json || '[]');
        if (Array.isArray(parsed)) stepOutputs = parsed;
      } catch {}

      const inputSummary = Object.entries(inputs)
        .slice(0, 6)
        .map(([key, value]) => `${this.humanizeInputName(key)}=${this.summarizeMemoryValue(value)}`)
        .join(', ');
      const stepPreview = (stepOutputs.find((s) => Number(s?.stepOrder) === 1)?.content || row.latest_output_summary || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);

      lines.push(
        `- [${row.asset_type} #${row.asset_id}] ${row.asset_name || 'Unnamed'} | execution #${row.execution_id || 'n/a'} | status ${row.execution_status || 'unknown'} | created ${row.created_at}`
      );
      if (inputSummary) lines.push(`  Reusable inputs: ${inputSummary}`);
      if (stepPreview) lines.push(`  Step output hint: ${stepPreview}${stepPreview.length >= 240 ? '...' : ''}`);
    }

    return lines.join('\n');
  }

  private getLatestTaskBoundaryId(sessionId: string, scanLimit: number = 500): number | null {
    const rows = this.db.prepare(
      `SELECT id, metadata
       FROM session_messages
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT ?`
    ).all(sessionId, scanLimit) as Array<{ id: number; metadata: string | null }>;

    for (const row of rows) {
      if (!row.metadata) continue;
      try {
        const metadata = JSON.parse(row.metadata);
        if (metadata?.taskBoundary === true) {
          return Number(row.id);
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private summarizeMemoryValue(value: any): string {
    if (typeof value === 'string') {
      if (value.startsWith('data:image/')) return '[cached image]';
      const normalized = value.replace(/\s+/g, ' ').trim();
      return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
    }
    if (Array.isArray(value)) {
      const imageCount = value.filter((item) => typeof item === 'string' && String(item).startsWith('data:image/')).length;
      if (imageCount > 0) return `[${imageCount} cached image(s)]`;
      return `[${value.length} item(s)]`;
    }
    if (value == null) return 'none';
    const text = String(value);
    return text.length > 80 ? `${text.slice(0, 80)}...` : text;
  }

  private humanizeInputName(varName: string): string {
    const normalized = String(varName || 'input')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return 'Input';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
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

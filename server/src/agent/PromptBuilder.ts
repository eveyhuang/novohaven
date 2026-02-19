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
    const history = this.db.prepare(
      'SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
    ).all(sessionId, historyLimit) as any[];

    const messages = history.map((m: any) => ({
      role: m.role as 'user' | 'assistant' | 'system' | 'tool',
      content: m.content,
      ...(m.tool_calls ? { toolCallId: m.tool_calls } : {}),
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

    const query = lastMsg.content.toLowerCase();
    const words = query.split(/\s+/).filter((w: string) => w.length > 3);
    if (words.length === 0) return null;

    // Keyword search against skills and workflows
    const likeClause = words.map(() => '(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)').join(' OR ');
    const params = words.flatMap((w: string) => [`%${w}%`, `%${w}%`]);

    const skills = this.db.prepare(`
      SELECT id, name, description, 'skill' as type FROM skills WHERE status = 'active' AND (${likeClause})
      UNION ALL
      SELECT id, name, description, 'workflow' as type FROM workflows WHERE status = 'active' AND (${likeClause})
      LIMIT 5
    `).all(...params, ...params) as any[];

    if (skills.length === 0) return null;

    const lines = skills.map((s: any) =>
      `- **${s.name}** (${s.type} #${s.id}): ${s.description || 'No description'}`
    );

    return `The following skills/workflows may be relevant. Use \`skill:search\` or \`skill:execute\` to work with them:\n${lines.join('\n')}`;
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

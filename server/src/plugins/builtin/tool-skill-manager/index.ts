/**
 * tool-skill-manager — Agent tools for skill/workflow management.
 *
 * Provides: skill_search, skill_execute, skill_test, skill_edit,
 *           skill_create, skill_validate
 */
import Database from 'better-sqlite3';
import path from 'path';
import {
  ToolPlugin, PluginManifest, ToolDefinition, ToolContext, ToolResult,
} from '../../types';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../../../data/novohaven.db');

class SkillManagerPlugin implements ToolPlugin {
  manifest: PluginManifest;
  private db: Database.Database | null = null;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(): Promise<void> {
    // Open DB connection (may run in child process)
    this.db = new Database(DB_PATH, { readonly: false });
    this.db.pragma('journal_mode = WAL');
  }

  async shutdown(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'skill_search',
        description: 'Search for skills and workflows by name or description',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            type: { type: 'string', enum: ['skill', 'workflow', 'all'], description: 'Filter by type (default: all)' },
            limit: { type: 'number', description: 'Max results (default 5)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'skill_execute',
        description: 'Execute a skill or workflow by ID with given inputs',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill or workflow ID' },
            skillType: { type: 'string', enum: ['skill', 'workflow'] },
            inputs: { type: 'object', description: 'Input variables' },
          },
          required: ['skillId', 'skillType'],
        },
      },
      {
        name: 'skill_test',
        description: 'Test a skill with inputs without saving results',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill ID to test' },
            inputs: { type: 'object', description: 'Test inputs' },
          },
          required: ['skillId'],
        },
      },
      {
        name: 'skill_edit',
        description: 'Propose edits to a skill. Creates a draft on the Skill Draft Review page for human approval. Use this to fix or improve broken skills.',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill ID' },
            name: { type: 'string' },
            description: { type: 'string' },
            steps: { type: 'array', items: { type: 'object' } },
            changeSummary: { type: 'string', description: 'What changed and why' },
          },
          required: ['skillId', 'changeSummary'],
        },
      },
      {
        name: 'skill_create',
        description: 'Create a new skill draft (requires human approval)',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            skillType: { type: 'string', enum: ['skill', 'workflow'] },
            steps: { type: 'array', items: { type: 'object' } },
          },
          required: ['name', 'description', 'steps'],
        },
      },
      {
        name: 'skill_validate',
        description: 'Validate a skill for missing variables or invalid configs',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill ID to validate' },
          },
          required: ['skillId'],
        },
      },
    ];
  }

  async execute(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    if (!this.db) {
      return { success: false, output: 'Skill manager not initialized' };
    }

    switch (toolName) {
      case 'skill_search': return this.search(args);
      case 'skill_execute': return this.executeSkill(args, context);
      case 'skill_test': return this.testSkill(args);
      case 'skill_edit': return this.editSkill(args, context);
      case 'skill_create': return this.createSkill(args, context);
      case 'skill_validate': return this.validateSkill(args);
      default: return { success: false, output: `Unknown tool: ${toolName}` };
    }
  }

  private async search(args: Record<string, any>): Promise<ToolResult> {
    const { query, type = 'all', limit = 5 } = args;
    const words = query.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);

    if (words.length === 0) {
      return { success: false, output: 'Search query too short' };
    }

    const results: any[] = [];

    if (type === 'all' || type === 'skill') {
      const likeClause = words.map(() => '(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)').join(' OR ');
      const params = words.flatMap((w: string) => [`%${w}%`, `%${w}%`]);

      const skills = this.db!.prepare(`
        SELECT id, name, description, 'skill' as type, status, tags
        FROM skills WHERE status = 'active' AND (${likeClause})
        LIMIT ?
      `).all(...params, limit) as any[];
      results.push(...skills);
    }

    if (type === 'all' || type === 'workflow') {
      const likeClause = words.map(() => '(LOWER(name) LIKE ? OR LOWER(description) LIKE ?)').join(' OR ');
      const params = words.flatMap((w: string) => [`%${w}%`, `%${w}%`]);

      const workflows = this.db!.prepare(`
        SELECT id, name, description, 'workflow' as type, status, tags
        FROM workflows WHERE status = 'active' AND (${likeClause})
        LIMIT ?
      `).all(...params, limit) as any[];
      results.push(...workflows);
    }

    if (results.length === 0) {
      return { success: true, output: 'No matching skills or workflows found.' };
    }

    const formatted = results.map((r: any) => {
      const steps = this.db!.prepare(
        'SELECT step_name, step_type FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
      ).all(r.id, r.type) as any[];
      const stepSummary = steps.map((s: any) => `${s.step_name} (${s.step_type})`).join(' → ');
      return `[${r.type} #${r.id}] ${r.name}: ${r.description || 'No description'}\n  Steps: ${stepSummary || 'none'}`;
    });

    return { success: true, output: formatted.join('\n\n') };
  }

  private async executeSkill(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const { skillId, skillType, inputs = {} } = args;

    // Verify the skill exists
    const table = skillType === 'skill' ? 'skills' : 'workflows';
    const skill = this.db!.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(skillId) as any;
    if (!skill) {
      return { success: false, output: `${skillType} #${skillId} not found` };
    }

    // Get steps
    const steps = this.db!.prepare(
      'SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
    ).all(skillId, skillType) as any[];

    if (steps.length === 0) {
      return { success: false, output: `${skillType} #${skillId} has no steps` };
    }

    // Create an execution record
    const result = this.db!.prepare(`
      INSERT INTO workflow_executions (recipe_id, user_id, input_data, status, started_at)
      VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)
    `).run(skillId, context.userId, JSON.stringify(inputs));

    const executionId = Number(result.lastInsertRowid);

    // Create step execution records
    for (const step of steps) {
      this.db!.prepare(`
        INSERT INTO step_executions (execution_id, step_id, step_order, status)
        VALUES (?, ?, ?, 'pending')
      `).run(executionId, step.id, step.step_order);
    }

    return {
      success: true,
      output: `Created execution #${executionId} for ${skillType} "${skill.name}" with ${steps.length} steps. The workflow engine will process it.`,
      metadata: { executionId },
    };
  }

  private async testSkill(args: Record<string, any>): Promise<ToolResult> {
    const { skillId, inputs = {} } = args;

    // Get the skill and its steps
    let skill = this.db!.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any;
    let skillType = 'skill';
    if (!skill) {
      skill = this.db!.prepare('SELECT * FROM workflows WHERE id = ?').get(skillId) as any;
      skillType = 'workflow';
    }
    if (!skill) {
      return { success: false, output: `Skill #${skillId} not found` };
    }

    const steps = this.db!.prepare(
      'SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
    ).all(skillId, skillType) as any[];

    // Build a preview of what would happen
    const preview: string[] = [`Test preview for "${skill.name}" (${skillType} #${skillId}):`];
    for (const step of steps) {
      let prompt = step.prompt_template || '';
      // Replace variables with test inputs
      for (const [key, value] of Object.entries(inputs)) {
        prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
      }
      // Check for unresolved variables
      const unresolved = prompt.match(/\{\{[^}]+\}\}/g) || [];
      preview.push(`\nStep ${step.step_order}: ${step.step_name} (${step.step_type})`);
      preview.push(`  Model: ${step.ai_model || 'default'}`);
      preview.push(`  Prompt preview: ${prompt.substring(0, 200)}${prompt.length > 200 ? '...' : ''}`);
      if (unresolved.length > 0) {
        preview.push(`  ⚠ Unresolved variables: ${unresolved.join(', ')}`);
      }
    }

    return { success: true, output: preview.join('\n') };
  }

  private async editSkill(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const { skillId, name, description, steps, changeSummary } = args;

    // Verify skill exists
    let skill = this.db!.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any;
    let skillType = 'skill';
    if (!skill) {
      skill = this.db!.prepare('SELECT * FROM workflows WHERE id = ?').get(skillId) as any;
      skillType = 'workflow';
    }
    if (!skill) {
      return { success: false, output: `Skill #${skillId} not found` };
    }

    // Create a draft
    const result = this.db!.prepare(`
      INSERT INTO skill_drafts (original_skill_id, skill_type, proposed_by_session, name, description, steps, change_summary, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      skillId,
      skillType,
      context.sessionId,
      name || skill.name,
      description || skill.description,
      JSON.stringify(steps || []),
      changeSummary
    );

    const draftId = Number(result.lastInsertRowid);

    return {
      success: true,
      output: `Created draft #${draftId} for editing ${skillType} "${skill.name}". Changes: ${changeSummary}\nThis draft requires human approval before being applied.`,
      metadata: { draftId },
    };
  }

  private async createSkill(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const { name, description, skillType = 'skill', steps } = args;

    // Create a draft (not directly a skill — requires approval)
    const result = this.db!.prepare(`
      INSERT INTO skill_drafts (original_skill_id, skill_type, proposed_by_session, name, description, steps, change_summary, status)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      skillType,
      context.sessionId,
      name,
      description,
      JSON.stringify(steps),
      `New ${skillType} created by agent`
    );

    const draftId = Number(result.lastInsertRowid);

    return {
      success: true,
      output: `Created draft #${draftId} for new ${skillType} "${name}" with ${steps.length} steps.\nThis draft requires human approval before becoming active.`,
      metadata: { draftId },
    };
  }

  private async validateSkill(args: Record<string, any>): Promise<ToolResult> {
    const { skillId } = args;

    // Find the skill
    let skill = this.db!.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any;
    let skillType = 'skill';
    if (!skill) {
      skill = this.db!.prepare('SELECT * FROM workflows WHERE id = ?').get(skillId) as any;
      skillType = 'workflow';
    }
    if (!skill) {
      return { success: false, output: `Skill #${skillId} not found` };
    }

    const steps = this.db!.prepare(
      'SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
    ).all(skillId, skillType) as any[];

    const issues: string[] = [];

    if (steps.length === 0) {
      issues.push('No steps defined');
    }

    for (const step of steps) {
      if (!step.prompt_template && step.step_type === 'ai') {
        issues.push(`Step ${step.step_order} ("${step.step_name}"): Missing prompt template`);
      }

      if (!step.step_name) {
        issues.push(`Step ${step.step_order}: Missing step name`);
      }

      // Check for step output references that reference non-existent steps
      if (step.prompt_template) {
        const refs = step.prompt_template.match(/\{\{step_(\d+)_output\}\}/g) || [];
        for (const ref of refs) {
          const refNum = parseInt(ref.match(/\d+/)![0]);
          if (refNum >= step.step_order) {
            issues.push(`Step ${step.step_order}: References step_${refNum}_output but that step hasn't run yet`);
          }
          if (!steps.some((s: any) => s.step_order === refNum)) {
            issues.push(`Step ${step.step_order}: References step_${refNum}_output but step ${refNum} doesn't exist`);
          }
        }
      }

      // Check for missing model on AI steps
      if (step.step_type === 'ai' && !step.ai_model) {
        issues.push(`Step ${step.step_order} ("${step.step_name}"): No AI model specified (will use default)`);
      }
    }

    // Check step ordering
    const orders = steps.map((s: any) => s.step_order);
    const expectedOrders = steps.map((_: any, i: number) => i + 1);
    if (JSON.stringify(orders) !== JSON.stringify(expectedOrders)) {
      issues.push(`Step ordering is non-sequential: [${orders.join(', ')}]`);
    }

    if (issues.length === 0) {
      return { success: true, output: `${skillType} "${skill.name}" is valid. ${steps.length} steps, all checks passed.` };
    }

    return {
      success: true,
      output: `Validation for ${skillType} "${skill.name}" found ${issues.length} issue(s):\n${issues.map(i => `- ${i}`).join('\n')}`,
    };
  }
}

export default SkillManagerPlugin;

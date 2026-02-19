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
        description: 'Execute a skill or workflow by ID with given inputs. For image inputs, map the variable name to the attachment index (0-based) from the user\'s uploaded images using imageInputs.',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill or workflow ID' },
            skillType: { type: 'string', enum: ['skill', 'workflow'] },
            inputs: { type: 'object', description: 'Text input variables (key=variable name, value=text)' },
            imageInputs: { type: 'object', description: 'Image input variables. Map variable name to attachment index (e.g., {"reference_image": 0, "product_images": 1}). Index refers to the user\'s uploaded images in order.' },
          },
          required: ['skillId', 'skillType'],
        },
      },
      {
        name: 'skill_test',
        description: 'Test a skill with inputs without saving results. For image inputs, use imageInputs to map variable names to attachment indices.',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill ID to test' },
            inputs: { type: 'object', description: 'Text input variables' },
            imageInputs: { type: 'object', description: 'Image input variables mapped to attachment indices (e.g., {"reference_image": 0})' },
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
      case 'skill_test': return this.testSkill(args, context);
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
        'SELECT step_name, step_type, input_config, prompt_template FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
      ).all(r.id, r.type) as any[];
      const stepSummary = steps.map((s: any) => `${s.step_name} (${s.step_type})`).join(' → ');

      // Extract required inputs from input_config and prompt template variables
      const inputs: string[] = [];
      for (const step of steps) {
        // Parse input_config for typed variables
        try {
          const config = JSON.parse(step.input_config || '{}');
          if (config.variables) {
            for (const [varName, varDef] of Object.entries(config.variables) as any[]) {
              const typeLabel = varDef.type || 'text';
              const desc = varDef.description || varDef.label || '';
              inputs.push(`{{${varName}}} (${typeLabel})${desc ? ': ' + desc : ''}`);
            }
          }
        } catch {}
        // Also extract {{variable}} patterns from prompt template
        if (step.prompt_template) {
          const vars = step.prompt_template.match(/\{\{([^}]+)\}\}/g) || [];
          for (const v of vars) {
            const name = v.replace(/\{\{|\}\}/g, '');
            if (!inputs.some(i => i.includes(`{{${name}}}`)) && !name.startsWith('step_')) {
              inputs.push(`{{${name}}} (text)`);
            }
          }
        }
      }

      let result = `[${r.type} #${r.id}] ${r.name}: ${r.description || 'No description'}\n  Steps: ${stepSummary || 'none'}`;
      if (inputs.length > 0) {
        result += `\n  Required inputs: ${inputs.join(', ')}`;
      }
      return result;
    });

    return { success: true, output: formatted.join('\n\n') };
  }

  private async executeSkill(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const { skillId, skillType, inputs = {}, imageInputs = {} } = args;
    const parentType: 'skill' | 'workflow' = skillType === 'workflow' ? 'workflow' : 'skill';

    // Verify the skill exists
    const table = parentType === 'skill' ? 'skills' : 'workflows';
    const skill = this.db!.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(skillId) as any;
    if (!skill) {
      return { success: false, output: `${parentType} #${skillId} not found` };
    }

    // Get steps
    const steps = this.db!.prepare(
      'SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
    ).all(skillId, parentType) as any[];

    if (steps.length === 0) {
      return { success: false, output: `${parentType} #${skillId} has no steps` };
    }

    const inputSpecs = this.collectInputSpecs(steps);

    // Resolve image inputs from conversation attachments
    const resolvedInputs = { ...inputs };
    const attachments = context.attachments || [];
    for (const [varName, idx] of Object.entries(imageInputs)) {
      const attachIdx = typeof idx === 'number' ? idx : parseInt(idx as string, 10);
      if (attachments[attachIdx]) {
        resolvedInputs[varName] = `[image:attachment_${attachIdx}]`;
      } else {
        resolvedInputs[varName] = `[image:missing_attachment_${attachIdx}]`;
      }
    }

    // If there's a single image variable and at least one uploaded image,
    // auto-map it when the model omits/uses the wrong image input key.
    const imageVars = Array.from(inputSpecs.entries())
      .filter(([, spec]) => spec.type === 'image')
      .map(([name]) => name);
    if (imageVars.length === 1 && attachments.length > 0 && !resolvedInputs[imageVars[0]]) {
      resolvedInputs[imageVars[0]] = '[image:attachment_0]';
    }

    const missingRequired = Array.from(inputSpecs.entries())
      .filter(([, spec]) => !spec.optional)
      .map(([name, spec]) => ({ name, spec }))
      .filter(({ name, spec }) => {
        if (spec.type === 'file') {
          // File variables are often satisfied by an uploaded attachment that the model
          // references implicitly; don't block execution solely on missing structured text.
          return false;
        }
        const v = resolvedInputs[name];
        if (v == null) return true;
        if (typeof v === 'string') {
          if (spec.type === 'image') return v.includes('[image:missing_attachment_');
          return v.trim().length === 0;
        }
        return false;
      });

    if (missingRequired.length > 0) {
      const requiredList = missingRequired
        .map(({ name, spec }) => `{{${name}}} (${spec.type}${spec.label ? `: ${spec.label}` : ''})`)
        .join(', ');
      const optionalList = Array.from(inputSpecs.entries())
        .filter(([, spec]) => spec.optional)
        .map(([name, spec]) => `{{${name}}} (${spec.type})`)
        .join(', ');
      return {
        success: false,
        output: `Missing required inputs for ${parentType} "${skill.name}": ${requiredList}.${optionalList ? ` Optional inputs: ${optionalList}.` : ''}`,
      };
    }

    const { recipeId, recipeStepIdByOrder } = this.ensureExecutionRecipe(skill, parentType, steps);

    // Create an execution record
    const result = this.db!.prepare(`
      INSERT INTO workflow_executions (recipe_id, user_id, input_data, status, started_at)
      VALUES (?, ?, ?, 'running', CURRENT_TIMESTAMP)
    `).run(recipeId, context.userId, JSON.stringify(resolvedInputs));

    const executionId = Number(result.lastInsertRowid);

    // Create step execution records
    for (const step of steps) {
      const recipeStepId = recipeStepIdByOrder.get(step.step_order) ?? null;
      this.db!.prepare(`
        INSERT INTO step_executions (execution_id, step_id, step_order, status)
        VALUES (?, ?, ?, 'pending')
      `).run(executionId, recipeStepId, step.step_order);
    }

    const imageCount = Object.keys(imageInputs).length;
    const inputSummary = Object.keys(resolvedInputs).length > 0
      ? `\nInputs: ${Object.entries(resolvedInputs).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 50 ? v.substring(0, 50) + '...' : v}`).join(', ')}`
      : '';

    return {
      success: true,
      output: `Created execution #${executionId} for ${parentType} "${skill.name}" with ${steps.length} steps${imageCount > 0 ? ` and ${imageCount} image(s)` : ''}.${inputSummary}\nThe workflow engine will process it.`,
      metadata: { executionId },
    };
  }

  private async testSkill(args: Record<string, any>, context?: ToolContext): Promise<ToolResult> {
    const { skillId, inputs = {}, imageInputs = {} } = args;

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

    // Resolve image inputs
    const attachments = context?.attachments || [];
    const resolvedInputs = { ...inputs };
    for (const [varName, idx] of Object.entries(imageInputs)) {
      const attachIdx = typeof idx === 'number' ? idx : parseInt(idx as string, 10);
      resolvedInputs[varName] = attachments[attachIdx]
        ? `[image: user attachment #${attachIdx + 1}]`
        : `[image: missing attachment #${attachIdx + 1}]`;
    }

    // Build a preview of what would happen
    const preview: string[] = [`Test preview for "${skill.name}" (${skillType} #${skillId}):`];
    if (attachments.length > 0) {
      preview.push(`  Available attachments: ${attachments.length} image(s) from conversation`);
    }
    for (const step of steps) {
      let prompt = step.prompt_template || '';
      // Replace variables with test inputs
      for (const [key, value] of Object.entries(resolvedInputs)) {
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

    const inputSpecs = this.collectInputSpecs(steps);
    const requiredInputs = Array.from(inputSpecs.entries())
      .filter(([, spec]) => !spec.optional)
      .map(([name, spec]) => `{{${name}}} (${spec.type})`);
    const optionalInputs = Array.from(inputSpecs.entries())
      .filter(([, spec]) => spec.optional)
      .map(([name, spec]) => `{{${name}}} (${spec.type})`);

    if (issues.length === 0) {
      const suffix = requiredInputs.length > 0
        ? ` Required inputs: ${requiredInputs.join(', ')}.${optionalInputs.length > 0 ? ` Optional: ${optionalInputs.join(', ')}.` : ''}`
        : '';
      return { success: true, output: `${skillType} "${skill.name}" is valid. ${steps.length} steps, all checks passed.${suffix}` };
    }

    return {
      success: true,
      output: `Validation for ${skillType} "${skill.name}" found ${issues.length} issue(s):\n${issues.map(i => `- ${i}`).join('\n')}`,
    };
  }

  private collectInputSpecs(steps: any[]): Map<string, { type: string; optional: boolean; label?: string }> {
    const specs = new Map<string, { type: string; optional: boolean; label?: string }>();
    for (const step of steps) {
      try {
        const config = JSON.parse(step.input_config || '{}');
        if (config.variables) {
          for (const [varName, varDef] of Object.entries(config.variables) as any[]) {
            specs.set(varName, {
              type: varDef?.type || 'text',
              optional: !!varDef?.optional,
              label: varDef?.label,
            });
          }
        }
      } catch {}

      if (step.prompt_template) {
        const vars = step.prompt_template.match(/\{\{([^}]+)\}\}/g) || [];
        for (const v of vars) {
          const name = v.replace(/\{\{|\}\}/g, '').trim();
          if (!name || name.startsWith('step_')) continue;
          if (!specs.has(name)) {
            specs.set(name, { type: 'text', optional: false });
          }
        }
      }
    }
    return specs;
  }

  private ensureExecutionRecipe(
    skill: any,
    skillType: 'skill' | 'workflow',
    steps: any[]
  ): { recipeId: number; recipeStepIdByOrder: Map<number, number> } {
    const existingRecipe = this.db!.prepare('SELECT id FROM recipes WHERE id = ?').get(skill.id) as any;
    let recipeId: number;

    if (existingRecipe) {
      recipeId = skill.id;
      this.db!.prepare(
        'UPDATE recipes SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(skill.name, skill.description || null, recipeId);
    } else {
      const created = this.db!.prepare(
        'INSERT INTO recipes (name, description, created_by, is_template) VALUES (?, ?, ?, ?)'
      ).run(skill.name, skill.description || null, skill.created_by || null, skillType === 'skill' ? 1 : 0);
      recipeId = Number(created.lastInsertRowid);
    }

    const recipeStepIdByOrder = new Map<number, number>();
    const existingSteps = this.db!.prepare(
      'SELECT id, step_order FROM recipe_steps WHERE recipe_id = ?'
    ).all(recipeId) as Array<{ id: number; step_order: number }>;
    const existingByOrder = new Map(existingSteps.map((s) => [s.step_order, s.id]));

    for (const step of steps) {
      const existingId = existingByOrder.get(step.step_order);
      if (existingId) {
        this.db!.prepare(`
          UPDATE recipe_steps
          SET step_name = ?, step_type = ?, ai_model = ?, prompt_template = ?, input_config = ?, output_format = ?, model_config = ?, executor_config = ?
          WHERE id = ?
        `).run(
          step.step_name || `Step ${step.step_order}`,
          step.step_type || 'ai',
          step.ai_model || null,
          step.prompt_template || '',
          step.input_config || '{}',
          step.output_format || 'text',
          step.model_config || '{}',
          step.executor_config || '{}',
          existingId
        );
        recipeStepIdByOrder.set(step.step_order, existingId);
      } else {
        const inserted = this.db!.prepare(`
          INSERT INTO recipe_steps (
            recipe_id, step_order, step_name, step_type, ai_model, prompt_template, input_config, output_format, model_config, api_config, executor_config
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          recipeId,
          step.step_order,
          step.step_name || `Step ${step.step_order}`,
          step.step_type || 'ai',
          step.ai_model || null,
          step.prompt_template || '',
          step.input_config || '{}',
          step.output_format || 'text',
          step.model_config || '{}',
          null,
          step.executor_config || '{}'
        );
        recipeStepIdByOrder.set(step.step_order, Number(inserted.lastInsertRowid));
      }
    }

    return { recipeId, recipeStepIdByOrder };
  }
}

export default SkillManagerPlugin;

/**
 * tool-skill-manager — Agent tools for skill/workflow management.
 *
 * Provides: skill_search, skill_execute, skill_test, skill_edit,
 *           skill_create, skill_validate
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDatabase, initializeDatabase } from '../../../models/database';
import { approveStep, startExecution } from '../../../services/workflowEngine';
import {
  ToolPlugin, PluginManifest, ToolDefinition, ToolContext, ToolResult,
} from '../../types';
import { saveImageToDisk } from '../../../utils/uploadHelpers';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../../../data/novohaven.db');

class SkillManagerPlugin implements ToolPlugin {
  manifest: PluginManifest;
  private db: Database.Database | null = null;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(): Promise<void> {
    try {
      getDatabase();
    } catch {
      // Agent child processes do not run server bootstrap, so initialize query DB here.
      initializeDatabase();
    }

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

    // Keep file inputs from blocking execution when file content is attached or implied.
    for (const [name, spec] of inputSpecs.entries()) {
      if (spec.type === 'file' && (resolvedInputs[name] == null || String(resolvedInputs[name]).trim() === '')) {
        resolvedInputs[name] = '[file:provided_by_user]';
      }
    }

    // Scraping executor accepts urls/product_urls/product_url; normalize common aliases.
    const hasScrapingStep = steps.some((s) => (s.step_type || '').toLowerCase() === 'scraping');
    if (hasScrapingStep) {
      const candidateUrl = resolvedInputs.product_url || resolvedInputs.product_urls || resolvedInputs.urls || resolvedInputs.url;
      if (candidateUrl) {
        if (!resolvedInputs.product_url) resolvedInputs.product_url = candidateUrl;
        if (!resolvedInputs.product_urls) resolvedInputs.product_urls = candidateUrl;
        if (!resolvedInputs.urls) resolvedInputs.urls = candidateUrl;
      }
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

    const { recipeId } = this.ensureExecutionRecipe(skill, parentType, steps);

    const startResult = await startExecution(recipeId, context.userId, resolvedInputs);
    if (!startResult.success || !startResult.executionId) {
      return {
        success: false,
        output: `Failed to start execution for ${parentType} "${skill.name}": ${startResult.error || 'unknown error'}`,
      };
    }

    const executionId = startResult.executionId;
    const settled = await this.waitForExecutionToSettle(executionId, context.userId, 120000);
    const imageCount = Object.keys(imageInputs).length;
    const inputSummary = Object.keys(resolvedInputs).length > 0
      ? `\nInputs: ${Object.entries(resolvedInputs).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 60 ? v.substring(0, 60) + '...' : v}`).join(', ')}`
      : '';

    if (settled.timedOut) {
      return {
        success: true,
        output: `Started execution #${executionId} for ${parentType} "${skill.name}" with ${steps.length} steps${imageCount > 0 ? ` and ${imageCount} image(s)` : ''}.${inputSummary}\nExecution is still running. Check /executions/${executionId} for progress.`,
        metadata: { executionId, status: 'running' },
      };
    }

    if (settled.status !== 'completed') {
      const err = settled.errorMessage || `Execution ended with status "${settled.status}"`;
      return {
        success: false,
        output: `Execution #${executionId} for ${parentType} "${skill.name}" did not complete successfully: ${err}`,
        metadata: { executionId, status: settled.status },
      };
    }

    const latestContent = this.extractLatestContent(settled.stepExecutions);
    if (!latestContent) {
      const imageUrls = this.extractAndSaveGeneratedImages(
        settled.stepExecutions, executionId, context.sessionId
      );
      return {
        success: true,
        output: `Execution #${executionId} for ${parentType} "${skill.name}" completed successfully${imageUrls.length > 0 ? ` with ${imageUrls.length} image(s)` : ' but returned no textual output'}.`,
        metadata: {
          executionId,
          status: settled.status,
          ...(imageUrls.length > 0 ? { generatedImageUrls: imageUrls } : {}),
        },
      };
    }

    const csv = this.tryWriteCsvFromOutput(latestContent, executionId, skill.name || `skill-${skillId}`);
    if (csv) {
      return {
        success: true,
        output: `Execution #${executionId} for ${parentType} "${skill.name}" completed.\nCSV file: ${csv.path}\n\nPreview:\n\`\`\`csv\n${csv.preview}\n\`\`\``,
        metadata: { executionId, status: settled.status, csvPath: csv.path },
      };
    }

    // Extract and save any generated images to disk
    const generatedImageUrls = this.extractAndSaveGeneratedImages(
      settled.stepExecutions, executionId, context.sessionId
    );

    const truncated = latestContent.length > 4000 ? `${latestContent.slice(0, 4000)}...` : latestContent;
    return {
      success: true,
      output: `Execution #${executionId} for ${parentType} "${skill.name}" completed.\nResult:\n${truncated}`,
      metadata: {
        executionId,
        status: settled.status,
        ...(generatedImageUrls.length > 0 ? { generatedImageUrls } : {}),
      },
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

  private async waitForExecutionToSettle(
    executionId: number,
    userId: number,
    timeoutMs: number
  ): Promise<{ status: string; stepExecutions: any[]; timedOut: boolean; errorMessage?: string }> {
    const started = Date.now();
    const approvedSteps = new Set<number>();
    let lastStatus = 'running';
    let lastSteps: any[] = [];

    while (Date.now() - started < timeoutMs) {
      const execution = this.db!.prepare(
        'SELECT status FROM workflow_executions WHERE id = ?'
      ).get(executionId) as { status: string } | undefined;
      if (!execution) {
        return { status: 'failed', stepExecutions: [], timedOut: false, errorMessage: 'Execution record not found' };
      }

      lastStatus = execution.status;
      lastSteps = this.db!.prepare(
        'SELECT * FROM step_executions WHERE execution_id = ? ORDER BY step_order'
      ).all(executionId) as any[];

      const awaiting = lastSteps.find((s) => s.status === 'awaiting_review' && !approvedSteps.has(s.id));
      if (awaiting) {
        approvedSteps.add(awaiting.id);
        try {
          await approveStep(executionId, awaiting.id, userId);
        } catch (error: any) {
          return {
            status: 'failed',
            stepExecutions: lastSteps,
            timedOut: false,
            errorMessage: `Failed to auto-approve step #${awaiting.step_order}: ${error?.message || String(error)}`,
          };
        }
        await this.sleep(500);
        continue;
      }

      if (['completed', 'failed', 'cancelled', 'paused'].includes(lastStatus)) {
        const firstError = lastSteps.find((s) => s.error_message)?.error_message as string | undefined;
        return { status: lastStatus, stepExecutions: lastSteps, timedOut: false, errorMessage: firstError };
      }

      await this.sleep(1000);
    }

    return { status: lastStatus, stepExecutions: lastSteps, timedOut: true };
  }

  private extractLatestContent(stepExecutions: any[]): string | null {
    const withOutput = [...stepExecutions].reverse().find((s) => s.output_data);
    if (!withOutput?.output_data) return null;
    try {
      const parsed = JSON.parse(withOutput.output_data);
      if (typeof parsed?.content === 'string') return parsed.content;
      if (parsed?.content != null) return JSON.stringify(parsed.content, null, 2);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return String(withOutput.output_data);
    }
  }

  private extractAndSaveGeneratedImages(
    stepExecutions: any[],
    executionId: number,
    sessionId: string
  ): string[] {
    const urls: string[] = [];
    for (const step of stepExecutions) {
      if (!step.output_data) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(step.output_data);
      } catch {
        continue;
      }
      const images: Array<{ base64: string; mimeType: string }> = parsed?.generatedImages || [];
      images.forEach((img, i) => {
        try {
          const url = saveImageToDisk(
            img.base64,
            img.mimeType || 'image/png',
            sessionId,
            `generated-${executionId}-step${step.step_order || 0}-${i}`
          );
          urls.push(url);
        } catch (err) {
          console.error('[tool-skill-manager] Failed to save generated image:', err);
        }
      });
    }
    return urls;
  }

  private tryWriteCsvFromOutput(
    content: string,
    executionId: number,
    skillName: string
  ): { path: string; preview: string } | null {
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    const rows = this.extractRowsForCsv(parsed);
    if (rows.length === 0) return null;

    const headerSet = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach((k) => headerSet.add(k));
    }
    const headers = Array.from(headerSet);

    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((h) => this.escapeCsvValue(row[h])).join(',')),
    ].join('\n');

    const safeSkill = String(skillName || 'skill')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'skill';
    const csvPath = path.join(os.tmpdir(), `${safeSkill}-execution-${executionId}-${Date.now()}.csv`);
    fs.writeFileSync(csvPath, csv, 'utf8');

    const preview = csv.split('\n').slice(0, 8).join('\n');
    return { path: csvPath, preview };
  }

  private extractRowsForCsv(data: any): Array<Record<string, any>> {
    const rows: Array<Record<string, any>> = [];

    const pushReviewRows = (container: any) => {
      const reviews = Array.isArray(container?.reviews) ? container.reviews : null;
      if (!reviews) return false;
      for (const review of reviews) {
        if (!review || typeof review !== 'object') continue;
        rows.push({
          url: container.url || container.productUrl || '',
          totalCount: container.totalCount ?? '',
          averageRating: container.averageRating ?? '',
          ...review,
        });
      }
      return true;
    };

    if (Array.isArray(data)) {
      for (const item of data) {
        if (pushReviewRows(item)) continue;
        if (item && typeof item === 'object') rows.push(item);
      }
      return rows;
    }

    if (data && typeof data === 'object') {
      if (!pushReviewRows(data)) {
        if (Array.isArray(data.data)) {
          return this.extractRowsForCsv(data.data);
        }
        rows.push(data);
      }
    }

    return rows;
  }

  private escapeCsvValue(value: any): string {
    if (value == null) return '';
    const text = String(value).replace(/\r?\n/g, ' ').replace(/"/g, '""');
    if (/[",]/.test(text)) return `"${text}"`;
    return text;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default SkillManagerPlugin;

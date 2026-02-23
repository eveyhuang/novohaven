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
import { inferInputsFromNaturalLanguage } from './inputAutofill';
import {
  ToolPlugin, PluginManifest, ToolDefinition, ToolContext, ToolResult,
} from '../../types';
import { getUploadsDir, saveImageToDisk } from '../../../utils/uploadHelpers';

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
        description: 'Execute a skill or workflow by ID with given inputs. For image inputs, map the variable name to attachment index/indices (0-based) from user uploads using imageInputs.',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill or workflow ID' },
            skillType: { type: 'string', enum: ['skill', 'workflow'] },
            inputs: { type: 'object', description: 'Text input variables (key=variable name, value=text)' },
            imageInputs: { type: 'object', description: 'Image input variables. Map variable name to one index or an array of indices (e.g., {"reference_image": 0, "product_images": [1,2]}). Indices refer to uploaded images in order.' },
          },
          required: ['skillId', 'skillType'],
        },
      },
      {
        name: 'skill_test',
        description: 'Test a skill with inputs without saving results. For image inputs, use imageInputs to map variable names to one index or array of indices.',
        parameters: {
          type: 'object',
          properties: {
            skillId: { type: 'number', description: 'Skill ID to test' },
            inputs: { type: 'object', description: 'Text input variables' },
            imageInputs: { type: 'object', description: 'Image input variables mapped to index/indices (e.g., {"reference_image": 0, "product_images": [1,2]})' },
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
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const tokens = this.tokenizeQuery(normalizedQuery);
    if (!normalizedQuery || tokens.length === 0) {
      return { success: false, output: 'Search query too short' };
    }

    const candidates: Array<any> = [];
    if (type === 'all' || type === 'skill') {
      const skills = this.db!.prepare(`
        SELECT id, name, description, 'skill' as type, status, tags
        FROM skills WHERE status = 'active'
        ORDER BY updated_at DESC
        LIMIT 200
      `).all() as any[];
      candidates.push(...skills);
    }
    if (type === 'all' || type === 'workflow') {
      const workflows = this.db!.prepare(`
        SELECT id, name, description, 'workflow' as type, status, tags
        FROM workflows WHERE status = 'active'
        ORDER BY updated_at DESC
        LIMIT 200
      `).all() as any[];
      candidates.push(...workflows);
    }

    if (candidates.length === 0) {
      return { success: true, output: 'No matching skills or workflows found.' };
    }

    const ranked = candidates.map((candidate) => {
      const steps = this.db!.prepare(
        'SELECT step_name, step_type, input_config, prompt_template FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
      ).all(candidate.id, candidate.type) as any[];

      const score = this.scoreAssetRelevance(normalizedQuery, tokens, candidate, steps);
      const inputSpecs = this.collectInputSpecs(steps);

      const inputs: string[] = [];
      for (const [varName, spec] of inputSpecs.entries()) {
        inputs.push(this.formatInputDescriptor(varName, spec, { includeOptional: true }));
      }

      const stepSummary = steps.map((s: any) => `${s.step_name} (${s.step_type})`).join(' → ');
      let result = `[${candidate.type} #${candidate.id}] ${candidate.name}: ${candidate.description || 'No description'}\n  Steps: ${stepSummary || 'none'}`;
      if (inputs.length > 0) {
        result += `\n  Required inputs: ${inputs.join(', ')}`;
      }
      return { score, result };
    });

    const filtered = ranked
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Number(limit) || 5));

    if (filtered.length === 0) {
      return { success: true, output: 'No matching skills or workflows found.' };
    }

    return { success: true, output: filtered.map((r) => r.result).join('\n\n') };
  }

  private async executeSkill(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const { skillId, skillType, inputs = {}, imageInputs = {} } = args;
    const parentType: 'skill' | 'workflow' = skillType === 'workflow' ? 'workflow' : 'skill';
    const pinnedSelection = this.getPinnedTaskSelection(context.sessionId);

    // Verify the skill exists
    const table = parentType === 'skill' ? 'skills' : 'workflows';
    const skill = this.db!.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(skillId) as any;
    if (!skill) {
      return { success: false, output: `${parentType} #${skillId} not found` };
    }

    if (
      pinnedSelection &&
      pinnedSelection.type === 'workflow' &&
      (parentType !== 'workflow' || skillId !== pinnedSelection.id)
    ) {
      return {
        success: false,
        output: `Current task is locked to workflow #${pinnedSelection.id} (${pinnedSelection.name || 'selected workflow'}). Execute that workflow instead of ${parentType} #${skillId}.`,
      };
    }

    // Get steps
    const steps = this.db!.prepare(
      'SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
    ).all(skillId, parentType) as any[];

    if (steps.length === 0) {
      return { success: false, output: `${parentType} #${skillId} has no steps` };
    }

    const inputSpecs = this.collectInputSpecs(steps);
    const taskBoundaryId = this.getLatestTaskBoundaryId(context.sessionId);
    const recentFileUploads = this.getRecentFileUploads(context.sessionId);

    // Resolve image inputs from conversation attachments
    const resolvedInputs = { ...inputs };
    const attachments = context.attachments || [];
    const imageIndexByVar = new Map<string, number[]>();
    const explicitlyUsedIndexes = new Set<number>();
    for (const [varName, idx] of Object.entries(imageInputs)) {
      const mappedIndexes = this.parseAttachmentIndexes(idx, attachments.length);
      imageIndexByVar.set(varName, mappedIndexes);
      mappedIndexes.forEach((i) => explicitlyUsedIndexes.add(i));
      resolvedInputs[varName] = this.buildImageInputValueFromIndexes(mappedIndexes, attachments);
    }

    // If there's a single image variable and at least one uploaded image,
    // auto-map all images when the model omits/uses the wrong image input key.
    const imageVars = Array.from(inputSpecs.entries())
      .filter(([, spec]) => spec.type === 'image')
      .map(([name]) => name);
    if (imageVars.length === 1 && attachments.length > 0 && !resolvedInputs[imageVars[0]]) {
      const allIndexes = Array.from({ length: attachments.length }, (_, i) => i);
      imageIndexByVar.set(imageVars[0], allIndexes);
      allIndexes.forEach((i) => explicitlyUsedIndexes.add(i));
      resolvedInputs[imageVars[0]] = this.buildImageInputValueFromIndexes(allIndexes, attachments);
    }

    // If user intent clearly indicates combining multiple uploaded images into one output,
    // merge any unmapped images into the non-reference image input.
    if (this.userWantsImageCombination(context.sessionId) && attachments.length > 0) {
      const remainingIndexes = Array.from({ length: attachments.length }, (_, i) => i)
        .filter((idx) => !explicitlyUsedIndexes.has(idx));
      if (remainingIndexes.length > 0) {
        const mergeVar = this.pickCombinationTargetImageVar(inputSpecs, imageIndexByVar);
        if (mergeVar) {
          const existing = imageIndexByVar.get(mergeVar) || [];
          const merged = [...existing, ...remainingIndexes];
          imageIndexByVar.set(mergeVar, merged);
          remainingIndexes.forEach((i) => explicitlyUsedIndexes.add(i));
          resolvedInputs[mergeVar] = this.buildImageInputValueFromIndexes(merged, attachments);
        }
      }
    }

    // Fill missing text inputs from the latest user utterance (natural language),
    // so users can invoke skills conversationally without key:value syntax.
    this.applyNaturalLanguageInputAutofill(context.sessionId, inputSpecs, resolvedInputs);

    // Reuse inputs from latest successful execution of the same asset in this task segment.
    // This enables continuation requests like "same for this one" without re-uploading all prior inputs.
    this.applyExecutionMemoryFallback(
      context.sessionId,
      parentType,
      skillId,
      taskBoundaryId,
      resolvedInputs,
      inputSpecs
    );
    const resolvedImageAttachmentCount = this.countResolvedImageValues(resolvedInputs, inputSpecs);

    // Auto-map uploaded files to declared file variables.
    for (const [name, spec] of inputSpecs.entries()) {
      if (spec.type !== 'file') continue;
      if (!this.isInputValueMissing(resolvedInputs[name], spec.type)) continue;
      const fileValue = this.buildFileInputValueFromUploads(name, recentFileUploads);
      if (fileValue != null) {
        resolvedInputs[name] = fileValue;
      }
    }

    // Keep file inputs from blocking execution when file content is attached or implied.
    for (const [name, spec] of inputSpecs.entries()) {
      if (spec.type === 'file' && this.isInputValueMissing(resolvedInputs[name], spec.type)) {
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
        return this.isInputValueMissing(resolvedInputs[name], spec.type);
      });

    if (missingRequired.length > 0) {
      const first = missingRequired[0];
      const firstInput = this.formatInputDescriptor(first.name, first.spec, { includeOptional: false });
      const remainingList = missingRequired
        .slice(1)
        .map(({ name, spec }) => this.formatInputDescriptor(name, spec, { includeOptional: false }))
        .join(', ');
      const optionalList = Array.from(inputSpecs.entries())
        .filter(([, spec]) => spec.optional)
        .map(([name, spec]) => this.formatInputDescriptor(name, spec, { includeOptional: false }))
        .join(', ');
      return {
        success: false,
        output: `Missing required inputs for ${parentType} "${skill.name}". Ask the user for this one first: ${firstInput}.${remainingList ? ` Remaining required inputs (ask later, one-by-one): ${remainingList}.` : ''}${optionalList ? ` Optional inputs: ${optionalList}.` : ''}`,
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
    this.setSessionActiveExecution(context.sessionId, executionId);
    const settled = await this.waitForExecutionToSettle(executionId, context.userId, 120000);
    this.storeExecutionMemorySnapshot({
      sessionId: context.sessionId,
      taskBoundaryId,
      assetType: parentType,
      assetId: skillId,
      assetName: skill.name,
      executionId,
      executionStatus: settled.status,
      inputs: resolvedInputs,
      stepExecutions: settled.stepExecutions,
    });
    if (['completed', 'failed', 'cancelled'].includes(settled.status)) {
      this.setSessionActiveExecution(context.sessionId, null);
    }
    const imageCount = resolvedImageAttachmentCount;
    const inputSummary = Object.keys(resolvedInputs).length > 0
      ? `\nInputs: ${Object.entries(resolvedInputs).map(([k, v]) => {
          if (Array.isArray(v)) return `${k}=[${v.length} value(s)]`;
          if (typeof v === 'string' && v.length > 60) return `${k}=${v.substring(0, 60)}...`;
          return `${k}=${String(v)}`;
        }).join(', ')}`
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

    const expectsCsvArtifact = this.isCsvArtifactRequired(skill, steps, resolvedInputs);
    const csvFromArtifacts = this.findCsvArtifactInStepOutputs(settled.stepExecutions);

    const latestContent = this.extractLatestContent(settled.stepExecutions);
    if (!latestContent) {
      const imageUrls = this.extractAndSaveGeneratedImages(
        settled.stepExecutions, executionId, context.sessionId
      );
      if (expectsCsvArtifact) {
        if (csvFromArtifacts) {
          return {
            success: true,
            output: `Execution #${executionId} for ${parentType} "${skill.name}" completed.\nCSV file: ${csvFromArtifacts.path}`,
            metadata: { executionId, status: settled.status, csvPath: csvFromArtifacts.path },
          };
        }
        return {
          success: false,
          output: `Execution #${executionId} for ${parentType} "${skill.name}" completed but no CSV artifact was produced. Expected a CSV output file.`,
          metadata: { executionId, status: settled.status },
        };
      }
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
    if (expectsCsvArtifact) {
      if (csvFromArtifacts) {
        return {
          success: true,
          output: `Execution #${executionId} for ${parentType} "${skill.name}" completed.\nCSV file: ${csvFromArtifacts.path}`,
          metadata: { executionId, status: settled.status, csvPath: csvFromArtifacts.path },
        };
      }
      return {
        success: false,
        output: `Execution #${executionId} for ${parentType} "${skill.name}" completed but no CSV artifact was produced. Expected a CSV output file.`,
        metadata: { executionId, status: settled.status },
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
      const mappedIndexes = this.parseAttachmentIndexes(idx, attachments.length);
      const values = mappedIndexes.map((attachIdx) => (
        attachments[attachIdx]
          ? `[image: user attachment #${attachIdx + 1}]`
          : `[image: missing attachment #${attachIdx + 1}]`
      ));
      resolvedInputs[varName] = values.length <= 1 ? (values[0] || '[image: missing attachment #1]') : values;
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
      .map(([name, spec]) => this.formatInputDescriptor(name, spec, { includeOptional: false }));
    const optionalInputs = Array.from(inputSpecs.entries())
      .filter(([, spec]) => spec.optional)
      .map(([name, spec]) => this.formatInputDescriptor(name, spec, { includeOptional: false }));

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

      // Fallback for script steps that read user inputs directly from input_data.get(...)
      // but forgot to declare input_config variables.
      for (const varName of this.extractScriptInputVars(step)) {
        if (specs.has(varName)) continue;
        specs.set(varName, {
          type: this.inferInputTypeFromVarName(varName),
          optional: false,
        });
      }
    }
    return specs;
  }

  private extractScriptInputVars(step: any): string[] {
    if (String(step?.step_type || '').toLowerCase() !== 'script') return [];
    let script = '';
    try {
      const execCfg = JSON.parse(step?.executor_config || '{}');
      script = String(execCfg?.script || '');
    } catch {
      script = '';
    }
    if (!script) return [];

    const vars = new Set<string>();
    const getRegex = /input_data\.get\(\s*['"]([^'"]+)['"]/g;
    const indexRegex = /input_data\[\s*['"]([^'"]+)['"]\s*\]/g;
    let m: RegExpExecArray | null;

    while ((m = getRegex.exec(script)) !== null) {
      const name = String(m[1] || '').trim();
      if (!name || name.startsWith('step_')) continue;
      vars.add(name);
    }
    while ((m = indexRegex.exec(script)) !== null) {
      const name = String(m[1] || '').trim();
      if (!name || name.startsWith('step_')) continue;
      vars.add(name);
    }

    return Array.from(vars);
  }

  private inferInputTypeFromVarName(varName: string): string {
    const key = String(varName || '').toLowerCase();
    if (/image|img|photo|picture|reference|sample/.test(key)) return 'image';
    if (/file|files|csv|document|attachment/.test(key)) return 'file';
    return 'text';
  }

  private parseAttachmentIndexes(value: any, attachmentCount: number): number[] {
    const allIndexes = Array.from({ length: Math.max(0, attachmentCount) }, (_, i) => i);
    const dedup = new Set<number>();
    const out: number[] = [];
    const add = (n: number) => {
      if (!Number.isFinite(n)) return;
      const idx = Math.trunc(n);
      if (idx < 0) return;
      if (!dedup.has(idx)) {
        dedup.add(idx);
        out.push(idx);
      }
    };

    if (typeof value === 'number') {
      add(value);
      return out;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'number') add(item);
        else if (typeof item === 'string') {
          const parsed = Number.parseInt(item.trim(), 10);
          if (!Number.isNaN(parsed)) add(parsed);
        }
      }
      return out;
    }

    if (typeof value === 'string') {
      const raw = value.trim();
      if (!raw) return out;
      if (raw === '*' || raw.toLowerCase() === 'all') return allIndexes;

      if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}'))) {
        try {
          const parsed = JSON.parse(raw);
          return this.parseAttachmentIndexes(parsed, attachmentCount);
        } catch {
          // fall through to delimiter parsing
        }
      }

      for (const token of raw.split(/[,\s|]+/)) {
        if (!token) continue;
        const parsed = Number.parseInt(token, 10);
        if (!Number.isNaN(parsed)) add(parsed);
      }
      return out;
    }

    if (value && typeof value === 'object') {
      const obj = value as Record<string, any>;
      if (obj.all === true) return allIndexes;
      if (Array.isArray(obj.indexes)) return this.parseAttachmentIndexes(obj.indexes, attachmentCount);
      if (obj.index != null) return this.parseAttachmentIndexes(obj.index, attachmentCount);
    }

    return out;
  }

  private buildImageInputValueFromIndexes(
    indexes: number[],
    attachments: Array<{ data: string; mimeType?: string }>
  ): string | string[] {
    if (!indexes || indexes.length === 0) return '[image:missing_attachment_0]';
    const values = indexes.map((attachIdx) => {
      const attachment = attachments[attachIdx];
      if (!attachment) return `[image:missing_attachment_${attachIdx}]`;
      return this.toPromptImageValue(attachment);
    });
    return values.length === 1 ? values[0] : values;
  }

  private countResolvedImageValues(
    resolvedInputs: Record<string, any>,
    inputSpecs: Map<string, { type: string; optional: boolean; label?: string }>
  ): number {
    let count = 0;
    for (const [varName, spec] of inputSpecs.entries()) {
      if (spec.type !== 'image') continue;
      const value = resolvedInputs[varName];
      if (typeof value === 'string') {
        if (!value.startsWith('[image:missing_attachment_')) count += 1;
        continue;
      }
      if (Array.isArray(value)) {
        count += value.filter(
          (v) => typeof v === 'string' && !v.startsWith('[image:missing_attachment_')
        ).length;
      }
    }
    return count;
  }

  private isInputValueMissing(value: any, type: string): boolean {
    if (value == null) return true;
    if (type === 'image') {
      if (Array.isArray(value)) {
        if (value.length === 0) return true;
        const hasValidImage = value.some(
          (item) => typeof item === 'string' && !item.includes('[image:missing_attachment_')
        );
        return !hasValidImage;
      }
      if (typeof value === 'string') return value.includes('[image:missing_attachment_') || value.trim().length === 0;
      return true;
    }
    if (typeof value === 'string') return value.trim().length === 0;
    if (Array.isArray(value)) return value.length === 0;
    return false;
  }

  private setSessionActiveExecution(sessionId: string, executionId: number | null): void {
    try {
      this.db!.prepare(
        'UPDATE sessions SET active_execution_id = ?, last_active_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(executionId, sessionId);
    } catch {
      // Best-effort context hint; ignore if sessions table is unavailable.
    }
  }

  private getLatestTaskBoundaryId(sessionId: string, scanLimit: number = 500): number | null {
    const rows = this.db!.prepare(
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
        if (metadata?.taskBoundary === true) return Number(row.id);
      } catch {
        continue;
      }
    }
    return null;
  }

  private applyExecutionMemoryFallback(
    sessionId: string,
    assetType: 'skill' | 'workflow',
    assetId: number,
    taskBoundaryId: number | null,
    resolvedInputs: Record<string, any>,
    inputSpecs: Map<string, { type: string; optional: boolean; label?: string }>
  ): void {
    const memory = this.getLatestExecutionMemory(sessionId, assetType, assetId, taskBoundaryId);
    if (!memory) return;
    const cachedInputs = memory.inputs;
    if (!cachedInputs || typeof cachedInputs !== 'object') return;

    for (const [name, spec] of inputSpecs.entries()) {
      const currentValue = resolvedInputs[name];
      if (!this.isInputValueMissing(currentValue, spec.type)) continue;
      const cachedValue = (cachedInputs as Record<string, any>)[name];
      if (this.isInputValueMissing(cachedValue, spec.type)) continue;
      resolvedInputs[name] = cachedValue;
    }
  }

  private getLatestExecutionMemory(
    sessionId: string,
    assetType: 'skill' | 'workflow',
    assetId: number,
    taskBoundaryId: number | null
  ): { inputs: Record<string, any>; stepOutputs: any[] } | null {
    let rows: Array<{ task_boundary_id: number | null; inputs_json: string; step_outputs_json: string; execution_status?: string | null }>;
    try {
      rows = this.db!.prepare(
        `SELECT task_boundary_id, inputs_json, step_outputs_json, execution_status
         FROM session_execution_memory
         WHERE session_id = ? AND asset_type = ? AND asset_id = ?
         ORDER BY id DESC
         LIMIT 40`
      ).all(sessionId, assetType, assetId) as Array<{ task_boundary_id: number | null; inputs_json: string; step_outputs_json: string; execution_status?: string | null }>;
    } catch {
      return null;
    }

    if (rows.length === 0) return null;
    const scoped = rows.filter((r) => {
      if (taskBoundaryId == null) return r.task_boundary_id == null;
      return Number(r.task_boundary_id) === Number(taskBoundaryId);
    });
    const candidates = scoped.length > 0 ? scoped : rows;
    const preferred = candidates.find((r) => String(r.execution_status || '').toLowerCase() === 'completed') || candidates[0];
    if (!preferred) return null;

    try {
      const inputs = JSON.parse(preferred.inputs_json || '{}');
      const stepOutputs = JSON.parse(preferred.step_outputs_json || '[]');
      return {
        inputs: inputs && typeof inputs === 'object' ? inputs : {},
        stepOutputs: Array.isArray(stepOutputs) ? stepOutputs : [],
      };
    } catch {
      return null;
    }
  }

  private storeExecutionMemorySnapshot(opts: {
    sessionId: string;
    taskBoundaryId: number | null;
    assetType: 'skill' | 'workflow';
    assetId: number;
    assetName?: string;
    executionId: number;
    executionStatus: string;
    inputs: Record<string, any>;
    stepExecutions: any[];
  }): void {
    const { sessionId, taskBoundaryId, assetType, assetId, assetName, executionId, executionStatus, inputs, stepExecutions } = opts;
    try {
      const stepOutputs = (stepExecutions || []).map((step: any) => ({
        stepOrder: Number(step?.step_order || 0),
        status: String(step?.status || ''),
        content: this.extractStepOutputContent(step?.output_data),
      }));
      const latestSummary = this.extractLatestContent(stepExecutions);

      this.db!.prepare(
        `INSERT INTO session_execution_memory (
           session_id, task_boundary_id, asset_type, asset_id, asset_name,
           execution_id, execution_status, inputs_json, step_outputs_json, latest_output_summary
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        taskBoundaryId,
        assetType,
        assetId,
        assetName || null,
        executionId,
        executionStatus || null,
        JSON.stringify(inputs || {}),
        JSON.stringify(stepOutputs),
        latestSummary || null
      );

      // Keep only a bounded number of memory snapshots per session/asset to control DB size.
      this.db!.prepare(
        `DELETE FROM session_execution_memory
         WHERE id IN (
           SELECT id
           FROM session_execution_memory
           WHERE session_id = ? AND asset_type = ? AND asset_id = ?
           ORDER BY id DESC
           LIMIT -1 OFFSET 20
         )`
      ).run(sessionId, assetType, assetId);
    } catch (error) {
      console.warn('[tool-skill-manager] Failed to persist execution memory snapshot:', error);
    }
  }

  private extractStepOutputContent(rawOutputData: string | null | undefined): string {
    if (!rawOutputData) return '';
    try {
      const parsed = JSON.parse(rawOutputData);
      let content = '';
      if (typeof parsed?.content === 'string') content = parsed.content;
      else if (parsed?.content != null) content = JSON.stringify(parsed.content);
      else content = JSON.stringify(parsed);
      return content.length > 8000 ? `${content.slice(0, 8000)}...` : content;
    } catch {
      const text = String(rawOutputData);
      return text.length > 8000 ? `${text.slice(0, 8000)}...` : text;
    }
  }

  private getLatestUserMessageText(sessionId: string): string {
    const row = this.db!.prepare(
      `SELECT content
       FROM session_messages
       WHERE session_id = ? AND role = 'user'
       ORDER BY id DESC
       LIMIT 1`
    ).get(sessionId) as { content?: string } | undefined;
    return String(row?.content || '');
  }

  private applyNaturalLanguageInputAutofill(
    sessionId: string,
    inputSpecs: Map<string, { type: string; optional: boolean; label?: string }>,
    resolvedInputs: Record<string, any>
  ): void {
    const latestUserText = this.getLatestUserMessageText(sessionId);
    if (!latestUserText.trim()) return;

    const inferred = inferInputsFromNaturalLanguage({
      message: latestUserText,
      inputSpecs: new Map(inputSpecs),
      existingInputs: resolvedInputs,
    });

    for (const [name, value] of Object.entries(inferred)) {
      resolvedInputs[name] = value;
    }
  }

  private userWantsImageCombination(sessionId: string): boolean {
    const text = this.getLatestUserMessageText(sessionId).toLowerCase();
    if (!text) return false;
    return /(combine|together|single image|one image|merge|both|all uploaded)/i.test(text)
      || /(同一张|一起|合成|融合|两张|多张)/.test(text);
  }

  private pickCombinationTargetImageVar(
    inputSpecs: Map<string, { type: string; optional: boolean; label?: string }>,
    imageIndexByVar: Map<string, number[]>
  ): string | null {
    const imageVars = Array.from(inputSpecs.entries())
      .filter(([, spec]) => spec.type === 'image')
      .map(([name]) => name);
    if (imageVars.length === 0) return null;

    const nonReferenceVars = imageVars.filter(
      (name) => !/(reference|style|样本|参考)/i.test(name)
    );
    const candidates = nonReferenceVars.length > 0 ? nonReferenceVars : imageVars;

    const mappedCandidate = candidates.find((name) => (imageIndexByVar.get(name) || []).length > 0);
    return mappedCandidate || candidates[0] || null;
  }

  private getPinnedTaskSelection(
    sessionId: string,
    scanLimit: number = 500
  ): { type: 'workflow'; id: number; name?: string } | null {
    const rows = this.db!.prepare(
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
        const selection = metadata?.taskSelection;
        if (
          selection?.type === 'workflow' &&
          Number.isFinite(Number(selection.id))
        ) {
          return {
            type: 'workflow',
            id: Number(selection.id),
            name: selection.name ? String(selection.name) : undefined,
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private getRecentFileUploads(
    sessionId: string,
    limit: number = 120
  ): Array<{ url: string; name?: string; mimeType?: string }> {
    const rows = this.db!.prepare(
      `SELECT id, metadata
       FROM session_messages
       WHERE session_id = ? AND role = 'user'
       ORDER BY id DESC
       LIMIT ?`
    ).all(sessionId, limit) as Array<{ id: number; metadata: string | null }>;

    let seenFile = false;
    const batchInReverse: Array<Array<{ url: string; name?: string; mimeType?: string }>> = [];
    for (const row of rows) {
      const files = this.extractFileAttachmentRefs(row.metadata);
      if (files.length > 0) {
        seenFile = true;
        batchInReverse.push(files);
        continue;
      }
      if (seenFile) break;
    }

    if (!seenFile) return [];
    const ordered: Array<{ url: string; name?: string; mimeType?: string }> = [];
    for (let i = batchInReverse.length - 1; i >= 0; i -= 1) {
      ordered.push(...batchInReverse[i]);
    }
    return ordered;
  }

  private extractFileAttachmentRefs(metadataRaw: string | null): Array<{ url: string; name?: string; mimeType?: string }> {
    if (!metadataRaw) return [];
    try {
      const metadata = JSON.parse(metadataRaw);
      const attachments = Array.isArray(metadata?.attachments) ? metadata.attachments : [];
      return attachments
        .filter((a: any) => a && a.type === 'file' && typeof a.url === 'string' && a.url.length > 0)
        .map((a: any) => ({
          url: String(a.url),
          name: a.name ? String(a.name) : undefined,
          mimeType: a.mimeType ? String(a.mimeType) : undefined,
        }));
    } catch {
      return [];
    }
  }

  private buildFileInputValueFromUploads(
    varName: string,
    uploads: Array<{ url: string; name?: string; mimeType?: string }>
  ): Array<{ name: string; content: string }> | { name: string; content: string } | null {
    if (!uploads.length) return null;

    const normalized = uploads.map((item, idx) => {
      const name = item.name || `${varName}_${idx + 1}.txt`;
      const content = this.readUploadedFileContent(item.url, item.mimeType);
      if (content == null) return null;
      return { name, content };
    }).filter(Boolean) as Array<{ name: string; content: string }>;

    if (normalized.length === 0) return null;
    if (/_files$/i.test(varName) || normalized.length > 1) return normalized;
    return normalized[0];
  }

  private readUploadedFileContent(url: string, mimeType?: string): string | null {
    const fullPath = this.resolveUploadUrlToAbsolutePath(url);
    if (!fullPath) return null;

    try {
      const raw = fs.readFileSync(fullPath);
      if (!raw || raw.length === 0) return '';

      const ext = path.extname(fullPath).toLowerCase();
      const mt = String(mimeType || '').toLowerCase();
      const textLike = mt.startsWith('text/')
        || mt.includes('json')
        || mt.includes('csv')
        || mt.includes('xml')
        || mt.includes('yaml')
        || new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.xml', '.yaml', '.yml', '.log']).has(ext);

      if (textLike) {
        return raw.toString('utf8');
      }

      // Fallback for binary files.
      return raw.toString('base64');
    } catch {
      return null;
    }
  }

  private resolveUploadUrlToAbsolutePath(url: string): string | null {
    const raw = String(url || '').trim();
    if (!raw.startsWith('/uploads/')) return null;
    const rel = raw.replace(/^\/uploads\//, '');
    const uploadsRoot = path.resolve(getUploadsDir());
    const fullPath = path.resolve(path.join(uploadsRoot, rel));
    if (!(fullPath === uploadsRoot || fullPath.startsWith(`${uploadsRoot}${path.sep}`))) return null;
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) return null;
    return fullPath;
  }

  private toPromptImageValue(attachment: { data: string; mimeType?: string }): string {
    const data = String(attachment?.data || '');
    if (!data) return '[image:missing_attachment_data]';
    if (data.startsWith('data:image/')) return data;
    const mime = attachment?.mimeType || 'image/jpeg';
    return `data:${mime};base64,${data}`;
  }

  private formatInputDescriptor(
    varName: string,
    spec: { type: string; optional: boolean; label?: string },
    options: { includeOptional: boolean }
  ): string {
    const label = (spec.label || this.humanizeInputName(varName)).trim();
    const type = spec.type || 'text';
    const optionalPart = options.includeOptional && spec.optional ? ', optional' : '';
    return `${label} (${type}${optionalPart})`;
  }

  private humanizeInputName(varName: string): string {
    const normalized = String(varName || 'input')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return 'Input';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  private tokenizeQuery(query: string): string[] {
    const normalized = String(query || '').toLowerCase().trim();
    if (!normalized) return [];

    const tokens = new Set<string>();
    const ascii = normalized.split(/[^a-z0-9_]+/).filter((t) => t.length >= 2);
    ascii.forEach((t) => tokens.add(t));

    const cjkChunks = normalized.match(/[\u3400-\u9fff]+/g) || [];
    for (const chunk of cjkChunks) {
      if (chunk.length >= 2) {
        tokens.add(chunk);
      }
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

  private scoreAssetRelevance(query: string, tokens: string[], candidate: any, steps: any[]): number {
    const name = String(candidate?.name || '').toLowerCase();
    const desc = String(candidate?.description || '').toLowerCase();
    const tags = this.parseTags(candidate?.tags);
    const tagsText = tags.join(' ').toLowerCase();
    const stepText = steps
      .map((s: any) => `${s.step_name || ''} ${s.step_type || ''} ${s.prompt_template || ''}`)
      .join(' ')
      .toLowerCase();
    const blob = `${name} ${desc} ${tagsText} ${stepText}`;

    let score = 0;
    if (name && query && name.includes(query)) score += 80;
    if (desc && query && desc.includes(query)) score += 30;
    if (tagsText && query && tagsText.includes(query)) score += 35;

    for (const token of tokens) {
      if (name.includes(token)) score += 18;
      if (desc.includes(token)) score += 10;
      if (tagsText.includes(token)) score += 14;
      if (stepText.includes(token)) score += 8;
    }

    const expectsCsv = /\bcsv\b|comma[-\s]?separated|spreadsheet|表格|导出|输出文件|趋势候选池/.test(query);
    if (expectsCsv) {
      if (/\bcsv\b|comma[-\s]?separated|\.csv|导出|表格/.test(blob)) {
        score += 14;
      } else {
        score -= 6;
      }
    }

    const hasWorkflowHint = /\bworkflow\b|pipeline|multi[-\s]?step|流程|链路|阶段/.test(query);
    if (hasWorkflowHint && candidate.type === 'workflow') score += 8;

    // Penalize unrelated matches caused by generic words.
    if (score < 18) return 0;
    return score;
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

  private isCsvArtifactRequired(skill: any, steps: any[], inputs: Record<string, any>): boolean {
    const signalText = [
      skill?.name || '',
      skill?.description || '',
      ...steps.map((s: any) => `${s.step_name || ''} ${s.prompt_template || ''} ${s.executor_config || ''}`),
      ...Object.entries(inputs).map(([k, v]) => `${k}:${String(v)}`),
    ].join(' ').toLowerCase();

    return /\bcsv\b|comma[-\s]?separated|\.csv|导出csv|输出csv|生成csv|表格/.test(signalText);
  }

  private findCsvArtifactInStepOutputs(stepExecutions: any[]): { path: string } | null {
    for (const step of stepExecutions) {
      if (!step?.output_data) continue;
      try {
        const parsed = JSON.parse(step.output_data);
        const files = parsed?.files || parsed?.manusFiles || parsed?.output?.files;
        if (Array.isArray(files)) {
          const csv = files.find((f: any) => {
            const name = String(f?.name || '').toLowerCase();
            const url = String(f?.url || '').toLowerCase();
            return name.endsWith('.csv') || url.endsWith('.csv');
          });
          if (csv) {
            return { path: csv.url || csv.name };
          }
        }
      } catch {
        // Ignore malformed output_data.
      }
    }
    return null;
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
    const desiredOrders = new Set(steps.map((s) => Number(s.step_order)));

    for (const existing of existingSteps) {
      if (!desiredOrders.has(Number(existing.step_order))) {
        this.db!.prepare('DELETE FROM recipe_steps WHERE id = ?').run(existing.id);
      }
    }

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
    let csv: string | null = null;
    try {
      parsed = JSON.parse(content);
      const rows = this.extractRowsForCsv(parsed);
      if (rows.length > 0) {
        const headerSet = new Set<string>();
        for (const row of rows) {
          Object.keys(row).forEach((k) => headerSet.add(k));
        }
        const headers = Array.from(headerSet);

        csv = [
          headers.join(','),
          ...rows.map((row) => headers.map((h) => this.escapeCsvValue(row[h])).join(',')),
        ].join('\n');
      }
    } catch {
      // Fallback: support direct CSV text content.
      if (this.looksLikeCsv(content)) {
        csv = content.trim();
      }
    }

    if (!csv || !csv.trim()) return null;

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

  private looksLikeCsv(text: string): boolean {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) return false;

    const first = lines[0];
    if (!first.includes(',')) return false;
    const expectedCols = first.split(',').length;
    if (expectedCols < 2) return false;

    let consistentRows = 0;
    for (let i = 1; i < Math.min(lines.length, 8); i++) {
      if (lines[i].includes(',') && lines[i].split(',').length >= Math.max(2, expectedCols - 1)) {
        consistentRows += 1;
      }
    }
    return consistentRows >= 1;
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

import { Router, Request, Response } from 'express';
import { queries, getDatabase } from '../models/database';
import { authMiddleware } from '../middleware/auth';
import {
  startExecution,
  approveStep,
  rejectStep,
  retryStep,
  getExecutionStatus,
} from '../services/workflowEngine';
import {
  WorkflowExecution,
  StepExecution,
  Recipe,
  RecipeStep,
} from '../types';

const router = Router();

type ParentType = 'skill' | 'workflow';

interface GraphParent {
  id: number;
  name: string;
  description?: string | null;
  created_by?: number | null;
}

interface SkillStepRow {
  id: number;
  parent_id: number;
  parent_type: ParentType;
  step_order: number;
  step_name: string;
  step_type?: string | null;
  ai_model?: string | null;
  prompt_template?: string | null;
  input_config?: string | null;
  output_format?: string | null;
  model_config?: string | null;
  executor_config?: string | null;
}

function loadGraphParent(parentType: ParentType, parentId: number): {
  parent: GraphParent | null;
  steps: SkillStepRow[];
} {
  const db = getDatabase();
  const table = parentType === 'skill' ? 'skills' : 'workflows';
  const parent = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(parentId) as GraphParent | undefined;
  if (!parent) return { parent: null, steps: [] };
  const steps = db.prepare(
    'SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = ? ORDER BY step_order'
  ).all(parentId, parentType) as SkillStepRow[];
  return { parent, steps };
}

function ensureExecutionRecipeFromGraph(
  parentType: ParentType,
  parent: GraphParent,
  steps: SkillStepRow[]
): { recipeId: number; syncedSteps: RecipeStep[] } {
  const db = getDatabase();
  const bridgeMarker = `[BRIDGE:${parentType}:${parent.id}]`;
  const existingRecipe = db.prepare('SELECT id FROM recipes WHERE description = ?').get(bridgeMarker) as { id: number } | undefined;
  let recipeId: number;

  if (existingRecipe) {
    recipeId = existingRecipe.id;
    db.prepare(
      'UPDATE recipes SET name = ?, description = ?, is_template = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(
      parent.name,
      bridgeMarker,
      parentType === 'skill' ? 1 : 0,
      recipeId
    );
  } else {
    const created = db.prepare(
      'INSERT INTO recipes (name, description, created_by, is_template) VALUES (?, ?, ?, ?)'
    ).run(
      parent.name,
      bridgeMarker,
      parent.created_by || null,
      parentType === 'skill' ? 1 : 0
    );
    recipeId = Number(created.lastInsertRowid);
  }

  const existingSteps = db.prepare(
    'SELECT id, step_order FROM recipe_steps WHERE recipe_id = ? ORDER BY step_order'
  ).all(recipeId) as Array<{ id: number; step_order: number }>;
  const existingStepIdByOrder = new Map(existingSteps.map((row) => [row.step_order, row.id]));
  const expectedOrders = new Set<number>();
  const syncedSteps: RecipeStep[] = [];

  for (const step of steps) {
    expectedOrders.add(step.step_order);
    const stepName = step.step_name || `Step ${step.step_order}`;
    const stepType = step.step_type || 'ai';
    const outputFormat = (step.output_format as RecipeStep['output_format']) || 'text';
    const promptTemplate = step.prompt_template || '';
    const inputConfig = step.input_config || '{}';
    const modelConfig = step.model_config || '{}';
    const executorConfig = step.executor_config || '{}';
    const aiModel = step.ai_model || null;

    const existingStepId = existingStepIdByOrder.get(step.step_order);
    let recipeStepId: number;
    if (existingStepId) {
      db.prepare(`
        UPDATE recipe_steps
        SET step_name = ?, step_type = ?, ai_model = ?, prompt_template = ?, input_config = ?, output_format = ?, model_config = ?, executor_config = ?
        WHERE id = ?
      `).run(
        stepName,
        stepType,
        aiModel,
        promptTemplate,
        inputConfig,
        outputFormat,
        modelConfig,
        executorConfig,
        existingStepId
      );
      recipeStepId = existingStepId;
    } else {
      const inserted = db.prepare(`
        INSERT INTO recipe_steps (recipe_id, step_order, step_name, step_type, ai_model, prompt_template, input_config, output_format, model_config, api_config, executor_config)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        recipeId,
        step.step_order,
        stepName,
        stepType,
        aiModel,
        promptTemplate,
        inputConfig,
        outputFormat,
        modelConfig,
        null,
        executorConfig
      );
      recipeStepId = Number(inserted.lastInsertRowid);
    }

    syncedSteps.push({
      id: recipeStepId,
      recipe_id: recipeId,
      step_order: step.step_order,
      step_name: stepName,
      step_type: stepType,
      ai_model: aiModel || '',
      prompt_template: promptTemplate,
      input_config: inputConfig,
      output_format: outputFormat,
      model_config: modelConfig,
      executor_config: executorConfig,
      created_at: new Date().toISOString(),
    });
  }

  for (const oldStep of existingSteps) {
    if (!expectedOrders.has(oldStep.step_order)) {
      db.prepare('DELETE FROM recipe_steps WHERE id = ?').run(oldStep.id);
    }
  }

  return { recipeId, syncedSteps };
}

// Apply auth middleware to all routes
router.use(authMiddleware);

// GET /api/executions - List executions
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const executions = queries.getExecutionsByUser(userId) as WorkflowExecution[];

    // Enrich with recipe names
    const enrichedExecutions = executions.map(exec => {
      const recipe = queries.getRecipeById(exec.recipe_id) as Recipe | undefined;
      return {
        ...exec,
        recipe_name: recipe?.name || 'Unknown Recipe',
      };
    });

    res.json(enrichedExecutions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/executions/:id - Get execution status
router.get('/:id', (req: Request, res: Response) => {
  try {
    const executionId = parseInt(req.params.id, 10);
    const execution = queries.getExecutionById(executionId) as WorkflowExecution | undefined;

    if (!execution) {
      res.status(404).json({ error: 'Execution not found' });
      return;
    }

    const recipe = queries.getRecipeById(execution.recipe_id) as Recipe;
    const stepExecutions = queries.getStepExecutionsByExecutionId(executionId) as StepExecution[];

    // Parse input data and check for custom steps
    let inputData: Record<string, any> = {};
    let customSteps: RecipeStep[] | undefined;
    if (execution.input_data) {
      try {
        const data = JSON.parse(execution.input_data as string);
        if (data.__customSteps) {
          customSteps = data.__customSteps;
          delete data.__customSteps;
        }
        inputData = data;
      } catch {
        // Keep as empty object
      }
    }

    // Use custom steps if present, otherwise fetch from database
    const steps = customSteps || (queries.getStepsByRecipeId(execution.recipe_id) as RecipeStep[]);

    // Enrich step executions with step details
    const enrichedStepExecutions = stepExecutions.map(se => {
      // Match by step_id or step_order for custom steps
      const step = steps.find(s => s.id === se.step_id) ||
                   steps.find(s => s.step_order === se.step_order);
      let parsedOutput = null;

      if (se.output_data) {
        try {
          parsedOutput = JSON.parse(se.output_data);
        } catch {
          parsedOutput = { content: se.output_data };
        }
      }

      return {
        ...se,
        step_name: step?.step_name || 'Unknown Step',
        ai_model: step?.ai_model || se.ai_model_used,
        output: parsedOutput,
      };
    });

    res.json({
      ...execution,
      input_data: inputData,
      recipe,
      step_executions: enrichedStepExecutions,
      total_steps: steps.length,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/executions - Start new execution
// POST /api/executions/quick - Create a quick single-step execution (e.g. Manus shortcut)
router.post('/quick', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { step_type, prompt, input_data } = req.body;

    if (!prompt || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }

    const type = step_type || 'manus';

    // Create a temporary recipe for this execution
    const recipeResult = queries.createRecipe(
      `Quick ${type} task`,
      `Auto-created for quick ${type} execution`,
      userId,
      false
    );
    const recipeId = recipeResult.lastInsertRowid;

    // Create the single step
    const customSteps: RecipeStep[] = [{
      id: -1,
      recipe_id: recipeId,
      step_order: 1,
      step_name: `${type} task`,
      step_type: type,
      ai_model: type === 'ai' ? 'gpt-4o' : '',
      prompt_template: prompt.trim(),
      output_format: 'text',
      created_at: new Date().toISOString(),
    }];

    const result = await startExecution(recipeId, userId, input_data || {}, customSteps);

    if (!result.success && result.executionId === 0) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.status(201).json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/executions - Start execution from a recipe, skill, or workflow
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      recipe_id,
      workflow_id,
      skill_id,
      input_data,
      steps: customSteps,
    } = req.body;

    const idCount = [recipe_id, workflow_id, skill_id].filter((v) => v !== undefined && v !== null).length;
    if (idCount !== 1) {
      res.status(400).json({ error: 'Exactly one of recipe_id, workflow_id, or skill_id is required' });
      return;
    }

    let resolvedRecipeId = Number(recipe_id || 0);
    let resolvedCustomSteps = customSteps as RecipeStep[] | undefined;

    if (workflow_id || skill_id) {
      const parentType: ParentType = workflow_id ? 'workflow' : 'skill';
      const parentId = Number(workflow_id || skill_id);
      const { parent, steps } = loadGraphParent(parentType, parentId);
      if (!parent) {
        res.status(404).json({ error: `${parentType === 'workflow' ? 'Workflow' : 'Skill'} not found` });
        return;
      }
      if (steps.length === 0 && !resolvedCustomSteps) {
        res.status(400).json({ error: `${parentType === 'workflow' ? 'Workflow' : 'Skill'} has no steps` });
        return;
      }

      const bridged = ensureExecutionRecipeFromGraph(parentType, parent, steps);
      resolvedRecipeId = bridged.recipeId;
      if (!resolvedCustomSteps) {
        resolvedCustomSteps = bridged.syncedSteps;
      } else {
        const syncedByOrder = new Map(bridged.syncedSteps.map((step) => [step.step_order, step]));
        resolvedCustomSteps = (resolvedCustomSteps as RecipeStep[]).map((step, idx) => {
          const stepOrder = step.step_order || idx + 1;
          const base = syncedByOrder.get(stepOrder);
          return {
            ...(base || {}),
            ...step,
            id: base?.id,
            recipe_id: resolvedRecipeId,
            step_order: stepOrder,
          } as RecipeStep;
        });
      }
    } else {
      const recipe = queries.getRecipeById(resolvedRecipeId) as Recipe | undefined;
      if (!recipe) {
        res.status(404).json({ error: 'Recipe not found' });
        return;
      }
    }

    const result = await startExecution(resolvedRecipeId, userId, input_data || {}, resolvedCustomSteps);

    if (!result.success && result.executionId === 0) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.status(201).json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/executions/:id/steps/:stepId/approve - Approve step
router.post('/:id/steps/:stepId/approve', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const executionId = parseInt(req.params.id, 10);
    const stepExecutionId = parseInt(req.params.stepId, 10);

    const execution = queries.getExecutionById(executionId) as WorkflowExecution | undefined;
    if (!execution) {
      res.status(404).json({ error: 'Execution not found' });
      return;
    }

    const result = await approveStep(executionId, stepExecutionId, userId);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/executions/:id/steps/:stepId/reject - Reject step
router.post('/:id/steps/:stepId/reject', (req: Request, res: Response) => {
  try {
    const executionId = parseInt(req.params.id, 10);
    const stepExecutionId = parseInt(req.params.stepId, 10);

    const execution = queries.getExecutionById(executionId) as WorkflowExecution | undefined;
    if (!execution) {
      res.status(404).json({ error: 'Execution not found' });
      return;
    }

    const result = rejectStep(executionId, stepExecutionId);

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ success: true, message: 'Step rejected and queued for retry' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/executions/:id/steps/:stepId/retry - Retry step with modifications
router.post('/:id/steps/:stepId/retry', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const executionId = parseInt(req.params.id, 10);
    const stepExecutionId = parseInt(req.params.stepId, 10);
    const { modified_prompt, modified_input } = req.body;

    const execution = queries.getExecutionById(executionId) as WorkflowExecution | undefined;
    if (!execution) {
      res.status(404).json({ error: 'Execution not found' });
      return;
    }

    const result = await retryStep(
      executionId,
      stepExecutionId,
      userId,
      modified_prompt,
      modified_input
    );

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/executions/:id/status - Get quick status
router.get('/:id/status', (req: Request, res: Response) => {
  try {
    const executionId = parseInt(req.params.id, 10);
    const status = getExecutionStatus(executionId);

    if (!status) {
      res.status(404).json({ error: 'Execution not found' });
      return;
    }

    res.json(status);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/executions/:id/cancel - Cancel/kill a running execution
router.post('/:id/cancel', (req: Request, res: Response) => {
  try {
    const executionId = parseInt(req.params.id, 10);
    const userId = req.user!.id;

    const execution = queries.getExecutionById(executionId) as WorkflowExecution | undefined;
    if (!execution) {
      res.status(404).json({ error: 'Execution not found' });
      return;
    }

    // Check ownership
    if (execution.user_id !== userId) {
      res.status(403).json({ error: 'Not authorized to cancel this execution' });
      return;
    }

    // Only allow cancelling running or paused executions
    if (!['running', 'paused', 'pending'].includes(execution.status)) {
      res.status(400).json({ error: `Cannot cancel execution with status: ${execution.status}` });
      return;
    }

    queries.cancelExecution(executionId);

    res.json({ success: true, message: 'Execution cancelled' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/executions — Delete all executions for the current user
router.delete('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = queries.deleteAllExecutionsByUser(userId);
    res.json({ success: true, deleted: result.changes });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/executions/:id - Delete an execution
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const executionId = parseInt(req.params.id, 10);
    const userId = req.user!.id;

    const execution = queries.getExecutionById(executionId) as WorkflowExecution | undefined;
    if (!execution) {
      res.status(404).json({ error: 'Execution not found' });
      return;
    }

    // Check ownership
    if (execution.user_id !== userId) {
      res.status(403).json({ error: 'Not authorized to delete this execution' });
      return;
    }

    queries.deleteExecution(executionId);

    res.json({ success: true, message: 'Execution deleted' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

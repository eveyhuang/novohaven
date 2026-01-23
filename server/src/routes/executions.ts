import { Router, Request, Response } from 'express';
import { queries } from '../models/database';
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
  StartExecutionRequest,
} from '../types';

const router = Router();

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
router.post('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { recipe_id, input_data, steps: customSteps } = req.body;

    if (!recipe_id) {
      res.status(400).json({ error: 'recipe_id is required' });
      return;
    }

    const recipe = queries.getRecipeById(recipe_id) as Recipe | undefined;
    if (!recipe) {
      res.status(404).json({ error: 'Recipe not found' });
      return;
    }

    // Pass custom steps if provided (for template modifications)
    const result = await startExecution(recipe_id, userId, input_data || {}, customSteps);

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

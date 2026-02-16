import { queries } from '../models/database';
import { getExecutor } from '../executors/registry';
import { StepExecutorContext } from '../executors/StepExecutor';
import { executionEvents } from './executionEvents';
import {
  WorkflowExecution,
  StepExecution,
  RecipeStep,
  ExecutionStatus,
  StepExecutionStatus,
  StepType,
} from '../types';

// Step types that auto-run (no human approval needed)
const AUTO_RUN_STEP_TYPES: StepType[] = ['ai', 'script', 'http', 'transform'];

export interface ExecutionResult {
  success: boolean;
  executionId: number;
  status: ExecutionStatus;
  currentStep: number;
  stepResults: StepExecutionResult[];
  error?: string;
}

export interface StepExecutionResult {
  stepId: number;
  stepOrder: number;
  stepName: string;
  status: StepExecutionStatus;
  output?: string;
  error?: string;
}

// Start a new workflow execution
export async function startExecution(
  recipeId: number,
  userId: number,
  inputData: Record<string, any>,
  customSteps?: RecipeStep[]
): Promise<ExecutionResult> {
  // Get recipe steps - use custom steps if provided, otherwise fetch from database
  let steps: RecipeStep[];
  if (customSteps && customSteps.length > 0) {
    // Use custom steps (from template modifications)
    steps = customSteps.map((step, index) => ({
      ...step,
      id: step.id || -(index + 1), // Use negative IDs for custom steps
      step_order: index + 1,
    }));
  } else {
    steps = queries.getStepsByRecipeId(recipeId) as RecipeStep[];
  }

  if (steps.length === 0) {
    return {
      success: false,
      executionId: 0,
      status: 'failed',
      currentStep: 0,
      stepResults: [],
      error: 'Recipe has no steps',
    };
  }

  // Validate inputs against the actual steps being used
  const requiredInputs = extractRequiredInputsFromSteps(steps);
  const missingInputs = requiredInputs.filter(
    input => !inputData[input] || String(inputData[input]).trim() === ''
  );
  if (missingInputs.length > 0) {
    return {
      success: false,
      executionId: 0,
      status: 'failed',
      currentStep: 0,
      stepResults: [],
      error: `Missing required inputs: ${missingInputs.join(', ')}`,
    };
  }

  // Create execution record - store custom steps in the execution if provided
  const executionData = customSteps ? {
    ...inputData,
    __customSteps: customSteps
  } : inputData;

  const execResult = queries.createExecution(
    recipeId,
    userId,
    JSON.stringify(executionData)
  );
  const executionId = execResult.lastInsertRowid;

  // Create step execution records
  for (const step of steps) {
    queries.createStepExecution(
      executionId,
      step.id,
      step.step_order,
      JSON.stringify({})
    );
  }

  // Fire-and-forget: always run execution in background so frontend can navigate immediately
  executeWorkflowWithSteps(executionId, userId, inputData, steps).catch(err => {
    console.error(`[WorkflowEngine] Background execution ${executionId} error:`, err);
  });

  // Return immediately so frontend can navigate to chat page
  return {
    success: true,
    executionId,
    status: 'running',
    currentStep: 1,
    stepResults: steps.map(s => ({
      stepId: s.id,
      stepOrder: s.step_order,
      stepName: s.step_name,
      status: 'pending' as StepExecutionStatus,
    })),
  };
}

// Extract required inputs from steps
function extractRequiredInputsFromSteps(steps: RecipeStep[]): string[] {
  const inputs = new Set<string>();
  const variableRegex = /\{\{([^}]+)\}\}/g;

  const standardNames = [
    'brand_voice', 'amazon_requirements', 'social_media_guidelines',
    'image_style_guidelines', 'platform_requirements', 'tone_guidelines',
  ];

  for (const step of steps) {
    // Handle non-AI steps - get inputs from input_config
    if (step.step_type && step.step_type !== 'ai' && step.input_config) {
      try {
        const inputConfig = JSON.parse(step.input_config);
        if (inputConfig.variables) {
          // Handle both array format (server types) and object format (templates)
          if (Array.isArray(inputConfig.variables)) {
            // Array format: [{ name: 'product_urls', source: 'user_input', ... }]
            for (const variable of inputConfig.variables) {
              if (variable.source === 'user_input' && variable.required !== false) {
                inputs.add(variable.name);
              }
            }
          } else {
            // Object format: { product_urls: { type: 'url_list', ... } }
            for (const [varName, varConfig] of Object.entries(inputConfig.variables)) {
              const config = varConfig as any;
              // Skip optional variables
              if (config.optional !== true) {
                inputs.add(varName);
              }
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
      continue;
    }

    // Handle AI steps (and fallback) - get inputs from prompt_template
    let match;
    const template = step.prompt_template || '';
    while ((match = variableRegex.exec(template)) !== null) {
      const varName = match[1].trim();
      // Skip step outputs and company standards
      if (!varName.match(/^step_\d+_output$/) &&
          !standardNames.some(s => varName.toLowerCase().includes(s.replace(/_/g, '')))) {
        inputs.add(varName);
      }
    }
  }
  return Array.from(inputs);
}

// Execute the workflow with provided steps
async function executeWorkflowWithSteps(
  executionId: number,
  userId: number,
  userInputs: Record<string, any>,
  steps: RecipeStep[]
): Promise<ExecutionResult> {
  const execution = queries.getExecutionById(executionId) as WorkflowExecution;
  const stepExecutions = queries.getStepExecutionsByExecutionId(executionId) as StepExecution[];

  // Find the next step to execute
  let currentStepOrder = execution.current_step;
  const nextStepExecution = stepExecutions.find(
    se => se.step_order > currentStepOrder && se.status === 'pending'
  ) || stepExecutions.find(se => se.status === 'pending');

  if (!nextStepExecution) {
    // All steps completed
    queries.completeExecution('completed', executionId);

    // Emit execution-complete
    const completeMsg = executionEvents.createMessage({
      executionId,
      stepOrder: currentStepOrder,
      stepName: '',
      stepType: 'ai',
      type: 'execution-complete',
      role: 'system',
      content: 'All steps complete',
    });
    executionEvents.emit(executionId, completeMsg);
    executionEvents.cleanup(executionId);

    return {
      success: true,
      executionId,
      status: 'completed',
      currentStep: currentStepOrder,
      stepResults: stepExecutions.map(se => ({
        stepId: se.step_id,
        stepOrder: se.step_order,
        stepName: steps.find(s => s.id === se.step_id || s.step_order === se.step_order)?.step_name || 'Unknown',
        status: se.status,
        output: se.output_data ? JSON.parse(se.output_data).content : undefined,
        error: se.error_message || undefined,
      })),
    };
  }

  // Find the step definition - match by step_order for custom steps
  const step = steps.find(s => s.id === nextStepExecution.step_id) ||
               steps.find(s => s.step_order === nextStepExecution.step_order);

  if (!step) {
    queries.setStepExecutionError('failed', 'Step definition not found', nextStepExecution.id);
    queries.completeExecution('failed', executionId);
    return {
      success: false,
      executionId,
      status: 'failed',
      currentStep: currentStepOrder,
      stepResults: [],
      error: 'Step definition not found',
    };
  }

  const stepType = step.step_type || 'ai';

  // Emit step-start
  const startMsg = executionEvents.createMessage({
    executionId,
    stepOrder: step.step_order,
    stepName: step.step_name,
    stepType,
    type: 'step-start',
    role: 'system',
    content: `Starting step ${step.step_order}: ${step.step_name}`,
  });
  executionEvents.emit(executionId, startMsg);

  // Update step status to running
  queries.updateStepExecution(
    'running',
    null,
    null,
    null,
    nextStepExecution.id
  );
  queries.updateExecutionStatus('running', step.step_order, executionId);

  // Dispatch to the appropriate executor via the registry
  const executor = getExecutor(stepType) || getExecutor('ai')!;

  const executorContext: StepExecutorContext = {
    userId,
    executionId,
    stepExecution: nextStepExecution,
    userInputs,
    completedStepExecutions: stepExecutions.filter(se => se.status === 'completed'),
    emitter: executionEvents,
  };

  try {
    const result = await executor.execute(step, executorContext);

    if (!result.success) {
      queries.setStepExecutionError('failed', result.error || 'Step execution failed', nextStepExecution.id);
      queries.updateExecutionStatus('paused', step.step_order, executionId);

      // Emit step-error
      const errorMsg = executionEvents.createMessage({
        executionId,
        stepOrder: step.step_order,
        stepName: step.step_name,
        stepType,
        type: 'step-error',
        role: 'system',
        content: result.error || 'Step execution failed',
        metadata: { stepExecutionId: nextStepExecution.id },
      });
      executionEvents.emit(executionId, errorMsg);

      return {
        success: false,
        executionId,
        status: 'paused',
        currentStep: step.step_order,
        stepResults: [{
          stepId: step.id,
          stepOrder: step.step_order,
          stepName: step.step_name,
          status: 'failed',
          error: result.error,
        }],
        error: result.error,
      };
    }

    // Build output data from executor result
    const outputData = JSON.stringify({
      content: result.content,
      ...result.metadata,
    });

    // Emit step-output
    const outputMsg = executionEvents.createMessage({
      executionId,
      stepOrder: step.step_order,
      stepName: step.step_name,
      stepType,
      type: 'step-output',
      role: 'system',
      content: result.content,
      metadata: {
        model: result.modelUsed,
        usage: result.metadata?.usage,
        images: result.metadata?.generatedImages,
        isJson: result.metadata?.isJson || step.output_format === 'json',
        stepExecutionId: nextStepExecution.id,
      },
    });
    executionEvents.emit(executionId, outputMsg);

    // Auto-run logic: non-interactive steps auto-approve and continue
    if (AUTO_RUN_STEP_TYPES.includes(stepType)) {
      // Auto-approve: set completed directly
      queries.updateStepExecution(
        'completed',
        outputData,
        result.modelUsed || executor.type,
        result.promptUsed || '',
        nextStepExecution.id
      );
      queries.approveStepExecution(true, 'completed', nextStepExecution.id);

      // Emit step-approved
      const approvedMsg = executionEvents.createMessage({
        executionId,
        stepOrder: step.step_order,
        stepName: step.step_name,
        stepType,
        type: 'step-approved',
        role: 'system',
        content: 'Step auto-approved, continuing...',
      });
      executionEvents.emit(executionId, approvedMsg);

      // Continue to next step
      return executeWorkflowWithSteps(executionId, userId, userInputs, steps);
    }

    // Interactive steps (scraping, manus) — pause for review
    queries.updateStepExecution(
      'awaiting_review',
      outputData,
      result.modelUsed || executor.type,
      result.promptUsed || '',
      nextStepExecution.id
    );
    queries.updateExecutionStatus('paused', step.step_order, executionId);

    // Emit action-required
    const actionMsg = executionEvents.createMessage({
      executionId,
      stepOrder: step.step_order,
      stepName: step.step_name,
      stepType,
      type: 'action-required',
      role: 'system',
      content: 'Step complete. Please review and approve or reject.',
      metadata: {
        actionType: 'approve',
        stepExecutionId: nextStepExecution.id,
      },
    });
    executionEvents.emit(executionId, actionMsg);

    // Get updated step executions
    const updatedStepExecutions = queries.getStepExecutionsByExecutionId(executionId) as StepExecution[];

    return {
      success: true,
      executionId,
      status: 'paused',
      currentStep: step.step_order,
      stepResults: updatedStepExecutions.map(se => {
        const stepDef = steps.find(s => s.id === se.step_id || s.step_order === se.step_order);
        return {
          stepId: se.step_id,
          stepOrder: se.step_order,
          stepName: stepDef?.step_name || 'Unknown',
          status: se.status,
          output: se.output_data ? JSON.parse(se.output_data).content : undefined,
          error: se.error_message || undefined,
        };
      }),
    };
  } catch (error) {
    const errStr = error instanceof Error ? error.message : 'Step execution failed';
    queries.setStepExecutionError('failed', errStr, nextStepExecution.id);
    queries.updateExecutionStatus('paused', step.step_order, executionId);

    // Emit step-error
    const errorMsg = executionEvents.createMessage({
      executionId,
      stepOrder: step.step_order,
      stepName: step.step_name,
      stepType,
      type: 'step-error',
      role: 'system',
      content: errStr,
      metadata: { stepExecutionId: nextStepExecution.id },
    });
    executionEvents.emit(executionId, errorMsg);

    return {
      success: false,
      executionId,
      status: 'paused',
      currentStep: step.step_order,
      stepResults: [{
        stepId: step.id,
        stepOrder: step.step_order,
        stepName: step.step_name,
        status: 'failed',
        error: errStr,
      }],
      error: errStr,
    };
  }
}

// Execute the workflow from current step (legacy - fetches steps from DB)
async function executeWorkflow(
  executionId: number,
  userId: number,
  userInputs: Record<string, any>
): Promise<ExecutionResult> {
  const execution = queries.getExecutionById(executionId) as WorkflowExecution;
  const stepExecutions = queries.getStepExecutionsByExecutionId(executionId) as StepExecution[];
  const steps = queries.getStepsByRecipeId(execution.recipe_id) as RecipeStep[];

  const stepResults: StepExecutionResult[] = [];

  // Find the next step to execute
  let currentStepOrder = execution.current_step;
  const nextStepExecution = stepExecutions.find(
    se => se.step_order > currentStepOrder && se.status === 'pending'
  ) || stepExecutions.find(se => se.status === 'pending');

  if (!nextStepExecution) {
    // All steps completed
    queries.completeExecution('completed', executionId);
    return {
      success: true,
      executionId,
      status: 'completed',
      currentStep: currentStepOrder,
      stepResults: stepExecutions.map(se => ({
        stepId: se.step_id,
        stepOrder: se.step_order,
        stepName: steps.find(s => s.id === se.step_id)?.step_name || 'Unknown',
        status: se.status,
        output: se.output_data ? JSON.parse(se.output_data).content : undefined,
        error: se.error_message || undefined,
      })),
    };
  }

  // Delegate to executeWorkflowWithSteps which uses the executor registry
  return executeWorkflowWithSteps(executionId, userId, userInputs, steps);
}

// Approve a step and continue execution
export async function approveStep(
  executionId: number,
  stepExecutionId: number,
  userId: number
): Promise<ExecutionResult> {
  const execution = queries.getExecutionById(executionId) as WorkflowExecution;
  const stepExecution = queries.getStepExecutionById(stepExecutionId) as StepExecution;

  if (!execution || !stepExecution) {
    return {
      success: false,
      executionId,
      status: 'failed',
      currentStep: 0,
      stepResults: [],
      error: 'Execution or step not found',
    };
  }

  if (stepExecution.execution_id !== executionId) {
    return {
      success: false,
      executionId,
      status: 'failed',
      currentStep: 0,
      stepResults: [],
      error: 'Step does not belong to this execution',
    };
  }

  // Mark step as approved and completed
  queries.approveStepExecution(true, 'completed', stepExecutionId);

  // Emit step-approved
  const step = queries.getStepById(stepExecution.step_id) as RecipeStep;
  const approvedMsg = executionEvents.createMessage({
    executionId,
    stepOrder: stepExecution.step_order,
    stepName: step?.step_name || 'Unknown',
    stepType: step?.step_type || 'ai',
    type: 'step-approved',
    role: 'system',
    content: 'Step approved, continuing...',
  });
  executionEvents.emit(executionId, approvedMsg);

  // Get user inputs and custom steps from execution
  let userInputs: Record<string, any> = {};
  let customSteps: RecipeStep[] | undefined;
  if (execution.input_data) {
    try {
      const data = JSON.parse(execution.input_data as string);
      // Extract custom steps if present
      if (data.__customSteps) {
        customSteps = data.__customSteps;
        delete data.__customSteps;
      }
      userInputs = data;
    } catch {
      // Use empty object if parsing fails
    }
  }

  // Continue execution with next step - use custom steps if present
  if (customSteps && customSteps.length > 0) {
    const steps = customSteps.map((step, index) => ({
      ...step,
      id: step.id || -(index + 1),
      step_order: index + 1,
    }));
    return executeWorkflowWithSteps(executionId, userId, userInputs, steps);
  }
  return executeWorkflow(executionId, userId, userInputs);
}

// Reject a step (marks it for retry)
export function rejectStep(
  executionId: number,
  stepExecutionId: number
): { success: boolean; error?: string } {
  const stepExecution = queries.getStepExecutionById(stepExecutionId) as StepExecution;

  if (!stepExecution || stepExecution.execution_id !== executionId) {
    return { success: false, error: 'Step not found or does not belong to this execution' };
  }

  // Reset step to pending for retry
  queries.approveStepExecution(false, 'pending', stepExecutionId);
  queries.updateExecutionStatus('paused', stepExecution.step_order - 1, executionId);

  // Emit step-rejected
  const step = queries.getStepById(stepExecution.step_id) as RecipeStep;
  const rejectedMsg = executionEvents.createMessage({
    executionId,
    stepOrder: stepExecution.step_order,
    stepName: step?.step_name || 'Unknown',
    stepType: step?.step_type || 'ai',
    type: 'step-rejected',
    role: 'system',
    content: 'Step rejected',
  });
  executionEvents.emit(executionId, rejectedMsg);

  return { success: true };
}

// Retry a step with optional modifications
export async function retryStep(
  executionId: number,
  stepExecutionId: number,
  userId: number,
  modifiedPrompt?: string,
  modifiedInput?: Record<string, any>
): Promise<ExecutionResult> {
  const execution = queries.getExecutionById(executionId) as WorkflowExecution;
  const stepExecution = queries.getStepExecutionById(stepExecutionId) as StepExecution;
  const step = queries.getStepById(stepExecution.step_id) as RecipeStep;

  if (!execution || !stepExecution || !step) {
    return {
      success: false,
      executionId,
      status: 'failed',
      currentStep: 0,
      stepResults: [],
      error: 'Execution, step execution, or step not found',
    };
  }

  // Get user inputs
  let userInputs: Record<string, any> = {};
  if (execution.input_data) {
    try {
      userInputs = JSON.parse(execution.input_data as string);
    } catch {
      // Use empty object if parsing fails
    }
  }

  // Merge modified inputs
  if (modifiedInput) {
    userInputs = { ...userInputs, ...modifiedInput };
    queries.createExecution(
      execution.recipe_id,
      userId,
      JSON.stringify(userInputs)
    );
  }

  // Update step status to running
  queries.updateStepExecution(
    'running',
    null,
    null,
    null,
    stepExecutionId
  );

  const stepExecutions = queries.getStepExecutionsByExecutionId(executionId) as StepExecution[];

  // If a modified prompt is provided, use it by overriding the step's prompt_template
  const stepToExecute = modifiedPrompt
    ? { ...step, prompt_template: modifiedPrompt }
    : step;

  // Dispatch to the appropriate executor via the registry
  const executor = getExecutor(step.step_type || 'ai') || getExecutor('ai')!;

  const executorContext: StepExecutorContext = {
    userId,
    executionId,
    stepExecution: stepExecution,
    userInputs,
    completedStepExecutions: stepExecutions.filter(se => se.status === 'completed'),
  };

  try {
    const result = await executor.execute(stepToExecute, executorContext);

    if (!result.success) {
      queries.setStepExecutionError('failed', result.error || 'Step execution failed', stepExecutionId);
      return {
        success: false,
        executionId,
        status: 'paused',
        currentStep: step.step_order,
        stepResults: [{
          stepId: step.id,
          stepOrder: step.step_order,
          stepName: step.step_name,
          status: 'failed',
          error: result.error,
        }],
        error: result.error,
      };
    }

    const outputData = JSON.stringify({
      content: result.content,
      ...result.metadata,
    });

    queries.updateStepExecution(
      'awaiting_review',
      outputData,
      result.modelUsed || executor.type,
      result.promptUsed || '',
      stepExecutionId
    );

    // Get updated step executions
    const updatedStepExecutions = queries.getStepExecutionsByExecutionId(executionId) as StepExecution[];
    const steps = queries.getStepsByRecipeId(execution.recipe_id) as RecipeStep[];

    return {
      success: true,
      executionId,
      status: 'paused',
      currentStep: step.step_order,
      stepResults: updatedStepExecutions.map(se => {
        const stepDef = steps.find(s => s.id === se.step_id);
        return {
          stepId: se.step_id,
          stepOrder: se.step_order,
          stepName: stepDef?.step_name || 'Unknown',
          status: se.status,
          output: se.output_data ? JSON.parse(se.output_data).content : undefined,
          error: se.error_message || undefined,
        };
      }),
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Step retry failed';
    queries.setStepExecutionError('failed', errorMsg, stepExecutionId);
    return {
      success: false,
      executionId,
      status: 'paused',
      currentStep: step.step_order,
      stepResults: [{
        stepId: step.id,
        stepOrder: step.step_order,
        stepName: step.step_name,
        status: 'failed',
        error: errorMsg,
      }],
      error: errorMsg,
    };
  }
}

// Get execution status with all details
export function getExecutionStatus(executionId: number): ExecutionResult | null {
  const execution = queries.getExecutionById(executionId) as WorkflowExecution;
  if (!execution) return null;

  const stepExecutions = queries.getStepExecutionsByExecutionId(executionId) as StepExecution[];
  const steps = queries.getStepsByRecipeId(execution.recipe_id) as RecipeStep[];

  return {
    success: execution.status !== 'failed',
    executionId,
    status: execution.status,
    currentStep: execution.current_step,
    stepResults: stepExecutions.map(se => {
      const step = steps.find(s => s.id === se.step_id);
      let output: string | undefined;

      if (se.output_data) {
        try {
          const parsed = JSON.parse(se.output_data);
          output = parsed.content;
        } catch {
          output = se.output_data;
        }
      }

      return {
        stepId: se.step_id,
        stepOrder: se.step_order,
        stepName: step?.step_name || 'Unknown',
        status: se.status,
        output,
        error: se.error_message || undefined,
      };
    }),
  };
}


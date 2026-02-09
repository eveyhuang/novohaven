import { queries } from '../models/database';
import { getExecutor } from '../executors/registry';
import { StepExecutorContext } from '../executors/StepExecutor';
import {
  WorkflowExecution,
  StepExecution,
  RecipeStep,
  ExecutionStatus,
  StepExecutionStatus,
} from '../types';

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

  // Start executing the workflow with the steps
  return executeWorkflowWithSteps(executionId, userId, inputData, steps);
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
    // Handle scraping steps - get inputs from input_config
    if (step.step_type === 'scraping' && step.input_config) {
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

    // Handle AI steps - get inputs from prompt_template
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
  const executor = getExecutor(step.step_type || 'ai') || getExecutor('ai')!;

  const executorContext: StepExecutorContext = {
    userId,
    executionId,
    stepExecution: nextStepExecution,
    userInputs,
    completedStepExecutions: stepExecutions.filter(se => se.status === 'completed'),
  };

  try {
    const result = await executor.execute(step, executorContext);

    if (!result.success) {
      queries.setStepExecutionError('failed', result.error || 'Step execution failed', nextStepExecution.id);
      queries.updateExecutionStatus('paused', step.step_order, executionId);
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

    queries.updateStepExecution(
      'awaiting_review',
      outputData,
      result.modelUsed || executor.type,
      result.promptUsed || '',
      nextStepExecution.id
    );

    // Pause execution for review
    queries.updateExecutionStatus('paused', step.step_order, executionId);

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
    const errorMsg = error instanceof Error ? error.message : 'Step execution failed';
    queries.setStepExecutionError('failed', errorMsg, nextStepExecution.id);
    queries.updateExecutionStatus('paused', step.step_order, executionId);
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


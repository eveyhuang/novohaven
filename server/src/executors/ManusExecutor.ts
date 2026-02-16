import { RecipeStep } from '../types';
import { createTask, waitForCompletion, isManusConfigured } from '../services/manusService';
import { compilePrompt } from '../services/promptParser';
import { logUsage } from '../services/usageTrackingService';
import { queries } from '../models/database';
import {
  StepExecutor,
  StepExecutorContext,
  StepExecutorResult,
  ExecutorConfigSchema,
} from './StepExecutor';

export class ManusExecutor implements StepExecutor {
  type = 'manus';
  displayName = 'Manus Agent';
  icon = '🧠';
  description = 'AI agent with template variables — resolve {{variables}} before Manus executes';

  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!step.prompt_template || !step.prompt_template.trim()) {
      errors.push('Manus Agent step requires a prompt template');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult> {
    const { userInputs, userId, stepExecution, completedStepExecutions } = context;

    if (!step.prompt_template || !step.prompt_template.trim()) {
      return {
        success: false,
        content: '',
        error: 'No prompt template provided for Manus Agent step.',
      };
    }

    if (!isManusConfigured()) {
      return {
        success: false,
        content: '',
        error: 'Manus AI is not configured. Please set MANUS_API_KEY environment variable.',
      };
    }

    // Compile prompt: resolve {{variables}}, {{step_N_output}}, and company standards
    const compiled = compilePrompt(step.prompt_template, {
      userId,
      userInputs,
      stepExecutions: completedStepExecutions,
    });

    if (compiled.unresolvedVariables.length > 0) {
      console.warn(`[ManusExecutor] Unresolved variables: ${compiled.unresolvedVariables.join(', ')}`);
    }

    const fullPrompt = compiled.compiledPrompt;

    try {
      const taskId = await createTask(fullPrompt);

      // Store taskId in step execution metadata early so the frontend
      // can connect to the SSE stream while we wait for completion
      const earlyMetadata = JSON.stringify({ manusTaskId: taskId, stepType: 'manus' });
      queries.updateStepExecution('running', earlyMetadata, 'manus:agent', fullPrompt, stepExecution.id);

      const result = await waitForCompletion(taskId);

      if (result.status === 'failed') {
        return {
          success: false,
          content: '',
          error: `Manus task failed: ${result.output || 'Unknown error'}`,
        };
      }

      // Log usage
      logUsage(userId, 'manus', 'agent', 1, 0, {
        taskId,
        creditsUsed: result.creditsUsed,
      });

      return {
        success: true,
        content: result.output,
        metadata: {
          service: 'manus',
          taskId,
          creditsUsed: result.creditsUsed,
          stepType: 'manus',
          manusTaskId: taskId,
        },
        promptUsed: fullPrompt,
        modelUsed: 'manus:agent',
      };
    } catch (error: any) {
      return {
        success: false,
        content: '',
        error: `Manus agent error: ${error.message}`,
      };
    }
  }

  getConfigSchema(): ExecutorConfigSchema {
    return {
      fields: [
        {
          name: 'prompt_template',
          label: 'Prompt Template',
          type: 'textarea',
          required: true,
          helpText: 'Write your prompt with {{variables}} that will be resolved at runtime. Supports {{step_N_output}} for chaining and {{brand_voice}} for company standards.',
        },
        {
          name: 'output_format',
          label: 'Output Format',
          type: 'select',
          defaultValue: 'text',
          options: [
            { value: 'text', label: 'Plain Text' },
            { value: 'markdown', label: 'Markdown' },
            { value: 'json', label: 'JSON' },
          ],
        },
      ],
    };
  }
}

import { RecipeStep } from '../types';
import { createTask, waitForCompletion, isManusConfigured, getTaskMessages } from '../services/manusService';
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

    const { emitter, executionId } = context;

    try {
      const taskId = await createTask(fullPrompt);

      // Store taskId in step execution metadata early so the frontend
      // can connect to the SSE stream while we wait for completion
      const earlyMetadata = JSON.stringify({ manusTaskId: taskId, stepType: 'manus' });
      queries.updateStepExecution('running', earlyMetadata, 'manus:agent', fullPrompt, stepExecution.id);

      // Emit progress with taskId so frontend knows about the Manus task
      if (emitter) {
        const progressMsg = emitter.createMessage({
          executionId,
          stepOrder: stepExecution.step_order,
          stepName: step.step_name,
          stepType: 'manus',
          type: 'progress',
          role: 'system',
          content: 'Manus agent task started...',
          metadata: { taskId },
        });
        emitter.emit(executionId, progressMsg);
      }

      // Poll for messages while waiting for completion
      let lastMessageCount = 0;
      const pollInterval = setInterval(async () => {
        if (!emitter) return;
        try {
          const messagesResult = await getTaskMessages(taskId);
          const messages = messagesResult.messages || [];
          // Emit any new messages
          for (let i = lastMessageCount; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role === 'assistant') {
              const textContent = msg.content
                ?.filter((c: any) => c.type === 'text')
                .map((c: any) => c.text)
                .join('\n') || '';
              if (textContent) {
                const agentMsg = emitter.createMessage({
                  executionId,
                  stepOrder: stepExecution.step_order,
                  stepName: step.step_name,
                  stepType: 'manus',
                  type: 'agent-message',
                  role: 'assistant',
                  content: textContent,
                  metadata: { taskId },
                });
                emitter.emit(executionId, agentMsg);
              }
            }
          }
          lastMessageCount = messages.length;
        } catch {
          // Ignore polling errors
        }
      }, 6000);

      const result = await waitForCompletion(taskId);
      clearInterval(pollInterval);

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
          files: result.files,
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

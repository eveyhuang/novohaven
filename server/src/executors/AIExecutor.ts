import { RecipeStep, ModelConfig } from '../types';
import { callAIByModel } from '../services/aiService';
import { compilePrompt, CompilePromptContext } from '../services/promptParser';
import {
  StepExecutor,
  StepExecutorContext,
  StepExecutorResult,
  ExecutorConfigSchema,
} from './StepExecutor';

export class AIExecutor implements StepExecutor {
  type = 'ai';
  displayName = 'AI Model';
  icon = '🤖';
  description = 'Execute a prompt using an AI language model (OpenAI, Anthropic, Google)';

  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!step.ai_model) {
      errors.push('AI model is required');
    }
    if (!step.prompt_template) {
      errors.push('Prompt template is required');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult> {
    // Compile the prompt with variable substitution
    const compileContext: CompilePromptContext = {
      userId: context.userId,
      userInputs: context.userInputs,
      stepExecutions: context.completedStepExecutions,
    };

    const { compiledPrompt, unresolvedVariables, images } = compilePrompt(
      step.prompt_template || '',
      compileContext
    );

    if (unresolvedVariables.length > 0) {
      return {
        success: false,
        content: '',
        error: `Unresolved variables: ${unresolvedVariables.join(', ')}`,
        promptUsed: compiledPrompt,
      };
    }

    // Parse model config
    let modelConfig: ModelConfig = {};
    if (step.model_config) {
      try {
        modelConfig = JSON.parse(step.model_config);
      } catch {
        // Use defaults if config is invalid
      }
    }

    // Add images to model config if present
    if (images.length > 0) {
      (modelConfig as any).images = images;
    }

    // Call AI
    const aiResponse = await callAIByModel(step.ai_model, compiledPrompt, modelConfig);

    if (!aiResponse.success) {
      return {
        success: false,
        content: '',
        error: aiResponse.error || 'AI call failed',
        promptUsed: compiledPrompt,
        modelUsed: step.ai_model,
      };
    }

    return {
      success: true,
      content: aiResponse.content,
      metadata: {
        model: aiResponse.model,
        usage: aiResponse.usage,
        generatedImages: aiResponse.generatedImages,
      },
      promptUsed: compiledPrompt,
      modelUsed: aiResponse.model,
    };
  }

  getConfigSchema(): ExecutorConfigSchema {
    return {
      fields: [
        {
          name: 'ai_model',
          label: 'AI Model',
          type: 'select',
          required: true,
          helpText: 'Select the AI model to use for this step',
          options: [], // Populated dynamically from AI_MODELS on the frontend
        },
        {
          name: 'prompt_template',
          label: 'Prompt Template',
          type: 'textarea',
          required: true,
          helpText: 'Use {{variable_name}} for user inputs and {{step_N_output}} for previous step results',
        },
        {
          name: 'output_format',
          label: 'Output Format',
          type: 'select',
          required: true,
          defaultValue: 'text',
          options: [
            { value: 'text', label: 'Text' },
            { value: 'json', label: 'JSON' },
            { value: 'markdown', label: 'Markdown' },
            { value: 'image', label: 'Image' },
          ],
        },
        {
          name: 'temperature',
          label: 'Temperature',
          type: 'number',
          defaultValue: 0.7,
          helpText: 'Controls randomness (0-2). Lower = more deterministic.',
        },
        {
          name: 'maxTokens',
          label: 'Max Tokens',
          type: 'number',
          defaultValue: 4096,
          helpText: 'Maximum number of tokens in the response',
        },
      ],
    };
  }
}

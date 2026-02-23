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

    let { compiledPrompt, unresolvedVariables, images } = compilePrompt(
      step.prompt_template || '',
      compileContext
    );

    const declaredRequiredUserInputs = this.getDeclaredRequiredUserInputs(step);
    if (declaredRequiredUserInputs !== null && unresolvedVariables.length > 0) {
      const optionalMissing = unresolvedVariables.filter((name) => !declaredRequiredUserInputs.has(name));
      if (optionalMissing.length > 0) {
        for (const name of optionalMissing) {
          const placeholder = `[User input "${name}" required]`;
          compiledPrompt = compiledPrompt.split(placeholder).join('');
        }
        // Normalize blank lines caused by optional placeholder removal.
        compiledPrompt = compiledPrompt.replace(/\n{3,}/g, '\n\n').trim();
      }
      unresolvedVariables = unresolvedVariables.filter((name) => declaredRequiredUserInputs.has(name));
    }

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

  private getDeclaredRequiredUserInputs(step: RecipeStep): Set<string> | null {
    if (!step.input_config) return null;

    try {
      const parsed = JSON.parse(step.input_config);
      if (!parsed || typeof parsed !== 'object' || !('variables' in parsed)) {
        return null;
      }

      const required = new Set<string>();
      const vars = (parsed as any).variables;
      const promptTemplate = String(step.prompt_template || '');

      if (Array.isArray(vars)) {
        for (const variable of vars) {
          const name = String(variable?.name || '').trim();
          const source = String(variable?.source || 'user_input').trim();
          if (!name || source !== 'user_input') continue;
          const isOptional = (
            variable?.required === false
            || variable?.optional === true
            || this.looksOptionalHint(variable?.description || variable?.label)
            || this.isOptionalByPromptHint(promptTemplate, name)
          );
          if (isOptional) continue;
          required.add(name);
        }
        return required;
      }

      if (vars && typeof vars === 'object') {
        for (const [varName, rawConfig] of Object.entries(vars)) {
          const name = String(varName || '').trim();
          const config = (rawConfig || {}) as any;
          const source = String(config?.source || 'user_input').trim();
          if (!name || source !== 'user_input') continue;
          const isOptional = (
            config?.required === false
            || config?.optional === true
            || this.looksOptionalHint(config?.description || config?.label)
            || this.isOptionalByPromptHint(promptTemplate, name)
          );
          if (isOptional) continue;
          required.add(name);
        }
        return required;
      }

      return null;
    } catch {
      return null;
    }
  }

  private looksOptionalHint(value: unknown): boolean {
    return /(optional|not required|can be omitted|可选|选填|非必填|可以不填|可不填|可不提供|不是必须)/i.test(String(value || ''));
  }

  private escapeRegExp(value: string): string {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private isOptionalByPromptHint(template: string, varName: string): boolean {
    const text = String(template || '');
    const name = String(varName || '').trim();
    if (!text || !name) return false;

    const tokenLine = new RegExp(`\\{\\{\\s*${this.escapeRegExp(name)}\\s*\\}\\}`, 'i');
    const tokenGlobal = new RegExp(`\\{\\{\\s*${this.escapeRegExp(name)}\\s*\\}\\}`, 'gi');

    for (const line of text.split(/\r?\n/)) {
      if (!tokenLine.test(line)) continue;
      if (this.looksOptionalHint(line)) return true;
    }

    let match: RegExpExecArray | null;
    tokenGlobal.lastIndex = 0;
    while ((match = tokenGlobal.exec(text)) !== null) {
      const idx = match.index;
      const around = text.slice(Math.max(0, idx - 80), Math.min(text.length, idx + match[0].length + 80));
      if (this.looksOptionalHint(around)) return true;
    }

    return false;
  }
}

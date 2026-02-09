import { AIExecutor } from '../../executors/AIExecutor';
import { RecipeStep, StepExecution } from '../../types';
import { StepExecutorContext } from '../../executors/StepExecutor';

// Mock the dependencies
jest.mock('../../services/aiService', () => ({
  callAIByModel: jest.fn(),
}));

jest.mock('../../services/promptParser', () => ({
  compilePrompt: jest.fn(),
}));

// Mock the database module (needed because promptParser imports it)
jest.mock('../../models/database', () => ({
  queries: {},
}));

import { callAIByModel } from '../../services/aiService';
import { compilePrompt } from '../../services/promptParser';

const mockCallAI = callAIByModel as jest.MockedFunction<typeof callAIByModel>;
const mockCompilePrompt = compilePrompt as jest.MockedFunction<typeof compilePrompt>;

describe('AIExecutor', () => {
  let executor: AIExecutor;
  let mockStep: RecipeStep;
  let mockContext: StepExecutorContext;

  beforeEach(() => {
    executor = new AIExecutor();
    jest.clearAllMocks();

    mockStep = {
      id: 1,
      recipe_id: 1,
      step_order: 1,
      step_name: 'Test AI Step',
      step_type: 'ai',
      ai_model: 'gpt-4o',
      prompt_template: 'Analyze {{product_name}} reviews',
      output_format: 'text',
      model_config: JSON.stringify({ temperature: 0.7, maxTokens: 4096 }),
      created_at: '2024-01-01',
    };

    mockContext = {
      userId: 1,
      executionId: 1,
      stepExecution: {
        id: 1,
        execution_id: 1,
        step_id: 1,
        step_order: 1,
        status: 'running',
        approved: false,
      } as StepExecution,
      userInputs: { product_name: 'Test Product' },
      completedStepExecutions: [],
    };
  });

  describe('type and metadata', () => {
    test('has correct type identifier', () => {
      expect(executor.type).toBe('ai');
    });

    test('has display name', () => {
      expect(executor.displayName).toBe('AI Model');
    });

    test('has an icon', () => {
      expect(executor.icon).toBeTruthy();
    });

    test('has a description', () => {
      expect(executor.description).toBeTruthy();
    });
  });

  describe('validateConfig', () => {
    test('returns valid when ai_model and prompt_template are present', () => {
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('returns error when ai_model is missing', () => {
      mockStep.ai_model = '';
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('AI model is required');
    });

    test('returns error when prompt_template is missing', () => {
      mockStep.prompt_template = '';
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Prompt template is required');
    });

    test('returns multiple errors when both are missing', () => {
      mockStep.ai_model = '';
      mockStep.prompt_template = '';
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe('execute', () => {
    test('compiles prompt, calls AI, and returns success result', async () => {
      mockCompilePrompt.mockReturnValue({
        compiledPrompt: 'Analyze Test Product reviews',
        unresolvedVariables: [],
        images: [],
      });

      mockCallAI.mockResolvedValue({
        success: true,
        content: 'AI analysis result',
        model: 'gpt-4o',
        usage: { promptTokens: 100, completionTokens: 200 },
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(result.content).toBe('AI analysis result');
      expect(result.promptUsed).toBe('Analyze Test Product reviews');
      expect(result.modelUsed).toBe('gpt-4o');
      expect(result.metadata).toEqual({
        model: 'gpt-4o',
        usage: { promptTokens: 100, completionTokens: 200 },
        generatedImages: undefined,
      });
    });

    test('passes compiled prompt context with user inputs and completed steps', async () => {
      mockCompilePrompt.mockReturnValue({
        compiledPrompt: 'compiled',
        unresolvedVariables: [],
        images: [],
      });
      mockCallAI.mockResolvedValue({
        success: true,
        content: 'result',
        model: 'gpt-4o',
      });

      await executor.execute(mockStep, mockContext);

      expect(mockCompilePrompt).toHaveBeenCalledWith(
        'Analyze {{product_name}} reviews',
        {
          userId: 1,
          userInputs: { product_name: 'Test Product' },
          stepExecutions: [],
        }
      );
    });

    test('returns failure when there are unresolved variables', async () => {
      mockCompilePrompt.mockReturnValue({
        compiledPrompt: 'Analyze {{product_name}} reviews',
        unresolvedVariables: ['product_name'],
        images: [],
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unresolved variables');
      expect(result.error).toContain('product_name');
      expect(mockCallAI).not.toHaveBeenCalled();
    });

    test('returns failure when AI call fails', async () => {
      mockCompilePrompt.mockReturnValue({
        compiledPrompt: 'compiled prompt',
        unresolvedVariables: [],
        images: [],
      });

      mockCallAI.mockResolvedValue({
        success: false,
        content: '',
        model: 'gpt-4o',
        error: 'API rate limit exceeded',
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toBe('API rate limit exceeded');
    });

    test('parses model_config from step', async () => {
      mockCompilePrompt.mockReturnValue({
        compiledPrompt: 'prompt',
        unresolvedVariables: [],
        images: [],
      });
      mockCallAI.mockResolvedValue({
        success: true,
        content: 'result',
        model: 'gpt-4o',
      });

      await executor.execute(mockStep, mockContext);

      expect(mockCallAI).toHaveBeenCalledWith(
        'gpt-4o',
        'prompt',
        expect.objectContaining({ temperature: 0.7, maxTokens: 4096 })
      );
    });

    test('handles invalid model_config JSON gracefully', async () => {
      mockStep.model_config = 'invalid json';

      mockCompilePrompt.mockReturnValue({
        compiledPrompt: 'prompt',
        unresolvedVariables: [],
        images: [],
      });
      mockCallAI.mockResolvedValue({
        success: true,
        content: 'result',
        model: 'gpt-4o',
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      // Should fall back to empty config
      expect(mockCallAI).toHaveBeenCalledWith('gpt-4o', 'prompt', {});
    });

    test('passes images from compiled prompt to model config', async () => {
      const images = [{ base64: 'abc123', mediaType: 'image/png' as const }];
      mockCompilePrompt.mockReturnValue({
        compiledPrompt: 'prompt with image',
        unresolvedVariables: [],
        images,
      });
      mockCallAI.mockResolvedValue({
        success: true,
        content: 'image analysis',
        model: 'gpt-4o',
      });

      await executor.execute(mockStep, mockContext);

      expect(mockCallAI).toHaveBeenCalledWith(
        'gpt-4o',
        'prompt with image',
        expect.objectContaining({ images })
      );
    });

    test('handles step with empty prompt_template', async () => {
      mockStep.prompt_template = '';

      mockCompilePrompt.mockReturnValue({
        compiledPrompt: '',
        unresolvedVariables: [],
        images: [],
      });
      mockCallAI.mockResolvedValue({
        success: true,
        content: 'result',
        model: 'gpt-4o',
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(mockCompilePrompt).toHaveBeenCalledWith('', expect.any(Object));
    });

    test('includes generatedImages in metadata when present', async () => {
      const generatedImages = [{ base64: 'img_data', mimeType: 'image/png' }];
      mockCompilePrompt.mockReturnValue({
        compiledPrompt: 'generate image',
        unresolvedVariables: [],
        images: [],
      });
      mockCallAI.mockResolvedValue({
        success: true,
        content: 'Image generated',
        model: 'gemini-3-pro-image-preview',
        generatedImages,
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(result.metadata?.generatedImages).toEqual(generatedImages);
    });
  });

  describe('getConfigSchema', () => {
    test('returns a schema with required fields', () => {
      const schema = executor.getConfigSchema();
      expect(schema.fields).toBeDefined();
      expect(schema.fields.length).toBeGreaterThan(0);

      const fieldNames = schema.fields.map(f => f.name);
      expect(fieldNames).toContain('ai_model');
      expect(fieldNames).toContain('prompt_template');
      expect(fieldNames).toContain('output_format');
    });

    test('marks ai_model and prompt_template as required', () => {
      const schema = executor.getConfigSchema();
      const aiModel = schema.fields.find(f => f.name === 'ai_model');
      const prompt = schema.fields.find(f => f.name === 'prompt_template');

      expect(aiModel?.required).toBe(true);
      expect(prompt?.required).toBe(true);
    });
  });
});

/**
 * Tests for the template-aware workflow assistant.
 *
 * Covers:
 * - parseAssistantResponse: template-request extraction, template fields in workflow-json
 * - generateWorkflow: two-pass flow (template-request → detail injection → second call),
 *   single-pass when no templates, empty messages
 * - saveWorkflowAsRecipe: hybrid merge (template-sourced vs from-scratch steps)
 * - buildSystemPrompt: template summaries included when templates exist
 */

// Mock dependencies before imports
jest.mock('../../services/aiService', () => ({
  callAIByModel: jest.fn(),
  getAvailableModels: jest.fn().mockReturnValue([
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', maxTokens: 4096, supportsVision: true, supportsImageGeneration: false },
  ]),
}));

jest.mock('../../executors/registry', () => ({
  getAllExecutors: jest.fn().mockReturnValue([
    {
      type: 'ai',
      displayName: 'AI Model',
      icon: '🤖',
      description: 'AI text generation',
      getConfigSchema: () => ({ fields: [{ name: 'ai_model', type: 'select', label: 'Model', required: true }] }),
    },
  ]),
}));

const mockCreateRecipe = jest.fn().mockReturnValue({ lastInsertRowid: 42 });
const mockCreateStep = jest.fn();
const mockGetRecipesByUser = jest.fn();
const mockGetStepsByRecipeId = jest.fn();

jest.mock('../../models/database', () => ({
  queries: {
    createRecipe: (...args: any[]) => mockCreateRecipe(...args),
    createStep: (...args: any[]) => mockCreateStep(...args),
    getRecipesByUser: (...args: any[]) => mockGetRecipesByUser(...args),
    getStepsByRecipeId: (...args: any[]) => mockGetStepsByRecipeId(...args),
  },
}));

jest.mock('../../types', () => ({
  AI_MODELS: [],
}));

import { callAIByModel } from '../../services/aiService';
import { generateWorkflow, saveWorkflowAsRecipe, GeneratedWorkflow, ConversationMessage } from '../../services/workflowAssistant';

const mockCallAI = callAIByModel as jest.MockedFunction<typeof callAIByModel>;

// --- Helper: access parseAssistantResponse (not exported) ---
// We test it indirectly through generateWorkflow, but also directly via require
// since it's a critical parsing function.
function getParseAssistantResponse() {
  // parseAssistantResponse is not exported, so we use a workaround:
  // we call generateWorkflow with a mocked AI response and check the parsed output.
  // For direct unit tests, we extract by reading the module internals.
  // Actually, we'll test parsing indirectly through generateWorkflow.
  // For the direct parsing tests below, we replicate the parsing logic in test assertions.
  return null;
}

describe('WorkflowAssistant — Template Awareness', () => {

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: templates exist in the DB
    mockGetRecipesByUser.mockReturnValue([
      { id: 1, name: 'Image Style Analyzer', description: 'Analyze photography style', is_template: 1, created_by: 1 },
      { id: 2, name: 'Product Image Generator', description: 'Generate product images', is_template: 1, created_by: 1 },
      { id: 3, name: 'Amazon Review Extractor', description: 'Extract reviews via BrightData', is_template: 1, created_by: 1 },
    ]);

    // Default: template steps
    mockGetStepsByRecipeId.mockImplementation((recipeId: number) => {
      const stepsMap: Record<number, any[]> = {
        1: [{
          step_order: 1, step_name: 'Analyze Style', step_type: 'ai',
          ai_model: 'gpt-4o', prompt_template: 'Analyze the image style...',
          output_format: 'text', api_config: null,
          executor_config: null, input_config: JSON.stringify({ variables: { image: { type: 'image' } } }),
          model_config: JSON.stringify({ temperature: 0.3 }),
        }],
        2: [{
          step_order: 1, step_name: 'Generate Image', step_type: 'ai',
          ai_model: 'gemini-3-pro-image-preview', prompt_template: 'Generate a product image...',
          output_format: 'image', api_config: null,
          executor_config: null, input_config: null,
          model_config: JSON.stringify({ temperature: 0.8 }),
        }],
        3: [{
          step_order: 1, step_name: 'Scrape Reviews', step_type: 'scraping',
          ai_model: null, prompt_template: null,
          output_format: 'text',
          api_config: JSON.stringify({ service: 'brightdata', endpoint: 'scrape_reviews' }),
          executor_config: JSON.stringify({ source: 'amazon', max_reviews: 100 }),
          input_config: JSON.stringify({ variables: { product_urls: { type: 'url_list' } } }),
          model_config: null,
        }],
      };
      return stepsMap[recipeId] || [];
    });
  });

  // =========================================================================
  // parseAssistantResponse (tested indirectly via generateWorkflow)
  // =========================================================================
  describe('parseAssistantResponse — template-request extraction', () => {

    test('extracts template-request block and triggers two-pass flow', async () => {
      // First call: AI returns a template-request
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: 'Let me check the relevant templates.\n\n```template-request\n[1, 2]\n```',
        model: 'gpt-4o',
      });

      // Second call: AI returns a workflow-json with from_template_id
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: 'Here is your workflow:\n\n```workflow-json\n' + JSON.stringify({
          name: 'Product Image Workflow',
          description: 'Test workflow',
          steps: [
            { step_name: 'Analyze', step_type: 'ai', ai_model: '', prompt_template: '', output_format: 'text', from_template_id: 1, from_step_order: 1 },
            { step_name: 'Generate', step_type: 'ai', ai_model: 'gemini-3-pro-image-preview', prompt_template: 'custom prompt', output_format: 'image', from_template_id: 2, from_step_order: 1, override_fields: ['prompt_template'] },
          ],
          requiredInputs: [{ name: 'image', type: 'image', description: 'Upload image' }],
        }) + '\n```',
        model: 'gpt-4o',
      });

      const messages: ConversationMessage[] = [{ role: 'user', content: 'generate product images' }];
      const result = await generateWorkflow(messages, 1);

      // Verify two AI calls were made
      expect(mockCallAI).toHaveBeenCalledTimes(2);

      // Verify second call includes template details in messages
      const secondCallArgs = mockCallAI.mock.calls[1];
      const secondMessages = secondCallArgs[2]?.messages as any[];
      const lastMessage = secondMessages[secondMessages.length - 1];
      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toContain('Template ID 1');
      expect(lastMessage.content).toContain('Template ID 2');
      expect(lastMessage.content).toContain('from_template_id');

      // Verify result has workflow with template references
      expect(result.workflow).toBeDefined();
      expect(result.workflow!.steps[0].from_template_id).toBe(1);
      expect(result.workflow!.steps[1].from_template_id).toBe(2);
      expect(result.workflow!.steps[1].override_fields).toEqual(['prompt_template']);
    });

    test('handles workflow-json with template fields in single pass (no template-request)', async () => {
      // AI directly returns workflow-json with from_template_id (no template-request block)
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: '```workflow-json\n' + JSON.stringify({
          name: 'Direct Template Use',
          description: 'Test',
          steps: [{
            step_name: 'Scrape', step_type: 'scraping', ai_model: '', prompt_template: '',
            output_format: 'text', from_template_id: 3, from_step_order: 1,
          }],
          requiredInputs: [],
        }) + '\n```',
        model: 'gpt-4o',
      });

      const result = await generateWorkflow([{ role: 'user', content: 'scrape reviews' }], 1);

      expect(mockCallAI).toHaveBeenCalledTimes(1);
      expect(result.workflow).toBeDefined();
      expect(result.workflow!.steps[0].from_template_id).toBe(3);
    });

    test('ignores invalid template-request JSON', async () => {
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: 'Some message\n\n```template-request\nnot valid json\n```',
        model: 'gpt-4o',
      });

      const result = await generateWorkflow([{ role: 'user', content: 'do something' }], 1);

      // Should not trigger two-pass, only one AI call
      expect(mockCallAI).toHaveBeenCalledTimes(1);
      expect(result.templateRequest).toBeUndefined();
    });

    test('ignores template-request with non-number IDs', async () => {
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: '```template-request\n["abc", "def"]\n```',
        model: 'gpt-4o',
      });

      const result = await generateWorkflow([{ role: 'user', content: 'do something' }], 1);

      expect(mockCallAI).toHaveBeenCalledTimes(1);
      expect(result.templateRequest).toBeUndefined();
    });
  });

  // =========================================================================
  // generateWorkflow
  // =========================================================================
  describe('generateWorkflow', () => {

    test('returns suggestions when messages array is empty', async () => {
      const result = await generateWorkflow([], 1);

      expect(result.message).toContain('describe');
      expect(result.suggestions).toBeDefined();
      expect(result.suggestions!.length).toBeGreaterThan(0);
      expect(mockCallAI).not.toHaveBeenCalled();
    });

    test('throws when AI call fails', async () => {
      mockCallAI.mockResolvedValueOnce({
        success: false,
        content: '',
        model: 'gpt-4o',
        error: 'Rate limit exceeded',
      });

      await expect(
        generateWorkflow([{ role: 'user', content: 'test' }], 1)
      ).rejects.toThrow('Rate limit exceeded');
    });

    test('throws when second-pass AI call fails', async () => {
      // First call: template-request
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: '```template-request\n[1]\n```',
        model: 'gpt-4o',
      });

      // Second call: fails
      mockCallAI.mockResolvedValueOnce({
        success: false,
        content: '',
        model: 'gpt-4o',
        error: 'Service unavailable',
      });

      await expect(
        generateWorkflow([{ role: 'user', content: 'analyze images' }], 1)
      ).rejects.toThrow('Service unavailable');
    });

    test('skips two-pass when requested template has no steps', async () => {
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: 'Let me check.\n\n```template-request\n[999]\n```\n\nNo matching template found.',
        model: 'gpt-4o',
      });

      // Template 999 has no steps
      mockGetStepsByRecipeId.mockImplementation((id: number) => id === 999 ? [] : []);

      const result = await generateWorkflow([{ role: 'user', content: 'something' }], 1);

      // Should NOT make a second call — template had no steps
      expect(mockCallAI).toHaveBeenCalledTimes(1);
    });

    test('includes format reminder on last user message', async () => {
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: 'Sure, here is a workflow.',
        model: 'gpt-4o',
      });

      await generateWorkflow([
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'second message' },
      ], 1);

      const callArgs = mockCallAI.mock.calls[0];
      const messages = callArgs[2]?.messages as any[];
      // Last message should have the format reminder appended
      expect(messages[2].content).toContain('workflow-json');
      expect(messages[2].content).toContain('second message');
      // First message should NOT have the reminder
      expect(messages[0].content).toBe('first message');
    });
  });

  // =========================================================================
  // buildSystemPrompt (tested indirectly via generateWorkflow call args)
  // =========================================================================
  describe('buildSystemPrompt — template summaries', () => {

    test('includes template summaries in system prompt when templates exist', async () => {
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: 'Response without workflow',
        model: 'gpt-4o',
      });

      await generateWorkflow([{ role: 'user', content: 'test' }], 1);

      const callArgs = mockCallAI.mock.calls[0];
      const systemMessage = callArgs[2]?.systemMessage as string;

      expect(systemMessage).toContain('Available Templates');
      expect(systemMessage).toContain('Image Style Analyzer');
      expect(systemMessage).toContain('Product Image Generator');
      expect(systemMessage).toContain('Amazon Review Extractor');
      expect(systemMessage).toContain('template-request');
      expect(systemMessage).toContain('from_template_id');
    });

    test('omits template listing when no templates exist', async () => {
      mockGetRecipesByUser.mockReturnValue([
        { id: 10, name: 'My Custom Recipe', description: 'Not a template', is_template: 0, created_by: 1 },
      ]);

      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: 'Response',
        model: 'gpt-4o',
      });

      await generateWorkflow([{ role: 'user', content: 'test' }], 1);

      const callArgs = mockCallAI.mock.calls[0];
      const systemMessage = callArgs[2]?.systemMessage as string;

      // Template names should not appear when there are no templates
      expect(systemMessage).not.toContain('Image Style Analyzer');
      expect(systemMessage).not.toContain('Amazon Review Extractor');
      // The "Templates:" listing header should not appear
      expect(systemMessage).not.toContain('Templates:\n-');
    });

    test('includes step types in template summaries', async () => {
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: 'Response',
        model: 'gpt-4o',
      });

      await generateWorkflow([{ role: 'user', content: 'test' }], 1);

      const systemMessage = mockCallAI.mock.calls[0][2]?.systemMessage as string;

      // Template 1 has step_type 'ai', Template 3 has 'scraping'
      expect(systemMessage).toContain('Steps: [ai]');
      expect(systemMessage).toContain('Steps: [scraping]');
    });

    test('includes MANDATORY check instruction in system prompt', async () => {
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: 'Response',
        model: 'gpt-4o',
      });

      await generateWorkflow([{ role: 'user', content: 'test' }], 1);

      const systemMessage = mockCallAI.mock.calls[0][2]?.systemMessage as string;

      expect(systemMessage).toContain('ALWAYS check templates first');
      expect(systemMessage).toContain('MANDATORY');
    });
  });

  // =========================================================================
  // saveWorkflowAsRecipe — hybrid merge
  // =========================================================================
  describe('saveWorkflowAsRecipe — hybrid merge', () => {

    test('saves from-scratch step with AI-provided values', async () => {
      const workflow: GeneratedWorkflow = {
        name: 'Test Workflow',
        description: 'From scratch',
        steps: [{
          step_name: 'Translate',
          step_type: 'ai',
          ai_model: 'gpt-4o',
          prompt_template: 'Translate {{text}} to Spanish',
          output_format: 'text',
        }],
        requiredInputs: [{ name: 'text', type: 'textarea', description: 'Text to translate' }],
      };

      await saveWorkflowAsRecipe(workflow, 1, false);

      expect(mockCreateRecipe).toHaveBeenCalledWith('Test Workflow', 'From scratch', 1, false);
      expect(mockCreateStep).toHaveBeenCalledWith(
        42, 1, 'Translate', 'gpt-4o', 'Translate {{text}} to Spanish',
        expect.stringContaining('text'), // input_config with variable
        'text', null, 'ai', null, null
      );
    });

    test('merges template-sourced step — uses template config as base', async () => {
      const workflow: GeneratedWorkflow = {
        name: 'Scraper Workflow',
        description: 'Uses template',
        steps: [{
          step_name: 'Custom Scrape',
          step_type: 'scraping',
          ai_model: '',
          prompt_template: '',
          output_format: 'text',
          from_template_id: 3,
          from_step_order: 1,
          override_fields: ['step_name'],
        }],
        requiredInputs: [],
      };

      await saveWorkflowAsRecipe(workflow, 1, false);

      expect(mockGetStepsByRecipeId).toHaveBeenCalledWith(3);

      // step_name is overridden by AI ('Custom Scrape')
      // But api_config, executor_config, input_config come from template
      expect(mockCreateStep).toHaveBeenCalledWith(
        42, 1, 'Custom Scrape',
        null,  // ai_model from template (null for scraping)
        null,  // prompt_template from template (null for scraping)
        expect.stringContaining('url_list'),  // input_config from template
        'text',  // output_format from template
        null,  // model_config from template
        'scraping',  // step_type from template
        expect.stringContaining('brightdata'),  // api_config from template
        expect.stringContaining('amazon'),  // executor_config from template
      );
    });

    test('applies only override_fields from AI, keeps rest from template', async () => {
      const workflow: GeneratedWorkflow = {
        name: 'Custom Analysis',
        description: 'Override prompt only',
        steps: [{
          step_name: 'Analyze Style',
          step_type: 'ai',
          ai_model: 'claude-opus-4-5',
          prompt_template: 'My custom prompt',
          output_format: 'text',
          from_template_id: 1,
          from_step_order: 1,
          override_fields: ['prompt_template'],  // only prompt is overridden
        }],
        requiredInputs: [],
      };

      await saveWorkflowAsRecipe(workflow, 1, false);

      expect(mockCreateStep).toHaveBeenCalledWith(
        42, 1, 'Analyze Style',
        'gpt-4o',  // ai_model from TEMPLATE (not the AI's 'claude-opus-4-5')
        'My custom prompt',  // prompt_template from AI (overridden)
        expect.stringContaining('image'),  // input_config from template
        'text',
        expect.stringContaining('0.3'),  // model_config from template
        'ai',
        null,
        null,
      );
    });

    test('falls back to AI values when template step not found', async () => {
      // Template 99 doesn't exist
      mockGetStepsByRecipeId.mockImplementation((id: number) => {
        if (id === 99) return [];
        return [];
      });

      const workflow: GeneratedWorkflow = {
        name: 'Missing Template',
        description: 'Template step missing',
        steps: [{
          step_name: 'Ghost Step',
          step_type: 'ai',
          ai_model: 'gpt-4o',
          prompt_template: 'Fallback prompt',
          output_format: 'text',
          from_template_id: 99,
          from_step_order: 1,
          override_fields: [],
        }],
        requiredInputs: [],
      };

      await saveWorkflowAsRecipe(workflow, 1, false);

      // Should use AI-provided values since template not found
      expect(mockCreateStep).toHaveBeenCalledWith(
        42, 1, 'Ghost Step', 'gpt-4o', 'Fallback prompt',
        null, 'text', null, 'ai', null, null
      );
    });

    test('preserves template input_config and does not regenerate it', async () => {
      const workflow: GeneratedWorkflow = {
        name: 'Template Input Config',
        description: 'Test',
        steps: [{
          step_name: 'Scrape',
          step_type: 'scraping',
          ai_model: '',
          prompt_template: '',
          output_format: 'text',
          from_template_id: 3,
          from_step_order: 1,
          override_fields: [],
        }],
        requiredInputs: [{ name: 'product_urls', type: 'url_list', description: 'URLs' }],
      };

      await saveWorkflowAsRecipe(workflow, 1, false);

      // input_config should come from template, NOT regenerated from requiredInputs
      const createStepCall = mockCreateStep.mock.calls[0];
      const inputConfig = createStepCall[5];
      expect(inputConfig).toContain('url_list');  // from template
    });

    test('builds input_config from requiredInputs for from-scratch steps', async () => {
      const workflow: GeneratedWorkflow = {
        name: 'Scratch Workflow',
        description: 'No template',
        steps: [{
          step_name: 'Process',
          step_type: 'ai',
          ai_model: 'gpt-4o',
          prompt_template: 'Process {{user_data}} for {{purpose}}',
          output_format: 'text',
        }],
        requiredInputs: [
          { name: 'user_data', type: 'textarea', description: 'Data to process' },
          { name: 'purpose', type: 'text', description: 'Purpose of processing' },
        ],
      };

      await saveWorkflowAsRecipe(workflow, 1, false);

      const createStepCall = mockCreateStep.mock.calls[0];
      const inputConfig = JSON.parse(createStepCall[5]);
      expect(inputConfig.variables.user_data).toEqual({ type: 'textarea', description: 'Data to process' });
      expect(inputConfig.variables.purpose).toEqual({ type: 'text', description: 'Purpose of processing' });
    });

    test('handles multi-step workflow with mixed template and scratch steps', async () => {
      const workflow: GeneratedWorkflow = {
        name: 'Hybrid Workflow',
        description: 'Mix of template and scratch steps',
        steps: [
          {
            step_name: 'Scrape Reviews',
            step_type: 'scraping',
            ai_model: '',
            prompt_template: '',
            output_format: 'text',
            from_template_id: 3,
            from_step_order: 1,
            override_fields: [],
          },
          {
            step_name: 'Deduplicate',
            step_type: 'script',
            ai_model: '',
            prompt_template: '',
            output_format: 'json',
            executor_config: { language: 'python', code: 'dedupe(data)' },
            // No from_template_id — generated from scratch
          },
          {
            step_name: 'Analyze',
            step_type: 'ai',
            ai_model: '',
            prompt_template: 'Custom analysis prompt for {{step_2_output}}',
            output_format: 'text',
            from_template_id: 1,
            from_step_order: 1,
            override_fields: ['prompt_template'],
          },
        ],
        requiredInputs: [{ name: 'product_urls', type: 'url_list', description: 'URLs' }],
      };

      await saveWorkflowAsRecipe(workflow, 1, false);

      expect(mockCreateStep).toHaveBeenCalledTimes(3);

      // Step 1: template-sourced scraping step
      expect(mockCreateStep.mock.calls[0][8]).toBe('scraping');  // step_type from template
      expect(mockCreateStep.mock.calls[0][9]).toContain('brightdata');  // api_config from template

      // Step 2: from-scratch script step
      expect(mockCreateStep.mock.calls[1][8]).toBe('script');
      expect(mockCreateStep.mock.calls[1][9]).toBeNull();  // no api_config
      expect(mockCreateStep.mock.calls[1][10]).toContain('python');  // executor_config from AI

      // Step 3: template-sourced AI step with overridden prompt
      expect(mockCreateStep.mock.calls[2][4]).toBe('Custom analysis prompt for {{step_2_output}}');  // overridden prompt
      expect(mockCreateStep.mock.calls[2][3]).toBe('gpt-4o');  // ai_model from template (not overridden)
    });
  });

  // =========================================================================
  // Two-pass template detail injection
  // =========================================================================
  describe('Two-pass — template detail injection', () => {

    test('injects full template step configs (api_config, executor_config) into second call', async () => {
      // First call: AI requests template 3
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: '```template-request\n[3]\n```',
        model: 'gpt-4o',
      });

      // Second call: returns workflow
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: '```workflow-json\n' + JSON.stringify({
          name: 'Test', description: 'Test',
          steps: [{ step_name: 'S', step_type: 'scraping', ai_model: '', prompt_template: '', output_format: 'text', from_template_id: 3, from_step_order: 1 }],
          requiredInputs: [],
        }) + '\n```',
        model: 'gpt-4o',
      });

      await generateWorkflow([{ role: 'user', content: 'scrape reviews' }], 1);

      // Verify template details were injected into the second call
      const secondCallMessages = mockCallAI.mock.calls[1][2]?.messages as any[];
      const detailMessage = secondCallMessages.find((m: any) => m.content.includes('Template ID 3'));
      expect(detailMessage).toBeDefined();
      expect(detailMessage.content).toContain('brightdata');
      expect(detailMessage.content).toContain('scrape_reviews');
      expect(detailMessage.content).toContain('amazon');
    });

    test('parses JSON configs in template details (api_config, executor_config)', async () => {
      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: '```template-request\n[3]\n```',
        model: 'gpt-4o',
      });

      mockCallAI.mockResolvedValueOnce({
        success: true,
        content: 'No workflow generated.',
        model: 'gpt-4o',
      });

      await generateWorkflow([{ role: 'user', content: 'test' }], 1);

      const secondCallMessages = mockCallAI.mock.calls[1][2]?.messages as any[];
      const detailMessage = secondCallMessages[secondCallMessages.length - 1];

      // api_config and executor_config should be parsed JSON objects in the detail text
      // (not stringified JSON inside stringified JSON)
      expect(detailMessage.content).toContain('"service": "brightdata"');
      expect(detailMessage.content).toContain('"source": "amazon"');
    });
  });
});

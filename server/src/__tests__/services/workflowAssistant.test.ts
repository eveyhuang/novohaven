import { callAIByModel } from '../../services/aiService';
import {
  generateWorkflow,
  saveWorkflowAsRecipe,
  saveWorkflowGraph,
  ConversationMessage,
  GeneratedWorkflow,
} from '../../services/workflowAssistant';

jest.mock('../../services/aiService', () => ({
  callAIByModel: jest.fn(),
  getAvailableModels: jest.fn().mockReturnValue([
    { id: 'gpt-5', name: 'GPT-5', provider: 'openai', maxTokens: 128000, supportsImageGeneration: false },
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
    {
      type: 'browser',
      displayName: 'Browser Automation',
      icon: '🖥️',
      description: 'Browser extraction',
      getConfigSchema: () => ({ fields: [{ name: 'startUrl', type: 'text', label: 'Start URL', required: false }] }),
    },
  ]),
}));

const mockSkills = jest.fn();
const mockSkillSteps = jest.fn();
const mockInsertWorkflow = jest.fn();
const mockInsertSkill = jest.fn();
const mockInsertStep = jest.fn();

let nextId = 100;

function resetDbMocks() {
  nextId = 100;
  mockSkills.mockReset();
  mockSkillSteps.mockReset();
  mockInsertWorkflow.mockReset();
  mockInsertSkill.mockReset();
  mockInsertStep.mockReset();

  mockSkills.mockReturnValue([
    { id: 1, name: 'Amazon Review Extractor', description: 'Collect reviews from Amazon' },
    { id: 2, name: 'Listing Writer', description: 'Write listing bullets' },
  ]);

  mockSkillSteps.mockImplementation((skillId: number) => {
    if (skillId === 1) {
      return [{
        step_order: 1,
        step_name: 'Extract Reviews',
        step_type: 'browser',
        ai_model: null,
        prompt_template: '',
        output_format: 'json',
        input_config: JSON.stringify({ variables: { product_urls: { type: 'url_list' } } }),
        model_config: '{}',
        executor_config: JSON.stringify({ startUrl: '{{product_urls}}', actions: [{ type: 'extract', selector: '.review' }] }),
        api_config: JSON.stringify({ service: 'brightdata', endpoint: 'scrape_reviews' }),
      }];
    }
    if (skillId === 2) {
      return [{
        step_order: 1,
        step_name: 'Draft Listing',
        step_type: 'ai',
        ai_model: 'gpt-5',
        prompt_template: 'Draft bullets from {{step_1_output}}',
        output_format: 'markdown',
        input_config: JSON.stringify({ variables: { product_name: { type: 'text' } } }),
        model_config: JSON.stringify({ temperature: 0.3 }),
        executor_config: '{}',
        api_config: null,
      }];
    }
    return [];
  });

  mockInsertWorkflow.mockImplementation(() => ({ lastInsertRowid: ++nextId }));
  mockInsertSkill.mockImplementation(() => ({ lastInsertRowid: ++nextId }));
  mockInsertStep.mockImplementation(() => ({ lastInsertRowid: ++nextId }));
}

jest.mock('../../models/database', () => ({
  getDatabase: jest.fn(() => ({
    transaction: (fn: any) => fn,
    prepare: (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      if (normalized.startsWith('SELECT id, name, description FROM skills WHERE created_by = ?')) {
        return { all: (userId: number) => mockSkills(userId) };
      }
      if (normalized.startsWith("SELECT step_type FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill'")) {
        return { all: (skillId: number) => mockSkillSteps(skillId).map((s: any) => ({ step_type: s.step_type })) };
      }
      if (normalized.startsWith("SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill' ORDER BY step_order")) {
        return { all: (skillId: number) => mockSkillSteps(skillId) };
      }
      if (normalized.startsWith("SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill' AND step_order = ?")) {
        return {
          get: (skillId: number, stepOrder: number) => {
            const rows = mockSkillSteps(skillId);
            return rows.find((row: any) => row.step_order === stepOrder) || null;
          },
        };
      }
      if (normalized.startsWith('INSERT INTO workflows')) {
        return { run: (...args: any[]) => mockInsertWorkflow(...args) };
      }
      if (normalized.startsWith('INSERT INTO skills')) {
        return { run: (...args: any[]) => mockInsertSkill(...args) };
      }
      if (normalized.startsWith('INSERT INTO skill_steps')) {
        return { run: (...args: any[]) => mockInsertStep(...args) };
      }

      throw new Error(`Unhandled SQL in test mock: ${sql}`);
    },
  })),
}));

const mockCallAI = callAIByModel as jest.MockedFunction<typeof callAIByModel>;

describe('WorkflowAssistant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetDbMocks();
  });

  test('returns starter suggestions when no messages are provided', async () => {
    const result = await generateWorkflow([], 1);

    expect(result.workflow).toBeUndefined();
    expect(result.message).toContain('Please describe');
    expect(result.suggestions).toBeDefined();
    expect(mockCallAI).not.toHaveBeenCalled();
  });

  test('appends formatting reminder to the final user message', async () => {
    mockCallAI.mockResolvedValueOnce({
      success: true,
      model: 'gpt-5',
      content: '```workflow-json\n{"name":"W","description":"D","steps":[],"requiredInputs":[]}\n```',
    });

    const messages: ConversationMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ];
    await generateWorkflow(messages, 1);

    const call = mockCallAI.mock.calls[0];
    const sentMessages = call[2]?.messages || [];
    expect(sentMessages[0].content).toBe('first');
    expect(sentMessages[2].content).toContain('third');
    expect(sentMessages[2].content).toContain('workflow-json');
  });

  test('runs a two-pass flow when AI requests skill details', async () => {
    mockCallAI.mockResolvedValueOnce({
      success: true,
      model: 'gpt-5',
      content: 'I need details.\n```skill-request\n[1]\n```',
    });
    mockCallAI.mockResolvedValueOnce({
      success: true,
      model: 'gpt-5',
      content: '```workflow-json\n{"name":"Review Flow","description":"d","steps":[{"step_name":"Extract","step_type":"browser","ai_model":"","prompt_template":"","output_format":"json","from_skill_id":1,"from_step_order":1}],"requiredInputs":[{"name":"product_urls","type":"url_list","description":"URLs"}]}\n```',
    });

    const result = await generateWorkflow([{ role: 'user', content: 'extract amazon reviews' }], 1);

    expect(mockCallAI).toHaveBeenCalledTimes(2);
    const secondCallMessages = mockCallAI.mock.calls[1][2]?.messages as any[];
    const detailMessage = secondCallMessages[secondCallMessages.length - 1];
    expect(detailMessage.content).toContain('Skill ID 1');
    expect(detailMessage.content).toContain('brightdata');
    expect(result.workflow?.steps[0].from_skill_id).toBe(1);
    expect(result.workflow?.steps[0].from_template_id).toBe(1);
  });

  test('throws when second pass fails after skill request', async () => {
    mockCallAI.mockResolvedValueOnce({
      success: true,
      model: 'gpt-5',
      content: '```skill-request\n[1]\n```',
    });
    mockCallAI.mockResolvedValueOnce({
      success: false,
      model: 'gpt-5',
      content: '',
      error: 'Service unavailable',
    });

    await expect(
      generateWorkflow([{ role: 'user', content: 'build review workflow' }], 1)
    ).rejects.toThrow('Service unavailable');
  });

  test('keeps skillRequest/templateRequest when requested skill has no steps', async () => {
    mockCallAI.mockResolvedValueOnce({
      success: true,
      model: 'gpt-5',
      content: '```skill-request\n[999]\n```',
    });

    const result = await generateWorkflow([{ role: 'user', content: 'do something' }], 1);

    expect(mockCallAI).toHaveBeenCalledTimes(1);
    expect(result.skillRequest).toEqual([999]);
    expect(result.templateRequest).toEqual([999]);
  });

  test('saveWorkflowAsRecipe persists scratch AI step with inferred input_config', async () => {
    const workflow: GeneratedWorkflow = {
      name: 'Scratch Workflow',
      description: 'No skill source',
      steps: [{
        step_name: 'Analyze',
        step_type: 'ai',
        ai_model: 'gpt-5',
        prompt_template: 'Analyze {{review_text}}',
        output_format: 'text',
      }],
      requiredInputs: [{ name: 'review_text', type: 'textarea', description: 'Review text' }],
    };

    const saved = await saveWorkflowAsRecipe(workflow, 1, false);

    expect(saved.recipeId).toBeGreaterThan(0);
    expect(mockInsertWorkflow).toHaveBeenCalledWith('Scratch Workflow', 'No skill source', 1, '[]');
    const args = mockInsertStep.mock.calls[0];
    expect(args[1]).toBe('workflow');
    expect(args[4]).toBe('ai');
    expect(args[5]).toBe('gpt-5');
    expect(args[6]).toContain('{{review_text}}');
    expect(args[7]).toContain('review_text');
  });

  test('saveWorkflowAsRecipe merges source skill config and applies only overrides', async () => {
    const workflow: GeneratedWorkflow = {
      name: 'Hybrid Workflow',
      description: 'Reuse skill step',
      steps: [{
        step_name: 'Custom Draft',
        step_type: 'ai',
        ai_model: 'claude-opus-4-6',
        prompt_template: 'Use {{step_1_output}} with new tone',
        output_format: 'markdown',
        from_skill_id: 2,
        from_step_order: 1,
        override_fields: ['prompt_template'],
      }],
      requiredInputs: [{ name: 'product_name', type: 'text', description: 'name' }],
    };

    await saveWorkflowAsRecipe(workflow, 1, false);

    const args = mockInsertStep.mock.calls[0];
    expect(args[4]).toBe('ai');
    // from source skill, not the override payload
    expect(args[5]).toBe('gpt-5');
    // overridden
    expect(args[6]).toBe('Use {{step_1_output}} with new tone');
    expect(args[7]).toContain('product_name');
    expect(args[8]).toBe('markdown');
  });

  test('saveWorkflowGraph blocks unsupported manus steps when saving as skill', async () => {
    const workflow: GeneratedWorkflow = {
      name: 'Unsupported Skill',
      description: 'bad step type',
      steps: [{
        step_name: 'Legacy Manus',
        step_type: 'manus',
        ai_model: '',
        prompt_template: '',
        output_format: 'text',
      }],
      requiredInputs: [],
    };

    await expect(saveWorkflowGraph(workflow, 1, true)).rejects.toThrow(
      'Step type "manus" is no longer supported for skills'
    );
    expect(mockInsertSkill).not.toHaveBeenCalled();
  });
});

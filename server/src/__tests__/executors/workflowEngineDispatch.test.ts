/**
 * Tests that the workflow engine correctly dispatches step execution
 * to the executor registry, and that the orchestration logic
 * (status updates, auto-run, pause-for-review, error handling) works correctly.
 */

// Mock the executor registry
const mockExecute = jest.fn();
const mockGetExecutor = jest.fn();

jest.mock('../../executors/registry', () => ({
  getExecutor: mockGetExecutor,
}));

// Mock the database queries
const mockQueries = {
  getExecutionById: jest.fn(),
  getStepExecutionsByExecutionId: jest.fn(),
  getStepsByRecipeId: jest.fn(),
  createExecution: jest.fn(),
  createStepExecution: jest.fn(),
  updateStepExecution: jest.fn(),
  updateExecutionStatus: jest.fn(),
  completeExecution: jest.fn(),
  setStepExecutionError: jest.fn(),
  approveStepExecution: jest.fn(),
  getStepExecutionById: jest.fn(),
  getStepById: jest.fn(),
};

jest.mock('../../models/database', () => ({
  queries: mockQueries,
}));

// Mock the execution events emitter
const mockEmit = jest.fn();
const mockCreateMessage = jest.fn().mockImplementation((partial: any) => ({
  ...partial,
  id: 'test-msg-id',
  timestamp: '2024-01-01T00:00:00.000Z',
}));
const mockCleanup = jest.fn();

jest.mock('../../services/executionEvents', () => ({
  executionEvents: {
    emit: mockEmit,
    createMessage: mockCreateMessage,
    cleanup: mockCleanup,
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    isActive: jest.fn().mockReturnValue(true),
  },
}));

import { startExecution, approveStep, retryStep } from '../../services/workflowEngine';
import { RecipeStep, StepExecution, WorkflowExecution } from '../../types';

describe('Workflow Engine - Executor Dispatch', () => {
  const mockAIExecutor = {
    type: 'ai',
    displayName: 'AI Model',
    icon: '🤖',
    description: 'AI',
    execute: mockExecute,
    validateConfig: jest.fn(),
    getConfigSchema: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Default: registry returns our mock executor for 'ai'
    mockGetExecutor.mockImplementation((type: string) => {
      if (type === 'ai') return mockAIExecutor;
      return undefined;
    });

    // Default successful execution
    mockExecute.mockResolvedValue({
      success: true,
      content: 'AI output',
      metadata: { model: 'gpt-4o', usage: { promptTokens: 10, completionTokens: 20 } },
      promptUsed: 'compiled prompt',
      modelUsed: 'gpt-4o',
    });
  });

  describe('startExecution', () => {
    const steps: RecipeStep[] = [{
      id: 1,
      recipe_id: 1,
      step_order: 1,
      step_name: 'AI Step',
      step_type: 'ai',
      ai_model: 'gpt-4o',
      prompt_template: 'Test {{input}}',
      output_format: 'text',
      created_at: '2024-01-01',
    }];

    beforeEach(() => {
      mockQueries.getStepsByRecipeId.mockReturnValue(steps);
      mockQueries.createExecution.mockReturnValue({ lastInsertRowid: 100 });

      // For single AI step: first call returns pending, second call (after auto-approve) returns no pending
      mockQueries.getStepExecutionsByExecutionId
        .mockReturnValueOnce([{
          id: 1, execution_id: 100, step_id: 1, step_order: 1,
          status: 'pending', approved: false,
        }])
        .mockReturnValue([{
          id: 1, execution_id: 100, step_id: 1, step_order: 1,
          status: 'completed', approved: true,
          output_data: JSON.stringify({ content: 'AI output' }),
        }]);

      mockQueries.getExecutionById.mockReturnValue({
        id: 100,
        recipe_id: 1,
        user_id: 1,
        status: 'pending',
        current_step: 0,
      });
    });

    test('dispatches to the correct executor based on step_type', async () => {
      await startExecution(1, 1, { input: 'test' });

      expect(mockGetExecutor).toHaveBeenCalledWith('ai');
      expect(mockExecute).toHaveBeenCalled();
    });

    test('falls back to AI executor for unknown step types', async () => {
      const unknownSteps: RecipeStep[] = [{
        ...steps[0],
        step_type: 'unknown_type' as any,
      }];
      mockQueries.getStepsByRecipeId.mockReturnValue(unknownSteps);

      await startExecution(1, 1, { input: 'test' });

      // First tries 'unknown_type', gets undefined, then falls back to 'ai'
      expect(mockGetExecutor).toHaveBeenCalledWith('unknown_type');
      expect(mockGetExecutor).toHaveBeenCalledWith('ai');
    });

    test('falls back to AI executor when step_type is undefined', async () => {
      const noTypeSteps: RecipeStep[] = [{
        ...steps[0],
        step_type: undefined as any,
      }];
      mockQueries.getStepsByRecipeId.mockReturnValue(noTypeSteps);

      await startExecution(1, 1, { input: 'test' });

      // Should default to 'ai' when step_type is falsy
      expect(mockGetExecutor).toHaveBeenCalledWith('ai');
    });

    test('AI steps auto-approve and complete execution', async () => {
      const result = await startExecution(1, 1, { input: 'test' });

      // AI steps auto-approve — should call approveStepExecution
      expect(mockQueries.approveStepExecution).toHaveBeenCalledWith(true, 'completed', 1);
      // After auto-approve, no more pending steps → execution completes
      expect(result.status).toBe('completed');
      expect(mockQueries.completeExecution).toHaveBeenCalledWith('completed', 100);
    });

    test('emits step-start event before executing', async () => {
      await startExecution(1, 1, { input: 'test' });

      const stepStartCall = mockCreateMessage.mock.calls.find(
        (call: any[]) => call[0].type === 'step-start'
      );
      expect(stepStartCall).toBeDefined();
      expect(stepStartCall![0].stepName).toBe('AI Step');
    });

    test('emits step-output event after successful execution', async () => {
      await startExecution(1, 1, { input: 'test' });

      const stepOutputCall = mockCreateMessage.mock.calls.find(
        (call: any[]) => call[0].type === 'step-output'
      );
      expect(stepOutputCall).toBeDefined();
      expect(stepOutputCall![0].content).toBe('AI output');
    });

    test('emits step-approved event for auto-run steps', async () => {
      await startExecution(1, 1, { input: 'test' });

      const approvedCall = mockCreateMessage.mock.calls.find(
        (call: any[]) => call[0].type === 'step-approved'
      );
      expect(approvedCall).toBeDefined();
      expect(approvedCall![0].content).toContain('auto-approved');
    });

    test('emits execution-complete when all steps done', async () => {
      await startExecution(1, 1, { input: 'test' });

      const completeCall = mockCreateMessage.mock.calls.find(
        (call: any[]) => call[0].type === 'execution-complete'
      );
      expect(completeCall).toBeDefined();
    });

    test('sets step error and pauses on executor failure', async () => {
      mockExecute.mockResolvedValue({
        success: false,
        content: '',
        error: 'Model overloaded',
      });

      const result = await startExecution(1, 1, { input: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Model overloaded');
      expect(mockQueries.setStepExecutionError).toHaveBeenCalledWith(
        'failed',
        'Model overloaded',
        1
      );
    });

    test('emits step-error event on executor failure', async () => {
      mockExecute.mockResolvedValue({
        success: false,
        content: '',
        error: 'Model overloaded',
      });

      await startExecution(1, 1, { input: 'test' });

      const errorCall = mockCreateMessage.mock.calls.find(
        (call: any[]) => call[0].type === 'step-error'
      );
      expect(errorCall).toBeDefined();
      expect(errorCall![0].content).toBe('Model overloaded');
    });

    test('handles executor throwing an exception', async () => {
      mockExecute.mockRejectedValue(new Error('Connection timeout'));

      const result = await startExecution(1, 1, { input: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection timeout');
      expect(mockQueries.setStepExecutionError).toHaveBeenCalledWith(
        'failed',
        'Connection timeout',
        1
      );
    });

    test('stores executor output in correct JSON format', async () => {
      mockExecute.mockResolvedValue({
        success: true,
        content: 'result text',
        metadata: { model: 'gpt-4o', custom_field: 'value' },
        promptUsed: 'the prompt',
        modelUsed: 'gpt-4o',
      });

      await startExecution(1, 1, { input: 'test' });

      const storedOutput = mockQueries.updateStepExecution.mock.calls.find(
        (call: any[]) => call[0] === 'completed'
      );
      expect(storedOutput).toBeDefined();
      const parsed = JSON.parse(storedOutput![1]);
      expect(parsed.content).toBe('result text');
      expect(parsed.model).toBe('gpt-4o');
      expect(parsed.custom_field).toBe('value');
    });

    test('returns error when recipe has no steps', async () => {
      mockQueries.getStepsByRecipeId.mockReturnValue([]);

      const result = await startExecution(1, 1, { input: 'test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Recipe has no steps');
    });

    test('passes correct context to executor including emitter', async () => {
      await startExecution(1, 1, { input: 'test_value' });

      expect(mockExecute).toHaveBeenCalledWith(
        steps[0],
        expect.objectContaining({
          userId: 1,
          executionId: 100,
          userInputs: { input: 'test_value' },
          completedStepExecutions: [],
          emitter: expect.anything(),
        })
      );
    });
  });

  describe('interactive steps (scraping/manus)', () => {
    const mockScrapingExecutor = {
      type: 'scraping',
      displayName: 'Web Scraping',
      icon: '🔍',
      description: 'Scraping',
      execute: jest.fn().mockResolvedValue({
        success: true,
        content: JSON.stringify({ reviews: [] }),
        metadata: { service: 'browser', stepType: 'scraping' },
        promptUsed: 'Scraped 1 URL(s)',
        modelUsed: 'browser:scrape',
      }),
      validateConfig: jest.fn(),
      getConfigSchema: jest.fn(),
    };

    beforeEach(() => {
      mockGetExecutor.mockImplementation((type: string) => {
        if (type === 'ai') return mockAIExecutor;
        if (type === 'scraping') return mockScrapingExecutor;
        return undefined;
      });

      const scrapingSteps: RecipeStep[] = [{
        id: 2,
        recipe_id: 1,
        step_order: 1,
        step_name: 'Scrape Step',
        step_type: 'scraping',
        ai_model: '',
        prompt_template: '',
        output_format: 'json',
        created_at: '2024-01-01',
      }];

      mockQueries.getStepsByRecipeId.mockReturnValue(scrapingSteps);
      mockQueries.createExecution.mockReturnValue({ lastInsertRowid: 200 });
      mockQueries.getStepExecutionsByExecutionId.mockReturnValue([{
        id: 2, execution_id: 200, step_id: 2, step_order: 1,
        status: 'pending', approved: false,
      }]);
      mockQueries.getExecutionById.mockReturnValue({
        id: 200, recipe_id: 1, user_id: 1, status: 'pending', current_step: 0,
      });
    });

    test('dispatches scraping steps to ScrapingExecutor', async () => {
      await startExecution(1, 1, { product_urls: 'https://amazon.com/p1' });

      expect(mockGetExecutor).toHaveBeenCalledWith('scraping');
      expect(mockScrapingExecutor.execute).toHaveBeenCalled();
      expect(mockAIExecutor.execute).not.toHaveBeenCalled();
    });

    test('scraping steps pause for review (do NOT auto-approve)', async () => {
      const result = await startExecution(1, 1, { product_urls: 'https://amazon.com/p1' });

      expect(result.status).toBe('paused');
      // Should set awaiting_review, not completed
      expect(mockQueries.updateStepExecution).toHaveBeenCalledWith(
        'awaiting_review',
        expect.any(String),
        'browser:scrape',
        'Scraped 1 URL(s)',
        2
      );
      // Should NOT auto-approve
      expect(mockQueries.approveStepExecution).not.toHaveBeenCalled();
    });

    test('scraping steps emit action-required event', async () => {
      await startExecution(1, 1, { product_urls: 'https://amazon.com/p1' });

      const actionCall = mockCreateMessage.mock.calls.find(
        (call: any[]) => call[0].type === 'action-required'
      );
      expect(actionCall).toBeDefined();
      expect(actionCall![0].metadata?.actionType).toBe('approve');
    });
  });

  describe('retryStep', () => {
    beforeEach(() => {
      mockQueries.getExecutionById.mockReturnValue({
        id: 100,
        recipe_id: 1,
        user_id: 1,
        status: 'paused',
        current_step: 1,
        input_data: JSON.stringify({ input: 'original' }),
      } as WorkflowExecution);

      mockQueries.getStepExecutionById.mockReturnValue({
        id: 10,
        execution_id: 100,
        step_id: 1,
        step_order: 1,
        status: 'failed',
        approved: false,
      } as StepExecution);

      mockQueries.getStepById.mockReturnValue({
        id: 1,
        recipe_id: 1,
        step_order: 1,
        step_name: 'AI Step',
        step_type: 'ai',
        ai_model: 'gpt-4o',
        prompt_template: 'Original prompt {{input}}',
        output_format: 'text',
        created_at: '2024-01-01',
      } as RecipeStep);

      mockQueries.getStepExecutionsByExecutionId.mockReturnValue([{
        id: 10,
        execution_id: 100,
        step_id: 1,
        step_order: 1,
        status: 'running',
        approved: false,
      }]);

      mockQueries.getStepsByRecipeId.mockReturnValue([{
        id: 1, recipe_id: 1, step_order: 1, step_name: 'AI Step',
        step_type: 'ai', ai_model: 'gpt-4o', prompt_template: 'prompt',
        output_format: 'text', created_at: '2024-01-01',
      }]);
    });

    test('dispatches retry to executor via registry', async () => {
      await retryStep(100, 10, 1);

      expect(mockGetExecutor).toHaveBeenCalledWith('ai');
      expect(mockExecute).toHaveBeenCalled();
    });

    test('uses modified prompt when provided', async () => {
      await retryStep(100, 10, 1, 'Modified prompt text');

      const executedStep = mockExecute.mock.calls[0][0];
      expect(executedStep.prompt_template).toBe('Modified prompt text');
    });

    test('uses original step when no modified prompt', async () => {
      await retryStep(100, 10, 1);

      const executedStep = mockExecute.mock.calls[0][0];
      expect(executedStep.prompt_template).toBe('Original prompt {{input}}');
    });

    test('handles executor failure during retry', async () => {
      mockExecute.mockResolvedValue({
        success: false,
        content: '',
        error: 'Retry failed',
      });

      const result = await retryStep(100, 10, 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Retry failed');
    });
  });
});

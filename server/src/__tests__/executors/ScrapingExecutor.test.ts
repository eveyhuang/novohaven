import { ScrapingExecutor } from '../../executors/ScrapingExecutor';
import { RecipeStep, StepExecution } from '../../types';
import { StepExecutorContext } from '../../executors/StepExecutor';

// Mock dependencies
jest.mock('../../services/browserService', () => {
  const mockEmitter = { on: jest.fn(), once: jest.fn(), emit: jest.fn(), removeListener: jest.fn() };
  return {
    browserService: {
      createTask: jest.fn().mockReturnValue('browser-task-123'),
      getTask: jest.fn().mockReturnValue({ id: 'browser-task-123', emitter: mockEmitter, status: 'running' }),
      launchBrowser: jest.fn().mockResolvedValue({}),
      detectCaptcha: jest.fn().mockResolvedValue(false),
      waitForCaptchaResolution: jest.fn(),
      emit: jest.fn(),
      destroyTask: jest.fn().mockResolvedValue(undefined),
    },
  };
});

jest.mock('../../services/extractionStrategies', () => ({
  getStrategy: jest.fn(),
  getAllStrategies: jest.fn().mockReturnValue([
    { platform: 'wayfair', displayName: 'Wayfair Reviews' },
  ]),
}));

jest.mock('../../services/usageTrackingService', () => ({
  logUsage: jest.fn(),
}));

jest.mock('../../models/database', () => ({
  queries: {
    updateStepExecution: jest.fn(),
  },
}));

import { browserService } from '../../services/browserService';
import { getStrategy } from '../../services/extractionStrategies';
import { logUsage } from '../../services/usageTrackingService';

const mockBrowserService = browserService as jest.Mocked<typeof browserService>;
const mockGetStrategy = getStrategy as jest.MockedFunction<typeof getStrategy>;
const mockLogUsage = logUsage as jest.MockedFunction<typeof logUsage>;

describe('ScrapingExecutor', () => {
  let executor: ScrapingExecutor;
  let mockStep: RecipeStep;
  let mockContext: StepExecutorContext;

  beforeEach(() => {
    executor = new ScrapingExecutor();
    jest.clearAllMocks();

    mockStep = {
      id: 1,
      recipe_id: 1,
      step_order: 1,
      step_name: 'Scrape Data',
      step_type: 'scraping',
      ai_model: '',
      prompt_template: '',
      output_format: 'json',
      input_config: JSON.stringify({
        variables: { urls: { type: 'textarea' } },
      }),
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
      userInputs: {
        platform: 'wayfair',
        urls: 'https://www.wayfair.com/product/test-123.html',
      },
      completedStepExecutions: [],
    };
  });

  describe('type and metadata', () => {
    test('has correct type identifier', () => {
      expect(executor.type).toBe('scraping');
    });

    test('has display name mentioning Browser', () => {
      expect(executor.displayName).toContain('Browser');
    });

    test('has an icon', () => {
      expect(executor.icon).toBeTruthy();
    });

    test('has description mentioning browser automation', () => {
      expect(executor.description.toLowerCase()).toContain('browser');
    });
  });

  describe('validateConfig', () => {
    test('returns valid when input_config is present', () => {
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(true);
    });

    test('returns error when input_config is missing', () => {
      mockStep.input_config = undefined;
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('execute', () => {
    test('completes a browser task successfully', async () => {
      const mockStrategy = {
        platform: 'wayfair',
        displayName: 'Wayfair Reviews',
        execute: jest.fn().mockResolvedValue({
          success: true,
          data: { reviews: [{ name: 'Test', rating: 5 }], totalCount: 1 },
          reviewCount: 1,
        }),
      };
      mockGetStrategy.mockReturnValue(mockStrategy);

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(result.content).toContain('reviews');
      expect(result.metadata?.service).toBe('browser');
      expect(result.metadata?.browserTaskId).toBe('browser-task-123');
      expect(result.metadata?.platform).toBe('wayfair');
      expect(result.modelUsed).toBe('browser:scrape');
    });

    test('returns failure when no URLs are provided', async () => {
      mockContext.userInputs = { platform: 'wayfair' };

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No URLs provided');
    });

    test('returns failure when platform is unsupported', async () => {
      mockContext.userInputs.platform = 'ebay';
      mockGetStrategy.mockReturnValue(undefined);

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported platform');
    });

    test('detects platform from URL when not explicitly set', async () => {
      mockContext.userInputs = { urls: 'https://www.wayfair.com/product/test.html' };
      const mockStrategy = {
        platform: 'wayfair',
        displayName: 'Wayfair Reviews',
        execute: jest.fn().mockResolvedValue({
          success: true,
          data: { reviews: [] },
          reviewCount: 0,
        }),
      };
      mockGetStrategy.mockReturnValue(mockStrategy);

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(mockGetStrategy).toHaveBeenCalledWith('wayfair');
    });

    test('handles browser launch error', async () => {
      mockGetStrategy.mockReturnValue({
        platform: 'wayfair',
        displayName: 'Wayfair Reviews',
        execute: jest.fn(),
      });
      mockBrowserService.launchBrowser.mockRejectedValueOnce(new Error('Max concurrent browsers reached'));

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Max concurrent browsers');
    });

    test('handles extraction strategy error', async () => {
      const mockStrategy = {
        platform: 'wayfair',
        displayName: 'Wayfair Reviews',
        execute: jest.fn().mockRejectedValue(new Error('Failed to extract nodeId')),
      };
      mockGetStrategy.mockReturnValue(mockStrategy);

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to extract nodeId');
    });

    test('parses comma-separated URLs', async () => {
      mockContext.userInputs.urls = 'https://url1.com,https://url2.com';
      const mockStrategy = {
        platform: 'wayfair',
        displayName: 'Wayfair Reviews',
        execute: jest.fn().mockResolvedValue({
          success: true,
          data: [],
          reviewCount: 0,
        }),
      };
      mockGetStrategy.mockReturnValue(mockStrategy);

      await executor.execute(mockStep, mockContext);

      const calledUrls = mockStrategy.execute.mock.calls[0][1];
      expect(calledUrls).toHaveLength(2);
      expect(calledUrls).toContain('https://url1.com');
      expect(calledUrls).toContain('https://url2.com');
    });

    test('parses array URLs', async () => {
      mockContext.userInputs.urls = ['https://url1.com', 'https://url2.com'];
      const mockStrategy = {
        platform: 'wayfair',
        displayName: 'Wayfair Reviews',
        execute: jest.fn().mockResolvedValue({
          success: true,
          data: [],
          reviewCount: 0,
        }),
      };
      mockGetStrategy.mockReturnValue(mockStrategy);

      await executor.execute(mockStep, mockContext);

      const calledUrls = mockStrategy.execute.mock.calls[0][1];
      expect(calledUrls).toHaveLength(2);
    });

    test('logs usage with service browser', async () => {
      const mockStrategy = {
        platform: 'wayfair',
        displayName: 'Wayfair Reviews',
        execute: jest.fn().mockResolvedValue({
          success: true,
          data: { reviews: [] },
          reviewCount: 5,
        }),
      };
      mockGetStrategy.mockReturnValue(mockStrategy);

      await executor.execute(mockStep, mockContext);

      expect(mockLogUsage).toHaveBeenCalledWith(
        1,
        'browser',
        'scrape',
        1,
        5,
        expect.objectContaining({ browserTaskId: 'browser-task-123', platform: 'wayfair' })
      );
    });

    test('always destroys browser task in finally block', async () => {
      const mockStrategy = {
        platform: 'wayfair',
        displayName: 'Wayfair Reviews',
        execute: jest.fn().mockRejectedValue(new Error('test error')),
      };
      mockGetStrategy.mockReturnValue(mockStrategy);

      await executor.execute(mockStep, mockContext);

      expect(mockBrowserService.destroyTask).toHaveBeenCalledWith('browser-task-123');
    });
  });

  describe('getConfigSchema', () => {
    test('returns a schema with fields', () => {
      const schema = executor.getConfigSchema();
      expect(schema.fields).toBeDefined();
      expect(schema.fields.length).toBeGreaterThan(0);
    });

    test('includes platform, urls, and maxReviews fields', () => {
      const schema = executor.getConfigSchema();
      const fieldNames = schema.fields.map(f => f.name);
      expect(fieldNames).toContain('platform');
      expect(fieldNames).toContain('urls');
      expect(fieldNames).toContain('maxReviews');
    });

    test('platform field is a select with options', () => {
      const schema = executor.getConfigSchema();
      const platformField = schema.fields.find(f => f.name === 'platform');
      expect(platformField?.type).toBe('select');
      expect(platformField?.options).toBeDefined();
      expect(platformField?.options!.length).toBeGreaterThan(0);
    });

    test('urls field is required', () => {
      const schema = executor.getConfigSchema();
      const urlsField = schema.fields.find(f => f.name === 'urls');
      expect(urlsField?.required).toBe(true);
    });

    test('maxReviews field is optional', () => {
      const schema = executor.getConfigSchema();
      const maxField = schema.fields.find(f => f.name === 'maxReviews');
      expect(maxField?.required).toBe(false);
    });
  });
});

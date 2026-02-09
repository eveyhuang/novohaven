import { ScrapingExecutor } from '../../executors/ScrapingExecutor';
import { RecipeStep, StepExecution } from '../../types';
import { StepExecutorContext } from '../../executors/StepExecutor';

// Mock dependencies
jest.mock('../../services/brightDataService', () => ({
  scrapeReviews: jest.fn(),
  isBrightDataConfigured: jest.fn(),
}));

jest.mock('../../services/csvParserService', () => ({
  parseReviewCSV: jest.fn(),
}));

jest.mock('../../services/usageTrackingService', () => ({
  logUsage: jest.fn(),
}));

jest.mock('../../models/database', () => ({
  queries: {},
}));

import { scrapeReviews, isBrightDataConfigured } from '../../services/brightDataService';
import { parseReviewCSV } from '../../services/csvParserService';
import { logUsage } from '../../services/usageTrackingService';

const mockScrapeReviews = scrapeReviews as jest.MockedFunction<typeof scrapeReviews>;
const mockIsBrightDataConfigured = isBrightDataConfigured as jest.MockedFunction<typeof isBrightDataConfigured>;
const mockParseReviewCSV = parseReviewCSV as jest.MockedFunction<typeof parseReviewCSV>;
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
      step_name: 'Scrape Reviews',
      step_type: 'scraping',
      ai_model: '',
      prompt_template: '',
      output_format: 'json',
      api_config: JSON.stringify({ service: 'brightdata', endpoint: 'scrape_reviews' }),
      input_config: JSON.stringify({
        variables: { product_urls: { type: 'url_list' } },
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
        product_urls: 'https://amazon.com/product1\nhttps://amazon.com/product2',
      },
      completedStepExecutions: [],
    };
  });

  describe('type and metadata', () => {
    test('has correct type identifier', () => {
      expect(executor.type).toBe('scraping');
    });

    test('has display name', () => {
      expect(executor.displayName).toBe('Web Scraping');
    });

    test('has an icon', () => {
      expect(executor.icon).toBeTruthy();
    });
  });

  describe('validateConfig', () => {
    test('returns valid when input_config is present', () => {
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(true);
    });

    test('returns valid when api_config is present', () => {
      mockStep.input_config = undefined;
      mockStep.api_config = JSON.stringify({ service: 'brightdata' });
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(true);
    });

    test('returns error when both input_config and api_config are missing', () => {
      mockStep.input_config = undefined;
      mockStep.api_config = undefined;
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('execute', () => {
    test('scrapes URLs successfully via BrightData', async () => {
      mockIsBrightDataConfigured.mockReturnValue(true);
      mockScrapeReviews.mockResolvedValue({
        success: true,
        data: [{
          url: 'https://amazon.com/product1',
          platform: 'amazon',
          product_name: 'Test Product',
          reviews: [{
            id: 'r1',
            platform: 'amazon',
            product_url: 'https://amazon.com/product1',
            rating: 5,
            review_text: 'Great product!',
          }],
          scraped_at: '2024-01-01',
        }],
        usage: { requests_made: 1, reviews_fetched: 1 },
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(result.content).toBeTruthy();
      const parsed = JSON.parse(result.content);
      expect(parsed.reviews).toHaveLength(1);
      expect(parsed.summary.total_reviews).toBe(1);
    });

    test('returns failure when no URLs or CSV data provided', async () => {
      mockContext.userInputs = {};

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No product URLs or CSV data');
    });

    test('returns failure when BrightData is not configured', async () => {
      mockIsBrightDataConfigured.mockReturnValue(false);

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('BrightData is not configured');
    });

    test('parses URLs from string with newlines', async () => {
      mockIsBrightDataConfigured.mockReturnValue(true);
      mockScrapeReviews.mockResolvedValue({
        success: true,
        data: [],
        usage: { requests_made: 2, reviews_fetched: 0 },
      });

      await executor.execute(mockStep, mockContext);

      expect(mockScrapeReviews).toHaveBeenCalledWith([
        'https://amazon.com/product1',
        'https://amazon.com/product2',
      ]);
    });

    test('parses URLs from array input', async () => {
      mockContext.userInputs.product_urls = [
        'https://amazon.com/p1',
        'https://amazon.com/p2',
      ];
      mockIsBrightDataConfigured.mockReturnValue(true);
      mockScrapeReviews.mockResolvedValue({
        success: true,
        data: [],
        usage: { requests_made: 2, reviews_fetched: 0 },
      });

      await executor.execute(mockStep, mockContext);

      expect(mockScrapeReviews).toHaveBeenCalledWith([
        'https://amazon.com/p1',
        'https://amazon.com/p2',
      ]);
    });

    test('processes CSV data when provided', async () => {
      mockContext.userInputs = {
        csv_data: 'header1,header2\nval1,val2',
      };
      mockParseReviewCSV.mockReturnValue({
        success: true,
        data: [{
          id: 'csv1',
          platform: 'amazon',
          product_url: 'https://amazon.com/p1',
          rating: 4,
          review_text: 'Good',
        }],
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(mockParseReviewCSV).toHaveBeenCalledWith('header1,header2\nval1,val2', undefined);
    });

    test('processes csv_file input format', async () => {
      mockContext.userInputs = {
        csv_file: 'file content here',
      };
      mockParseReviewCSV.mockReturnValue({
        success: true,
        data: [{ id: '1', platform: 'amazon', product_url: 'url', rating: 5, review_text: 'text' }],
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(mockParseReviewCSV).toHaveBeenCalledWith('file content here', undefined);
    });

    test('logs usage after successful scraping', async () => {
      mockIsBrightDataConfigured.mockReturnValue(true);
      mockScrapeReviews.mockResolvedValue({
        success: true,
        data: [],
        usage: { requests_made: 2, reviews_fetched: 10 },
      });

      await executor.execute(mockStep, mockContext);

      expect(mockLogUsage).toHaveBeenCalledWith(1, 'brightdata', 'scrape_reviews', 2, 10);
    });

    test('returns failure when scraping fails and no CSV data', async () => {
      mockIsBrightDataConfigured.mockReturnValue(true);
      mockScrapeReviews.mockResolvedValue({
        success: false,
        error: 'Network error',
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Network error');
    });

    test('uses default api_config when parsing fails', async () => {
      mockStep.api_config = 'invalid json';
      mockIsBrightDataConfigured.mockReturnValue(true);
      mockScrapeReviews.mockResolvedValue({
        success: true,
        data: [],
        usage: { requests_made: 1, reviews_fetched: 0 },
      });

      await executor.execute(mockStep, mockContext);

      // Should still work with defaults
      expect(mockLogUsage).toHaveBeenCalledWith(1, 'brightdata', 'scrape_reviews', 1, 0);
    });

    test('returns metadata with service and usage info', async () => {
      mockIsBrightDataConfigured.mockReturnValue(true);
      mockScrapeReviews.mockResolvedValue({
        success: true,
        data: [],
        usage: { requests_made: 1, reviews_fetched: 5 },
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.metadata?.service).toBe('brightdata');
      expect(result.metadata?.usage).toEqual({ requests_made: 1, reviews_fetched: 5 });
      expect(result.metadata?.stepType).toBe('scraping');
    });

    test('sets modelUsed to service:endpoint format', async () => {
      mockIsBrightDataConfigured.mockReturnValue(true);
      mockScrapeReviews.mockResolvedValue({
        success: true,
        data: [],
        usage: { requests_made: 0, reviews_fetched: 0 },
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.modelUsed).toBe('brightdata:scrape_reviews');
    });
  });

  describe('getConfigSchema', () => {
    test('returns a schema with fields', () => {
      const schema = executor.getConfigSchema();
      expect(schema.fields).toBeDefined();
      expect(schema.fields.length).toBeGreaterThan(0);
    });

    test('includes service and endpoint fields', () => {
      const schema = executor.getConfigSchema();
      const fieldNames = schema.fields.map(f => f.name);
      expect(fieldNames).toContain('service');
      expect(fieldNames).toContain('endpoint');
    });
  });
});

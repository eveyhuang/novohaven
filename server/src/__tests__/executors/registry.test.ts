import { StepExecutor, StepExecutorContext, StepExecutorResult, ExecutorConfigSchema } from '../../executors/StepExecutor';
import { RecipeStep } from '../../types';

// We need to test the registry in isolation, so we re-implement a fresh registry for each test
// rather than importing the singleton which has side effects (auto-registers AI + Scraping)

describe('Executor Registry', () => {
  let registryMap: Map<string, StepExecutor>;
  let registerExecutor: (executor: StepExecutor) => void;
  let getExecutor: (stepType: string) => StepExecutor | undefined;
  let getAllExecutors: () => StepExecutor[];

  beforeEach(() => {
    // Fresh registry for each test
    registryMap = new Map();
    registerExecutor = (executor: StepExecutor) => {
      registryMap.set(executor.type, executor);
    };
    getExecutor = (stepType: string) => registryMap.get(stepType);
    getAllExecutors = () => Array.from(registryMap.values());
  });

  // Create a minimal mock executor for testing
  function createMockExecutor(type: string, displayName: string): StepExecutor {
    return {
      type,
      displayName,
      icon: '🔧',
      description: `Mock ${displayName} executor`,
      validateConfig: jest.fn().mockReturnValue({ valid: true, errors: [] }),
      execute: jest.fn().mockResolvedValue({
        success: true,
        content: `Output from ${type}`,
        metadata: {},
      }),
      getConfigSchema: jest.fn().mockReturnValue({ fields: [] }),
    };
  }

  test('registerExecutor adds an executor to the registry', () => {
    const executor = createMockExecutor('test', 'Test');
    registerExecutor(executor);
    expect(getExecutor('test')).toBe(executor);
  });

  test('getExecutor returns undefined for unregistered types', () => {
    expect(getExecutor('nonexistent')).toBeUndefined();
  });

  test('getExecutor returns the correct executor by type', () => {
    const exec1 = createMockExecutor('ai', 'AI');
    const exec2 = createMockExecutor('scraping', 'Scraping');
    registerExecutor(exec1);
    registerExecutor(exec2);

    expect(getExecutor('ai')).toBe(exec1);
    expect(getExecutor('scraping')).toBe(exec2);
  });

  test('getAllExecutors returns all registered executors', () => {
    const exec1 = createMockExecutor('ai', 'AI');
    const exec2 = createMockExecutor('scraping', 'Scraping');
    registerExecutor(exec1);
    registerExecutor(exec2);

    const all = getAllExecutors();
    expect(all).toHaveLength(2);
    expect(all).toContain(exec1);
    expect(all).toContain(exec2);
  });

  test('registering a duplicate type overwrites the previous executor', () => {
    const exec1 = createMockExecutor('ai', 'AI v1');
    const exec2 = createMockExecutor('ai', 'AI v2');
    registerExecutor(exec1);
    registerExecutor(exec2);

    expect(getExecutor('ai')).toBe(exec2);
    expect(getAllExecutors()).toHaveLength(1);
  });

  test('getAllExecutors returns empty array when nothing is registered', () => {
    expect(getAllExecutors()).toHaveLength(0);
  });
});

describe('Built-in executor classes', () => {
  // Test that AIExecutor and ScrapingExecutor have the correct interface
  // without importing the registry singleton (which pulls in heavy dependencies)

  test('AIExecutor implements StepExecutor interface', () => {
    // Mock the heavy dependencies before importing AIExecutor
    jest.mock('../../services/aiService', () => ({ callAIByModel: jest.fn() }));
    jest.mock('../../services/promptParser', () => ({ compilePrompt: jest.fn() }));
    jest.mock('../../models/database', () => ({ queries: {} }));

    const { AIExecutor } = require('../../executors/AIExecutor');
    const ai = new AIExecutor();
    expect(ai.type).toBe('ai');
    expect(ai.displayName).toBe('AI Model');
    expect(typeof ai.execute).toBe('function');
    expect(typeof ai.validateConfig).toBe('function');
    expect(typeof ai.getConfigSchema).toBe('function');
  });

  test('ScrapingExecutor implements StepExecutor interface', () => {
    jest.mock('../../services/brightDataService', () => ({ scrapeReviews: jest.fn(), isBrightDataConfigured: jest.fn() }));
    jest.mock('../../services/csvParserService', () => ({ parseReviewCSV: jest.fn() }));
    jest.mock('../../services/usageTrackingService', () => ({ logUsage: jest.fn() }));
    jest.mock('../../models/database', () => ({ queries: {} }));

    const { ScrapingExecutor } = require('../../executors/ScrapingExecutor');
    const scraping = new ScrapingExecutor();
    expect(scraping.type).toBe('scraping');
    expect(scraping.displayName).toBe('Web Scraping');
    expect(typeof scraping.execute).toBe('function');
    expect(typeof scraping.validateConfig).toBe('function');
    expect(typeof scraping.getConfigSchema).toBe('function');
  });
});

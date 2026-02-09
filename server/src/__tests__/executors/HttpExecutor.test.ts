import { HttpExecutor } from '../../executors/HttpExecutor';
import { RecipeStep, StepExecution } from '../../types';
import { StepExecutorContext } from '../../executors/StepExecutor';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('HttpExecutor', () => {
  let executor: HttpExecutor;
  let mockStep: RecipeStep;
  let mockContext: StepExecutorContext;

  beforeEach(() => {
    executor = new HttpExecutor();
    jest.clearAllMocks();

    mockStep = {
      id: 1,
      recipe_id: 1,
      step_order: 1,
      step_name: 'Test HTTP Step',
      step_type: 'http',
      ai_model: '',
      prompt_template: '',
      output_format: 'text',
      created_at: '2024-01-01',
      executor_config: JSON.stringify({
        method: 'GET',
        url: 'https://api.example.com/data',
        timeout: 5000,
      }),
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
      userInputs: { keyword: 'test', api_key: 'abc123' },
      completedStepExecutions: [],
    };
  });

  function createMockResponse(body: string, status = 200, statusText = 'OK') {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText,
      text: jest.fn().mockResolvedValue(body),
      headers: new Map([['content-type', 'application/json']]),
    };
  }

  describe('type and metadata', () => {
    test('has correct type identifier', () => {
      expect(executor.type).toBe('http');
    });

    test('has display name', () => {
      expect(executor.displayName).toBe('HTTP Request');
    });

    test('has an icon', () => {
      expect(executor.icon).toBeTruthy();
    });
  });

  describe('validateConfig', () => {
    test('returns valid for correct config', () => {
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('returns error when URL is missing', () => {
      mockStep.executor_config = JSON.stringify({ method: 'GET', url: '' });
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('URL is required');
    });

    test('returns error for invalid HTTP method', () => {
      mockStep.executor_config = JSON.stringify({ method: 'INVALID', url: 'https://example.com' });
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Method must be GET, POST, PUT, PATCH, or DELETE');
    });
  });

  describe('execute', () => {
    test('makes GET request and returns response', async () => {
      mockFetch.mockResolvedValue(createMockResponse('{"data": "result"}'));

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(result.content).toBe('{"data": "result"}');
      expect(result.metadata?.statusCode).toBe(200);
      expect(result.metadata?.method).toBe('GET');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({ method: 'GET' })
      );
    });

    test('substitutes variables in URL', async () => {
      mockStep.executor_config = JSON.stringify({
        method: 'GET',
        url: 'https://api.example.com/search?q={{keyword}}&key={{api_key}}',
      });
      mockFetch.mockResolvedValue(createMockResponse('[]'));

      await executor.execute(mockStep, mockContext);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/search?q=test&key=abc123',
        expect.any(Object)
      );
    });

    test('substitutes variables in headers', async () => {
      mockStep.executor_config = JSON.stringify({
        method: 'GET',
        url: 'https://api.example.com/data',
        headers: { 'Authorization': 'Bearer {{api_key}}' },
      });
      mockFetch.mockResolvedValue(createMockResponse('ok'));

      await executor.execute(mockStep, mockContext);

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers['Authorization']).toBe('Bearer abc123');
    });

    test('substitutes variables in body for POST requests', async () => {
      mockStep.executor_config = JSON.stringify({
        method: 'POST',
        url: 'https://api.example.com/data',
        body: '{"query": "{{keyword}}"}',
      });
      mockFetch.mockResolvedValue(createMockResponse('created'));

      await executor.execute(mockStep, mockContext);

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].body).toBe('{"query": "test"}');
      expect(callArgs[1].method).toBe('POST');
    });

    test('auto-adds Content-Type header for POST with body', async () => {
      mockStep.executor_config = JSON.stringify({
        method: 'POST',
        url: 'https://api.example.com/data',
        body: '{"key": "value"}',
      });
      mockFetch.mockResolvedValue(createMockResponse('ok'));

      await executor.execute(mockStep, mockContext);

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers['Content-Type']).toBe('application/json');
    });

    test('does not override existing Content-Type header', async () => {
      mockStep.executor_config = JSON.stringify({
        method: 'POST',
        url: 'https://api.example.com/data',
        headers: { 'Content-Type': 'text/plain' },
        body: 'plain text body',
      });
      mockFetch.mockResolvedValue(createMockResponse('ok'));

      await executor.execute(mockStep, mockContext);

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers['Content-Type']).toBe('text/plain');
    });

    test('returns failure for non-2xx responses', async () => {
      mockFetch.mockResolvedValue(createMockResponse('Not Found', 404, 'Not Found'));

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toBe('HTTP 404 Not Found');
      expect(result.content).toBe('Not Found');
    });

    test('returns failure when URL is empty', async () => {
      mockStep.executor_config = JSON.stringify({ method: 'GET', url: '' });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No URL configured');
    });

    test('includes step outputs in variable substitution', async () => {
      mockContext.completedStepExecutions = [
        {
          id: 2,
          execution_id: 1,
          step_id: 2,
          step_order: 1,
          status: 'completed',
          approved: true,
          output_data: JSON.stringify({ content: 'step1result' }),
        } as StepExecution,
      ];

      mockStep.executor_config = JSON.stringify({
        method: 'GET',
        url: 'https://api.example.com/data?input={{step_1_output}}',
      });
      mockFetch.mockResolvedValue(createMockResponse('ok'));

      await executor.execute(mockStep, mockContext);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data?input=step1result',
        expect.any(Object)
      );
    });

    test('leaves unresolved variables as-is', async () => {
      mockStep.executor_config = JSON.stringify({
        method: 'GET',
        url: 'https://api.example.com/data?q={{unknown_var}}',
      });
      mockFetch.mockResolvedValue(createMockResponse('ok'));

      await executor.execute(mockStep, mockContext);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.example.com/data?q={{unknown_var}}',
        expect.any(Object)
      );
    });

    test('handles fetch network error', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    test('handles abort/timeout error', async () => {
      mockFetch.mockRejectedValue(new Error('The operation was aborted'));

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Request timed out');
    });
  });

  describe('getConfigSchema', () => {
    test('returns schema with method, url, headers, body, timeout fields', () => {
      const schema = executor.getConfigSchema();
      const fieldNames = schema.fields.map(f => f.name);
      expect(fieldNames).toContain('method');
      expect(fieldNames).toContain('url');
      expect(fieldNames).toContain('headers');
      expect(fieldNames).toContain('body');
      expect(fieldNames).toContain('timeout');
    });

    test('method field has all HTTP methods', () => {
      const schema = executor.getConfigSchema();
      const method = schema.fields.find(f => f.name === 'method');
      expect(method?.options?.map(o => o.value)).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    });

    test('url field is required', () => {
      const schema = executor.getConfigSchema();
      const url = schema.fields.find(f => f.name === 'url');
      expect(url?.required).toBe(true);
    });
  });
});

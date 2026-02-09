import { ScriptExecutor } from '../../executors/ScriptExecutor';
import { RecipeStep, StepExecution } from '../../types';
import { StepExecutorContext } from '../../executors/StepExecutor';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process.spawn
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe('ScriptExecutor', () => {
  let executor: ScriptExecutor;
  let mockStep: RecipeStep;
  let mockContext: StepExecutorContext;

  beforeEach(() => {
    executor = new ScriptExecutor();
    jest.clearAllMocks();

    mockStep = {
      id: 1,
      recipe_id: 1,
      step_order: 1,
      step_name: 'Test Script Step',
      step_type: 'script',
      ai_model: '',
      prompt_template: '',
      output_format: 'text',
      created_at: '2024-01-01',
      executor_config: JSON.stringify({
        runtime: 'python3',
        script: 'import sys, json\ndata = json.load(sys.stdin)\nprint(json.dumps({"result": "ok"}))',
        timeout: 30000,
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
      userInputs: { keyword: 'test' },
      completedStepExecutions: [],
    };
  });

  function createMockProcess() {
    const proc = new EventEmitter() as any;
    proc.stdin = { write: jest.fn(), end: jest.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    return proc;
  }

  describe('type and metadata', () => {
    test('has correct type identifier', () => {
      expect(executor.type).toBe('script');
    });

    test('has display name', () => {
      expect(executor.displayName).toBe('Script');
    });

    test('has an icon', () => {
      expect(executor.icon).toBeTruthy();
    });
  });

  describe('validateConfig', () => {
    test('returns valid when script and runtime are present', () => {
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('returns error when script is empty', () => {
      mockStep.executor_config = JSON.stringify({ runtime: 'python3', script: '' });
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Script content is required');
    });

    test('returns error for invalid runtime', () => {
      mockStep.executor_config = JSON.stringify({ runtime: 'ruby', script: 'puts "hi"' });
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Runtime must be python3 or node');
    });

    test('falls back to prompt_template as script when executor_config is missing', () => {
      mockStep.executor_config = undefined;
      mockStep.prompt_template = 'print("hello")';
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(true);
    });
  });

  describe('execute', () => {
    test('spawns process and returns stdout on success', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const resultPromise = executor.execute(mockStep, mockContext);

      // Simulate process output
      proc.stdout.emit('data', '{"result": "ok"}');
      proc.emit('close', 0);

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.content).toBe('{"result": "ok"}');
      expect(result.metadata?.runtime).toBe('python3');
      expect(result.metadata?.exitCode).toBe(0);
    });

    test('returns failure on non-zero exit code', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const resultPromise = executor.execute(mockStep, mockContext);

      proc.stderr.emit('data', 'NameError: name "foo" is not defined');
      proc.emit('close', 1);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Script exited with code 1');
      expect(result.error).toContain('NameError');
    });

    test('returns failure when spawn errors', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const resultPromise = executor.execute(mockStep, mockContext);

      proc.emit('error', new Error('ENOENT: python3 not found'));

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to spawn python3');
    });

    test('writes input JSON to stdin', async () => {
      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const resultPromise = executor.execute(mockStep, mockContext);

      proc.stdout.emit('data', 'output');
      proc.emit('close', 0);

      await resultPromise;

      expect(proc.stdin.write).toHaveBeenCalledWith(
        JSON.stringify({ keyword: 'test' })
      );
      expect(proc.stdin.end).toHaveBeenCalled();
    });

    test('includes previous step outputs in input data', async () => {
      mockContext.completedStepExecutions = [
        {
          id: 2,
          execution_id: 1,
          step_id: 2,
          step_order: 1,
          status: 'completed',
          approved: true,
          output_data: JSON.stringify({ content: 'previous result' }),
        } as StepExecution,
      ];

      const proc = createMockProcess();
      mockSpawn.mockReturnValue(proc as any);

      const resultPromise = executor.execute(mockStep, mockContext);

      proc.stdout.emit('data', 'ok');
      proc.emit('close', 0);

      await resultPromise;

      const writtenData = JSON.parse(proc.stdin.write.mock.calls[0][0]);
      expect(writtenData.step_1_output).toBe('previous result');
    });

    test('returns failure when no script is provided', async () => {
      mockStep.executor_config = JSON.stringify({ runtime: 'python3', script: '' });

      const result = await executor.execute(mockStep, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toBe('No script provided');
    });
  });

  describe('getConfigSchema', () => {
    test('returns schema with runtime, script, and timeout fields', () => {
      const schema = executor.getConfigSchema();
      const fieldNames = schema.fields.map(f => f.name);
      expect(fieldNames).toContain('runtime');
      expect(fieldNames).toContain('script');
      expect(fieldNames).toContain('timeout');
    });

    test('runtime field has python3 and node options', () => {
      const schema = executor.getConfigSchema();
      const runtime = schema.fields.find(f => f.name === 'runtime');
      expect(runtime?.options).toHaveLength(2);
      expect(runtime?.options?.map(o => o.value)).toEqual(['python3', 'node']);
    });

    test('script field uses code type', () => {
      const schema = executor.getConfigSchema();
      const script = schema.fields.find(f => f.name === 'script');
      expect(script?.type).toBe('code');
      expect(script?.required).toBe(true);
    });
  });
});

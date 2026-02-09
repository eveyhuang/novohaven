import { TransformExecutor } from '../../executors/TransformExecutor';
import { RecipeStep, StepExecution } from '../../types';
import { StepExecutorContext } from '../../executors/StepExecutor';

describe('TransformExecutor', () => {
  let executor: TransformExecutor;
  let mockStep: RecipeStep;
  let mockContext: StepExecutorContext;

  beforeEach(() => {
    executor = new TransformExecutor();

    mockStep = {
      id: 1,
      recipe_id: 1,
      step_order: 2,
      step_name: 'Transform Step',
      step_type: 'transform',
      ai_model: '',
      prompt_template: '',
      output_format: 'text',
      created_at: '2024-01-01',
      executor_config: JSON.stringify({
        transform_type: 'csv_to_json',
      }),
    };

    mockContext = {
      userId: 1,
      executionId: 1,
      stepExecution: {
        id: 2,
        execution_id: 1,
        step_id: 2,
        step_order: 2,
        status: 'running',
        approved: false,
      } as StepExecution,
      userInputs: {},
      completedStepExecutions: [
        {
          id: 1,
          execution_id: 1,
          step_id: 1,
          step_order: 1,
          status: 'completed',
          approved: true,
          output_data: JSON.stringify({
            content: 'name,price,rating\nWidget A,29.99,4.5\nWidget B,49.99,4.8\nWidget C,19.99,3.2',
          }),
        } as StepExecution,
      ],
    };
  });

  describe('type and metadata', () => {
    test('has correct type identifier', () => {
      expect(executor.type).toBe('transform');
    });

    test('has display name', () => {
      expect(executor.displayName).toBe('Data Transform');
    });

    test('has an icon', () => {
      expect(executor.icon).toBeTruthy();
    });
  });

  describe('validateConfig', () => {
    test('returns valid for csv_to_json', () => {
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(true);
    });

    test('returns error for invalid transform type', () => {
      mockStep.executor_config = JSON.stringify({ transform_type: 'invalid' });
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
    });

    test('returns error when field_map has no mapping', () => {
      mockStep.executor_config = JSON.stringify({ transform_type: 'field_map' });
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Field mapping is required for field_map transform');
    });

    test('returns error when filter has no expression', () => {
      mockStep.executor_config = JSON.stringify({ transform_type: 'filter' });
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Filter expression is required for filter transform');
    });

    test('returns valid for field_map with mapping', () => {
      mockStep.executor_config = JSON.stringify({
        transform_type: 'field_map',
        mapping: { name: 'product_name' },
      });
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(true);
    });

    test('returns valid for filter with expression', () => {
      mockStep.executor_config = JSON.stringify({
        transform_type: 'filter',
        filter_expression: 'row.price > 20',
      });
      const result = executor.validateConfig(mockStep);
      expect(result.valid).toBe(true);
    });
  });

  describe('execute - csv_to_json', () => {
    test('converts CSV to JSON array', async () => {
      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed).toHaveLength(3);
      expect(parsed[0]).toEqual({ name: 'Widget A', price: '29.99', rating: '4.5' });
      expect(parsed[1]).toEqual({ name: 'Widget B', price: '49.99', rating: '4.8' });
    });

    test('handles quoted CSV fields', async () => {
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: 'name,description\n"Widget A","A nice, simple widget"\n"Widget B","Has ""quotes"" inside"',
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed[0].description).toBe('A nice, simple widget');
      expect(parsed[1].description).toBe('Has "quotes" inside');
    });

    test('returns empty array for CSV with only headers', async () => {
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: 'name,price',
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(JSON.parse(result.content)).toEqual([]);
    });

    test('supports custom delimiter', async () => {
      mockStep.executor_config = JSON.stringify({
        transform_type: 'csv_to_json',
        delimiter: '\t',
      });
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: 'name\tprice\nWidget A\t29.99',
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed[0].name).toBe('Widget A');
      expect(parsed[0].price).toBe('29.99');
    });
  });

  describe('execute - json_to_csv', () => {
    test('converts JSON array to CSV', async () => {
      mockStep.executor_config = JSON.stringify({ transform_type: 'json_to_csv' });
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: JSON.stringify([
          { name: 'Widget A', price: 29.99 },
          { name: 'Widget B', price: 49.99 },
        ]),
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const lines = result.content.split('\n');
      expect(lines[0]).toBe('name,price');
      expect(lines[1]).toBe('Widget A,29.99');
      expect(lines[2]).toBe('Widget B,49.99');
    });

    test('wraps a single object in an array', async () => {
      mockStep.executor_config = JSON.stringify({ transform_type: 'json_to_csv' });
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: JSON.stringify({ name: 'Single', price: 10 }),
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const lines = result.content.split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe('name,price');
    });

    test('escapes fields containing delimiter', async () => {
      mockStep.executor_config = JSON.stringify({ transform_type: 'json_to_csv' });
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: JSON.stringify([{ name: 'Widget, Deluxe', price: 99 }]),
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(result.content).toContain('"Widget, Deluxe"');
    });

    test('returns failure for non-JSON input', async () => {
      mockStep.executor_config = JSON.stringify({ transform_type: 'json_to_csv' });
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: 'this is not json',
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not valid JSON');
    });
  });

  describe('execute - field_map', () => {
    test('maps fields from source to target names', async () => {
      mockStep.executor_config = JSON.stringify({
        transform_type: 'field_map',
        mapping: { name: 'product_name', price: 'cost' },
      });
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: JSON.stringify([
          { name: 'Widget A', price: 29.99, rating: 4.5 },
          { name: 'Widget B', price: 49.99, rating: 4.8 },
        ]),
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed[0]).toEqual({ product_name: 'Widget A', cost: 29.99 });
      expect(parsed[1]).toEqual({ product_name: 'Widget B', cost: 49.99 });
      // rating should NOT be in output (not in mapping)
      expect(parsed[0]).not.toHaveProperty('rating');
    });

    test('sets null for missing source fields', async () => {
      mockStep.executor_config = JSON.stringify({
        transform_type: 'field_map',
        mapping: { name: 'product_name', nonexistent: 'target' },
      });
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: JSON.stringify([{ name: 'Widget A' }]),
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed[0].target).toBeNull();
    });

    test('handles CSV input for field mapping', async () => {
      mockStep.executor_config = JSON.stringify({
        transform_type: 'field_map',
        mapping: { name: 'product', price: 'amount' },
      });
      // CSV input (not JSON)
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: 'name,price\nWidget A,29.99',
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed[0]).toEqual({ product: 'Widget A', amount: '29.99' });
    });
  });

  describe('execute - filter', () => {
    test('filters rows by expression', async () => {
      mockStep.executor_config = JSON.stringify({
        transform_type: 'filter',
        filter_expression: 'Number(row.price) > 25',
      });
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: JSON.stringify([
          { name: 'Widget A', price: '29.99' },
          { name: 'Widget B', price: '49.99' },
          { name: 'Widget C', price: '19.99' },
        ]),
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('Widget A');
      expect(parsed[1].name).toBe('Widget B');
    });

    test('handles expression that throws for some rows', async () => {
      mockStep.executor_config = JSON.stringify({
        transform_type: 'filter',
        filter_expression: 'row.nested.value > 0',
      });
      mockContext.completedStepExecutions[0].output_data = JSON.stringify({
        content: JSON.stringify([
          { name: 'A', nested: { value: 5 } },
          { name: 'B' }, // row.nested is undefined, will throw
          { name: 'C', nested: { value: 10 } },
        ]),
      });

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      // Only rows A and C should pass (B throws → filtered out)
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe('A');
      expect(parsed[1].name).toBe('C');
    });
  });

  describe('execute - edge cases', () => {
    test('returns failure when no input data available', async () => {
      mockContext.completedStepExecutions = [];

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('No input data');
    });

    test('uses specified input_source from user inputs', async () => {
      mockStep.executor_config = JSON.stringify({
        transform_type: 'csv_to_json',
        input_source: 'csv_data',
      });
      mockContext.userInputs = { csv_data: 'name,price\nTest,9.99' };

      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.content);
      expect(parsed[0].name).toBe('Test');
    });

    test('includes metadata in result', async () => {
      const result = await executor.execute(mockStep, mockContext);

      expect(result.success).toBe(true);
      expect(result.metadata?.transformType).toBe('csv_to_json');
      expect(result.metadata?.inputLength).toBeGreaterThan(0);
      expect(result.metadata?.outputLength).toBeGreaterThan(0);
      expect(result.modelUsed).toBe('transform');
    });
  });

  describe('getConfigSchema', () => {
    test('returns schema with all config fields', () => {
      const schema = executor.getConfigSchema();
      const fieldNames = schema.fields.map(f => f.name);
      expect(fieldNames).toContain('transform_type');
      expect(fieldNames).toContain('mapping');
      expect(fieldNames).toContain('filter_expression');
      expect(fieldNames).toContain('input_source');
      expect(fieldNames).toContain('delimiter');
    });

    test('transform_type field has all options', () => {
      const schema = executor.getConfigSchema();
      const transformType = schema.fields.find(f => f.name === 'transform_type');
      expect(transformType?.options?.map(o => o.value)).toEqual([
        'csv_to_json',
        'json_to_csv',
        'field_map',
        'filter',
      ]);
    });

    test('transform_type is required', () => {
      const schema = executor.getConfigSchema();
      const transformType = schema.fields.find(f => f.name === 'transform_type');
      expect(transformType?.required).toBe(true);
    });
  });
});

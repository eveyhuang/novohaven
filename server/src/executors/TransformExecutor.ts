import { RecipeStep } from '../types';
import {
  StepExecutor,
  StepExecutorContext,
  StepExecutorResult,
  ExecutorConfigSchema,
} from './StepExecutor';

export type TransformType = 'csv_to_json' | 'json_to_csv' | 'field_map' | 'filter';

export interface TransformConfig {
  transform_type: TransformType;
  /** For field_map: { sourceField: targetField } */
  mapping?: Record<string, string>;
  /** For filter: JS expression evaluated against each row, e.g. "row.price > 100" */
  filter_expression?: string;
  /** Which input to transform: 'auto' uses the last completed step output */
  input_source?: string;
  /** CSV delimiter, default ',' */
  delimiter?: string;
}

function parseTransformConfig(step: RecipeStep): TransformConfig {
  const defaults: TransformConfig = { transform_type: 'csv_to_json', delimiter: ',' };

  if (step.executor_config) {
    try {
      return { ...defaults, ...JSON.parse(step.executor_config) };
    } catch {
      // fall through
    }
  }

  return defaults;
}

/**
 * Parse CSV text into an array of objects using the first row as headers.
 */
function csvToJson(csv: string, delimiter = ','): Record<string, string>[] {
  const lines = csv.split('\n').filter(line => line.trim());
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0], delimiter);
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i], delimiter);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Parse a single CSV line, respecting quoted fields.
 */
function parseCsvLine(line: string, delimiter = ','): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Convert an array of objects to CSV text.
 */
function jsonToCsv(data: Record<string, any>[], delimiter = ','): string {
  if (data.length === 0) return '';

  const headers = Object.keys(data[0]);
  const headerLine = headers.map(h => escapeCsvField(h, delimiter)).join(delimiter);

  const rows = data.map(row =>
    headers.map(h => escapeCsvField(String(row[h] ?? ''), delimiter)).join(delimiter)
  );

  return [headerLine, ...rows].join('\n');
}

function escapeCsvField(field: string, delimiter: string): string {
  if (field.includes(delimiter) || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/**
 * Get the input data from context: either the specified source or the last completed step output.
 */
function getInputData(context: StepExecutorContext, inputSource?: string): string {
  if (inputSource && inputSource !== 'auto') {
    // Look for a specific step output by key
    const userInput = context.userInputs[inputSource];
    if (userInput) return String(userInput);
  }

  // Default: use the last completed step's output
  const completed = context.completedStepExecutions;
  if (completed.length === 0) return '';

  const last = completed[completed.length - 1];
  if (!last.output_data) return '';

  try {
    const parsed = JSON.parse(last.output_data);
    return typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content);
  } catch {
    return last.output_data;
  }
}

export class TransformExecutor implements StepExecutor {
  type = 'transform';
  displayName = 'Data Transform';
  icon = '🔄';
  description = 'Transform data between formats (CSV/JSON), map fields, or filter rows';

  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const config = parseTransformConfig(step);

    if (!['csv_to_json', 'json_to_csv', 'field_map', 'filter'].includes(config.transform_type)) {
      errors.push('Transform type must be csv_to_json, json_to_csv, field_map, or filter');
    }

    if (config.transform_type === 'field_map' && (!config.mapping || Object.keys(config.mapping).length === 0)) {
      errors.push('Field mapping is required for field_map transform');
    }

    if (config.transform_type === 'filter' && !config.filter_expression) {
      errors.push('Filter expression is required for filter transform');
    }

    return { valid: errors.length === 0, errors };
  }

  async execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult> {
    const config = parseTransformConfig(step);
    const inputStr = getInputData(context, config.input_source);

    if (!inputStr) {
      return { success: false, content: '', error: 'No input data available to transform' };
    }

    try {
      let result: string;

      switch (config.transform_type) {
        case 'csv_to_json': {
          const rows = csvToJson(inputStr, config.delimiter);
          result = JSON.stringify(rows, null, 2);
          break;
        }

        case 'json_to_csv': {
          let data: Record<string, any>[];
          try {
            const parsed = JSON.parse(inputStr);
            data = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            return { success: false, content: '', error: 'Input is not valid JSON for json_to_csv transform' };
          }
          result = jsonToCsv(data, config.delimiter);
          break;
        }

        case 'field_map': {
          let data: Record<string, any>[];
          try {
            const parsed = JSON.parse(inputStr);
            data = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            // Try CSV first
            data = csvToJson(inputStr, config.delimiter);
            if (data.length === 0) {
              return { success: false, content: '', error: 'Input could not be parsed as JSON or CSV for field mapping' };
            }
          }

          const mapping = config.mapping || {};
          const mapped = data.map(row => {
            const newRow: Record<string, any> = {};
            for (const [source, target] of Object.entries(mapping)) {
              newRow[target] = row[source] ?? null;
            }
            return newRow;
          });
          result = JSON.stringify(mapped, null, 2);
          break;
        }

        case 'filter': {
          let data: Record<string, any>[];
          try {
            const parsed = JSON.parse(inputStr);
            data = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            data = csvToJson(inputStr, config.delimiter);
            if (data.length === 0) {
              return { success: false, content: '', error: 'Input could not be parsed as JSON or CSV for filtering' };
            }
          }

          const expression = config.filter_expression || 'true';
          const filterFn = new Function('row', `return ${expression}`);
          const filtered = data.filter(row => {
            try {
              return filterFn(row);
            } catch {
              return false;
            }
          });
          result = JSON.stringify(filtered, null, 2);
          break;
        }

        default:
          return { success: false, content: '', error: `Unknown transform type: ${config.transform_type}` };
      }

      return {
        success: true,
        content: result,
        metadata: {
          transformType: config.transform_type,
          inputLength: inputStr.length,
          outputLength: result.length,
        },
        promptUsed: `[transform] ${config.transform_type}`,
        modelUsed: 'transform',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transform failed';
      return { success: false, content: '', error: message };
    }
  }

  getConfigSchema(): ExecutorConfigSchema {
    return {
      fields: [
        {
          name: 'transform_type',
          label: 'Transform Type',
          type: 'select',
          required: true,
          defaultValue: 'csv_to_json',
          options: [
            { value: 'csv_to_json', label: 'CSV → JSON' },
            { value: 'json_to_csv', label: 'JSON → CSV' },
            { value: 'field_map', label: 'Field Mapping' },
            { value: 'filter', label: 'Filter Rows' },
          ],
        },
        {
          name: 'mapping',
          label: 'Field Mapping',
          type: 'json',
          helpText: 'JSON object mapping source fields to target fields. Example: {"old_name": "new_name"}',
        },
        {
          name: 'filter_expression',
          label: 'Filter Expression',
          type: 'text',
          helpText: 'JavaScript expression to filter rows. Use "row" to access fields. Example: row.price > 100',
        },
        {
          name: 'input_source',
          label: 'Input Source',
          type: 'text',
          helpText: 'Variable name or "auto" (default) to use previous step output',
          defaultValue: 'auto',
        },
        {
          name: 'delimiter',
          label: 'CSV Delimiter',
          type: 'text',
          defaultValue: ',',
          helpText: 'Delimiter for CSV parsing/generation',
        },
      ],
    };
  }
}

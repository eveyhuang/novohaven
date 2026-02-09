import { RecipeStep } from '../types';
import { compilePrompt, CompilePromptContext } from '../services/promptParser';
import {
  StepExecutor,
  StepExecutorContext,
  StepExecutorResult,
  ExecutorConfigSchema,
} from './StepExecutor';

export interface HttpConfig {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number; // ms, default 30000
}

function parseHttpConfig(step: RecipeStep): HttpConfig {
  const defaults: HttpConfig = { method: 'GET', url: '', timeout: 30000 };

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
 * Simple variable substitution for strings.
 * Replaces {{variable_name}} with values from the provided map.
 */
function substituteVariables(template: string, variables: Record<string, any>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
    const trimmed = varName.trim();
    if (trimmed in variables) {
      return String(variables[trimmed]);
    }
    // Check for step outputs
    return match; // leave unresolved variables as-is
  });
}

export class HttpExecutor implements StepExecutor {
  type = 'http';
  displayName = 'HTTP Request';
  icon = '🌐';
  description = 'Make an HTTP request to an API endpoint with variable substitution';

  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const config = parseHttpConfig(step);
    if (!config.url) {
      errors.push('URL is required');
    }
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(config.method)) {
      errors.push('Method must be GET, POST, PUT, PATCH, or DELETE');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult> {
    const config = parseHttpConfig(step);

    if (!config.url) {
      return { success: false, content: '', error: 'No URL configured' };
    }

    // Build variable map from user inputs + previous step outputs
    const variables: Record<string, any> = { ...context.userInputs };
    for (const se of context.completedStepExecutions) {
      if (se.output_data) {
        try {
          const parsed = JSON.parse(se.output_data);
          variables[`step_${se.step_order}_output`] = parsed.content;
        } catch {
          variables[`step_${se.step_order}_output`] = se.output_data;
        }
      }
    }

    // Substitute variables in URL, headers, and body
    const url = substituteVariables(config.url, variables);
    const headers: Record<string, string> = {};
    if (config.headers) {
      for (const [key, value] of Object.entries(config.headers)) {
        headers[key] = substituteVariables(value, variables);
      }
    }
    const body = config.body ? substituteVariables(config.body, variables) : undefined;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout || 30000);

    try {
      const fetchOptions: RequestInit = {
        method: config.method,
        headers,
        signal: controller.signal,
      };

      if (body && config.method !== 'GET') {
        fetchOptions.body = body;
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
          fetchOptions.headers = headers;
        }
      }

      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      const responseText = await response.text();

      if (!response.ok) {
        return {
          success: false,
          content: responseText,
          error: `HTTP ${response.status} ${response.statusText}`,
          metadata: {
            statusCode: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
          },
          promptUsed: `${config.method} ${url}`,
          modelUsed: 'http',
        };
      }

      return {
        success: true,
        content: responseText,
        metadata: {
          statusCode: response.status,
          statusText: response.statusText,
          method: config.method,
          url,
        },
        promptUsed: `${config.method} ${url}`,
        modelUsed: 'http',
      };
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : 'HTTP request failed';
      return {
        success: false,
        content: '',
        error: message.includes('abort') ? `Request timed out after ${config.timeout || 30000}ms` : message,
      };
    }
  }

  getConfigSchema(): ExecutorConfigSchema {
    return {
      fields: [
        {
          name: 'method',
          label: 'HTTP Method',
          type: 'select',
          required: true,
          defaultValue: 'GET',
          options: [
            { value: 'GET', label: 'GET' },
            { value: 'POST', label: 'POST' },
            { value: 'PUT', label: 'PUT' },
            { value: 'PATCH', label: 'PATCH' },
            { value: 'DELETE', label: 'DELETE' },
          ],
        },
        {
          name: 'url',
          label: 'URL',
          type: 'text',
          required: true,
          helpText: 'Use {{variable_name}} for dynamic values. Example: https://api.example.com/search?q={{keyword}}',
        },
        {
          name: 'headers',
          label: 'Headers',
          type: 'json',
          helpText: 'JSON object of request headers. Variables supported.',
        },
        {
          name: 'body',
          label: 'Request Body',
          type: 'textarea',
          helpText: 'Request body (for POST/PUT/PATCH). Variables supported.',
        },
        {
          name: 'timeout',
          label: 'Timeout (ms)',
          type: 'number',
          defaultValue: 30000,
          helpText: 'Maximum wait time in milliseconds',
        },
      ],
    };
  }
}

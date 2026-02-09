import { spawn } from 'child_process';
import { RecipeStep } from '../types';
import {
  StepExecutor,
  StepExecutorContext,
  StepExecutorResult,
  ExecutorConfigSchema,
} from './StepExecutor';

export interface ScriptConfig {
  runtime: 'python3' | 'node';
  script: string;
  timeout?: number; // ms, default 60000
}

function parseScriptConfig(step: RecipeStep): ScriptConfig {
  const defaults: ScriptConfig = { runtime: 'python3', script: '', timeout: 60000 };

  if (step.executor_config) {
    try {
      return { ...defaults, ...JSON.parse(step.executor_config) };
    } catch {
      // fall through
    }
  }

  // Fallback: use prompt_template as inline script
  return { ...defaults, script: step.prompt_template || '' };
}

export class ScriptExecutor implements StepExecutor {
  type = 'script';
  displayName = 'Script';
  icon = '📜';
  description = 'Run a Python or Node.js script with JSON input/output';

  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const config = parseScriptConfig(step);
    if (!config.script) {
      errors.push('Script content is required');
    }
    if (!['python3', 'node'].includes(config.runtime)) {
      errors.push('Runtime must be python3 or node');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult> {
    const config = parseScriptConfig(step);

    if (!config.script) {
      return { success: false, content: '', error: 'No script provided' };
    }

    // Build input JSON from user inputs + previous step outputs
    const inputData: Record<string, any> = { ...context.userInputs };
    for (const se of context.completedStepExecutions) {
      if (se.output_data) {
        try {
          const parsed = JSON.parse(se.output_data);
          inputData[`step_${se.step_order}_output`] = parsed.content;
        } catch {
          inputData[`step_${se.step_order}_output`] = se.output_data;
        }
      }
    }

    return new Promise((resolve) => {
      const timeout = config.timeout || 60000;
      const proc = spawn(config.runtime, ['-c', config.script], {
        timeout,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdin.write(JSON.stringify(inputData));
      proc.stdin.end();

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          resolve({
            success: false,
            content: '',
            error: `Script exited with code ${code}${stderr ? ': ' + stderr.slice(0, 500) : ''}`,
            metadata: { exitCode: code, stderr: stderr.slice(0, 2000) },
          });
          return;
        }

        resolve({
          success: true,
          content: stdout,
          metadata: {
            runtime: config.runtime,
            exitCode: 0,
            stderr: stderr.slice(0, 2000) || undefined,
          },
          promptUsed: `[${config.runtime}] ${config.script.slice(0, 200)}`,
          modelUsed: config.runtime,
        });
      });

      proc.on('error', (err) => {
        resolve({
          success: false,
          content: '',
          error: `Failed to spawn ${config.runtime}: ${err.message}`,
        });
      });
    });
  }

  getConfigSchema(): ExecutorConfigSchema {
    return {
      fields: [
        {
          name: 'runtime',
          label: 'Runtime',
          type: 'select',
          required: true,
          defaultValue: 'python3',
          options: [
            { value: 'python3', label: 'Python 3' },
            { value: 'node', label: 'Node.js' },
          ],
          helpText: 'Language runtime to execute the script',
        },
        {
          name: 'script',
          label: 'Script',
          type: 'code',
          required: true,
          language: 'python',
          helpText: 'Script receives JSON on stdin (user inputs + previous step outputs). Write output to stdout.',
        },
        {
          name: 'timeout',
          label: 'Timeout (ms)',
          type: 'number',
          defaultValue: 60000,
          helpText: 'Maximum execution time in milliseconds',
        },
      ],
    };
  }
}

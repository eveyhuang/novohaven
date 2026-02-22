import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
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

function parseJsonMaybe(value: string): any | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function normalizeFilesValue(key: string, value: any): any {
  if (value == null) return [];

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      const parsed = parseJsonMaybe(trimmed);
      if (parsed !== undefined) return normalizeFilesValue(key, parsed);
    }
    return [{ name: `${key}.txt`, content: value }];
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item, index) => {
        if (typeof item === 'string') {
          return { name: `${key}_${index + 1}.txt`, content: item };
        }
        if (item && typeof item === 'object') {
          if (typeof (item as any).content === 'string') {
            return {
              name: (item as any).name || `${key}_${index + 1}.txt`,
              content: (item as any).content,
            };
          }
          if (typeof (item as any).text === 'string') {
            return {
              name: (item as any).name || `${key}_${index + 1}.txt`,
              content: (item as any).text,
            };
          }
        }
        return null;
      })
      .filter(Boolean);
    return normalized;
  }

  if (value && typeof value === 'object') {
    if (typeof (value as any).content === 'string') {
      return [{
        name: (value as any).name || `${key}.txt`,
        content: (value as any).content,
      }];
    }
    if (typeof (value as any).text === 'string') {
      return [{
        name: (value as any).name || `${key}.txt`,
        content: (value as any).text,
      }];
    }
  }

  return value;
}

function normalizeScriptInputs(userInputs: Record<string, any>): Record<string, any> {
  const normalized: Record<string, any> = { ...userInputs };
  for (const [key, value] of Object.entries(userInputs || {})) {
    if (/_files$/i.test(key)) {
      normalized[key] = normalizeFilesValue(key, value);
    }
  }
  return normalized;
}

function scriptLikelyExpectsFilePaths(script: string): boolean {
  const text = String(script || '');
  const lowered = text.toLowerCase();
  const readsInlineContent = /\[['"]content['"]\]/.test(text) || /\.get\(\s*['"]content['"]/.test(text);
  if (readsInlineContent) return false;

  return (
    /\bread_csv\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)/.test(text) ||
    /\bopen\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,/.test(text) ||
    lowered.includes('os.path.exists(')
  );
}

function toSafeFileExtension(name: string | undefined): string {
  const ext = path.extname(String(name || '').trim()).toLowerCase();
  if (ext && ext.length <= 10) return ext;
  return '.txt';
}

async function materializeInlineFilesForPathScripts(
  inputData: Record<string, any>,
  script: string
): Promise<{ inputData: Record<string, any>; tempFiles: string[] }> {
  if (!scriptLikelyExpectsFilePaths(script)) {
    return { inputData, tempFiles: [] };
  }

  const converted: Record<string, any> = { ...inputData };
  const tempFiles: string[] = [];

  for (const [key, value] of Object.entries(inputData || {})) {
    if (!/_files$/i.test(key) || !Array.isArray(value)) continue;
    const files = value as any[];
    if (!files.length) continue;
    const allInline = files.every((item) => item && typeof item === 'object' && typeof item.content === 'string');
    if (!allInline) continue;

    const tempPaths: string[] = [];
    for (let i = 0; i < files.length; i += 1) {
      const item = files[i] as { name?: string; content: string };
      const ext = toSafeFileExtension(item.name);
      const tmpPath = path.join(
        os.tmpdir(),
        `workflow-inline-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}-${i + 1}${ext}`
      );
      await fs.writeFile(tmpPath, String(item.content || ''), 'utf8');
      tempPaths.push(tmpPath);
      tempFiles.push(tmpPath);
    }
    converted[key] = tempPaths;
  }

  return { inputData: converted, tempFiles };
}

async function cleanupTempFiles(pathsToRemove: string[]): Promise<void> {
  await Promise.all(pathsToRemove.map(async (p) => {
    try {
      await fs.unlink(p);
    } catch {
      // Best effort cleanup.
    }
  }));
}

function normalizeRuntimeAlias(runtime: unknown): ScriptConfig['runtime'] {
  const value = String(runtime || '').trim().toLowerCase();
  if (value === 'node' || value === 'nodejs' || value === 'node.js' || value === 'javascript' || value === 'js') {
    return 'node';
  }
  if (value === 'python3' || value === 'python' || value === 'py') {
    return 'python3';
  }
  return 'python3';
}

function parseScriptConfig(step: RecipeStep): ScriptConfig {
  const defaults: ScriptConfig = { runtime: 'python3', script: '', timeout: 60000 };

  if (step.executor_config) {
    try {
      const parsed = { ...defaults, ...JSON.parse(step.executor_config) };
      return {
        ...parsed,
        runtime: normalizeRuntimeAlias(parsed.runtime),
      };
    } catch {
      // fall through
    }
  }

  // Fallback: use prompt_template as inline script
  return {
    ...defaults,
    runtime: normalizeRuntimeAlias(defaults.runtime),
    script: step.prompt_template || '',
  };
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
    const inputData: Record<string, any> = normalizeScriptInputs(context.userInputs);
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
    const prepared = await materializeInlineFilesForPathScripts(inputData, config.script);
    const payload = prepared.inputData;
    const tempFiles = prepared.tempFiles;

    return new Promise((resolve) => {
      let settled = false;
      const finalize = (result: StepExecutorResult) => {
        if (settled) return;
        settled = true;
        cleanupTempFiles(tempFiles).finally(() => resolve(result));
      };

      const timeout = config.timeout || 60000;
      const proc = spawn(config.runtime, ['-c', config.script], {
        timeout,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();

      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          finalize({
            success: false,
            content: '',
            error: `Script exited with code ${code}${stderr ? ': ' + stderr.slice(0, 500) : ''}`,
            metadata: { exitCode: code, stderr: stderr.slice(0, 2000) },
          });
          return;
        }

        const stdoutTrim = stdout.trim();
        const looksLikeRuntimeError =
          stdoutTrim.length > 0
          && !stdoutTrim.startsWith('{')
          && !stdoutTrim.startsWith('[')
          && /^(error(?:\s+processing)?|exception|traceback|failed)\b/i.test(stdoutTrim);

        if (looksLikeRuntimeError) {
          const firstLine = stdoutTrim.split('\n')[0] || stdoutTrim;
          finalize({
            success: false,
            content: stdout,
            error: `Script reported error output: ${firstLine}`,
            metadata: { exitCode: 0, stderr: stderr.slice(0, 2000), stdout: stdoutTrim.slice(0, 2000) },
            promptUsed: `[${config.runtime}] ${config.script.slice(0, 200)}`,
            modelUsed: config.runtime,
          });
          return;
        }

        finalize({
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
        finalize({
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

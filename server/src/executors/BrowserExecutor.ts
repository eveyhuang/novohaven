import { RecipeStep, StepExecution } from '../types';
import { browserService } from '../services/browserService';
import { queries } from '../models/database';
import type { Page } from 'puppeteer';
import {
  StepExecutor,
  StepExecutorContext,
  StepExecutorResult,
  ExecutorConfigSchema,
} from './StepExecutor';

type BrowserActionType =
  | 'navigate'
  | 'wait'
  | 'click'
  | 'type'
  | 'press'
  | 'scroll'
  | 'extract';

interface BrowserAction {
  type: BrowserActionType;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  amount?: number;
  name?: string;
  attribute?: string;
  multiple?: boolean;
  timeoutMs?: number;
}

interface BrowserExtractor {
  name: string;
  selector: string;
  attribute?: string;
  multiple?: boolean;
}

interface BrowserConfig {
  startUrl?: string;
  actions?: BrowserAction[];
  extractors?: BrowserExtractor[];
  defaultWaitMs?: number;
  defaultTimeoutMs?: number;
  maxItems?: number;
}

const DEFAULT_CONFIG: BrowserConfig = {
  startUrl: '',
  actions: [],
  extractors: [],
  defaultWaitMs: 1000,
  defaultTimeoutMs: 30000,
  maxItems: 20,
};

const BROWSER_CONCURRENCY_RETRY_COUNT = Math.max(
  0,
  parseInt(process.env.BROWSER_CONCURRENCY_RETRY_COUNT || '2', 10)
);
const BROWSER_CONCURRENCY_RETRY_DELAY_MS = Math.max(
  200,
  parseInt(process.env.BROWSER_CONCURRENCY_RETRY_DELAY_MS || '1500', 10)
);
const BROWSER_EXECUTOR_TASK_RETENTION_MS = Math.max(
  0,
  parseInt(process.env.BROWSER_EXECUTOR_TASK_RETENTION_MS || '0', 10)
);

export class BrowserExecutor implements StepExecutor {
  type = 'browser';
  displayName = 'Browser Automation';
  icon = '🖥️';
  description = 'Navigate pages, click/type/scroll, and extract structured results from the browser.';

  validateConfig(step: RecipeStep): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const config = this.parseConfig(step);
    const hasStartUrl = !!(config.startUrl && String(config.startUrl).trim());
    const hasNavigateAction = (config.actions || []).some((a) => a.type === 'navigate' && a.url);
    if (!hasStartUrl && !hasNavigateAction) {
      errors.push('Browser step requires startUrl or a navigate action with url');
    }
    return { valid: errors.length === 0, errors };
  }

  async execute(step: RecipeStep, context: StepExecutorContext): Promise<StepExecutorResult> {
    const config = this.parseConfig(step);
    const variables = this.buildVariableMap(context.userInputs, context.completedStepExecutions);
    const resolvedConfig = this.resolveConfig(config, variables);
    const browserTaskId = browserService.createTask();
    const task = browserService.getTask(browserTaskId);

    if (!task) {
      return {
        success: false,
        content: '',
        error: 'Failed to initialize browser task',
      };
    }

    const { emitter, executionId } = context;

    try {
      const earlyMetadata = JSON.stringify({ browserTaskId, stepType: 'browser' });
      queries.updateStepExecution(
        'running',
        earlyMetadata,
        'browser:automation',
        step.prompt_template || '',
        context.stepExecution.id
      );

      this.emitProgress(task, emitter, executionId, context.stepExecution, step, 'Launching browser automation step...');
      const page = await this.launchBrowserWithRetry(
        browserTaskId,
        task,
        emitter,
        executionId,
        context.stepExecution,
        step
      );
      const timeoutMs = resolvedConfig.defaultTimeoutMs || DEFAULT_CONFIG.defaultTimeoutMs!;
      const waitMs = resolvedConfig.defaultWaitMs || DEFAULT_CONFIG.defaultWaitMs!;
      const maxItems = resolvedConfig.maxItems || DEFAULT_CONFIG.maxItems!;

      const extracted: Record<string, any> = {};
      const events: string[] = [];

      // Start URL (if provided)
      if (resolvedConfig.startUrl) {
        this.emitProgress(task, emitter, executionId, context.stepExecution, step, `Navigating to ${resolvedConfig.startUrl}`);
        await page.goto(resolvedConfig.startUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await this.sleep(waitMs);
        events.push(`navigate:${resolvedConfig.startUrl}`);
      }

      // Execute action plan
      for (const [idx, action] of (resolvedConfig.actions || []).entries()) {
        const actionTimeout = action.timeoutMs || timeoutMs;
        switch (action.type) {
          case 'navigate': {
            if (!action.url) throw new Error(`Action #${idx + 1} navigate requires url`);
            this.emitProgress(task, emitter, executionId, context.stepExecution, step, `Action ${idx + 1}: navigate`);
            await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: actionTimeout });
            await this.sleep(waitMs);
            events.push(`navigate:${action.url}`);
            break;
          }
          case 'wait': {
            if (action.selector) {
              this.emitProgress(task, emitter, executionId, context.stepExecution, step, `Action ${idx + 1}: wait for ${action.selector}`);
              await page.waitForSelector(action.selector, { timeout: actionTimeout });
            } else {
              await this.sleep(action.amount || waitMs);
            }
            events.push(`wait:${action.selector || action.amount || waitMs}`);
            break;
          }
          case 'click': {
            if (!action.selector) throw new Error(`Action #${idx + 1} click requires selector`);
            this.emitProgress(task, emitter, executionId, context.stepExecution, step, `Action ${idx + 1}: click ${action.selector}`);
            await page.waitForSelector(action.selector, { timeout: actionTimeout });
            await page.click(action.selector);
            await this.sleep(waitMs);
            events.push(`click:${action.selector}`);
            break;
          }
          case 'type': {
            if (!action.selector) throw new Error(`Action #${idx + 1} type requires selector`);
            this.emitProgress(task, emitter, executionId, context.stepExecution, step, `Action ${idx + 1}: type into ${action.selector}`);
            await page.waitForSelector(action.selector, { timeout: actionTimeout });
            await page.focus(action.selector);
            await page.click(action.selector, { clickCount: 3 }).catch(() => undefined);
            await page.keyboard.type(action.text || '');
            await this.sleep(Math.min(waitMs, 500));
            events.push(`type:${action.selector}`);
            break;
          }
          case 'press': {
            const key = action.key || 'Enter';
            this.emitProgress(task, emitter, executionId, context.stepExecution, step, `Action ${idx + 1}: press ${key}`);
            await page.keyboard.press(key as any);
            await this.sleep(waitMs);
            events.push(`press:${key}`);
            break;
          }
          case 'scroll': {
            const amount = action.amount || 1200;
            this.emitProgress(task, emitter, executionId, context.stepExecution, step, `Action ${idx + 1}: scroll ${amount}px`);
            await page.evaluate((stepAmount: number) => window.scrollBy(0, stepAmount), amount);
            await this.sleep(waitMs);
            events.push(`scroll:${amount}`);
            break;
          }
          case 'extract': {
            if (!action.selector) throw new Error(`Action #${idx + 1} extract requires selector`);
            const key = action.name || `extract_${idx + 1}`;
            const values = await this.extractFromSelector(
              page,
              action.selector,
              action.attribute,
              action.multiple ?? true,
              maxItems
            );
            extracted[key] = action.multiple === false ? values[0] || '' : values;
            events.push(`extract:${key}`);
            break;
          }
          default:
            throw new Error(`Unsupported action type: ${(action as any).type}`);
        }
      }

      // Run extractors after actions
      for (const extractor of resolvedConfig.extractors || []) {
        if (!extractor.name || !extractor.selector) continue;
        this.emitProgress(task, emitter, executionId, context.stepExecution, step, `Extracting ${extractor.name}`);
        const values = await this.extractFromSelector(
          page,
          extractor.selector,
          extractor.attribute,
          extractor.multiple ?? true,
          maxItems
        );
        extracted[extractor.name] = extractor.multiple === false ? values[0] || '' : values;
      }

      const output = {
        url: page.url(),
        title: await page.title(),
        extracted,
        events,
      };
      const content = this.formatContent(output, step.output_format);
      browserService.emit(task, 'complete', { output: content });

      return {
        success: true,
        content,
        metadata: {
          service: 'browser',
          browserTaskId,
          extractedCount: Object.keys(extracted).length,
          stepType: 'browser',
        },
        modelUsed: 'browser:automation',
      };
    } catch (error: any) {
      browserService.emit(task, 'error', { error: error.message || 'Browser execution failed' });
      return {
        success: false,
        content: '',
        error: `Browser execution error: ${error.message || 'Unknown error'}`,
      };
    } finally {
      if (BROWSER_EXECUTOR_TASK_RETENTION_MS > 0) {
        // Optional short retention for debugging reconnects.
        setTimeout(async () => {
          await browserService.destroyTask(browserTaskId).catch(() => undefined);
        }, BROWSER_EXECUTOR_TASK_RETENTION_MS);
      } else {
        // Default: release browser capacity immediately after step finishes/fails.
        await browserService.destroyTask(browserTaskId).catch(() => undefined);
      }
    }
  }

  getConfigSchema(): ExecutorConfigSchema {
    return {
      fields: [
        {
          name: 'startUrl',
          label: 'Start URL',
          type: 'text',
          required: false,
          helpText: 'Optional start URL. Supports variables like {{target_url}}.',
        },
        {
          name: 'actions',
          label: 'Action Plan (JSON)',
          type: 'json',
          required: false,
          helpText: 'Array of actions: navigate/wait/click/type/press/scroll/extract. Example: [{"type":"navigate","url":"https://example.com"},{"type":"extract","name":"titles","selector":"h2","multiple":true}]',
        },
        {
          name: 'extractors',
          label: 'Extractors (JSON)',
          type: 'json',
          required: false,
          helpText: 'Optional extraction rules run after actions. Example: [{"name":"titles","selector":"h2","multiple":true}]',
        },
        {
          name: 'defaultWaitMs',
          label: 'Default Wait (ms)',
          type: 'number',
          defaultValue: 1000,
          helpText: 'Wait time after each action.',
        },
        {
          name: 'defaultTimeoutMs',
          label: 'Default Timeout (ms)',
          type: 'number',
          defaultValue: 30000,
          helpText: 'Default timeout for navigation and selector operations.',
        },
        {
          name: 'maxItems',
          label: 'Max Extracted Items',
          type: 'number',
          defaultValue: 20,
          helpText: 'Maximum number of values returned per extractor/action.',
        },
      ],
    };
  }

  private parseConfig(step: RecipeStep): BrowserConfig {
    if (!step.executor_config) return { ...DEFAULT_CONFIG };
    try {
      const parsed = JSON.parse(step.executor_config);
      return {
        ...DEFAULT_CONFIG,
        ...(parsed || {}),
        actions: Array.isArray(parsed?.actions) ? parsed.actions : [],
        extractors: Array.isArray(parsed?.extractors) ? parsed.extractors : [],
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  private buildVariableMap(userInputs: Record<string, any>, completed: StepExecution[]): Record<string, string> {
    const vars: Record<string, string> = {};

    const addObjectFields = (prefix: string, value: any, depth: number = 0) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return;
      for (const [key, nested] of Object.entries(value)) {
        const path = `${prefix}.${key}`;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          addObjectFields(path, nested, depth + 1);
        } else {
          vars[path] = typeof nested === 'string' ? nested : JSON.stringify(nested);
        }
      }
    };

    const tryParseObject = (raw: any): Record<string, any> | null => {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Record<string, any>;
      }
      if (typeof raw !== 'string') return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, any>;
        }
      } catch {
        // Ignore parse failures.
      }
      return null;
    };

    for (const [key, val] of Object.entries(userInputs || {})) {
      vars[key] = typeof val === 'string' ? val : JSON.stringify(val);
    }
    for (const step of completed || []) {
      const outputKey = `step_${step.step_order}_output`;
      let value = '';
      try {
        if (step.output_data) {
          const parsed = JSON.parse(step.output_data);
          const content = parsed?.content ?? parsed;
          value = typeof content === 'string' ? content : JSON.stringify(content);
          const contentObject = tryParseObject(content);
          if (contentObject) {
            addObjectFields(outputKey, contentObject);
          }
        }
      } catch {
        value = step.output_data || '';
      }
      vars[outputKey] = value;
    }
    return vars;
  }

  private resolveConfig(config: BrowserConfig, vars: Record<string, string>): BrowserConfig {
    const resolve = (value: any): any => {
      if (typeof value === 'string') {
        return value.replace(/\{\{([^}]+)\}\}/g, (_match, varName) => {
          const key = String(varName || '').trim();
          return key in vars ? String(vars[key]) : _match;
        });
      }
      if (Array.isArray(value)) return value.map((item) => resolve(item));
      if (value && typeof value === 'object') {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) {
          out[k] = resolve(v);
        }
        return out;
      }
      return value;
    };

    const resolved = resolve(config) as BrowserConfig;
    if (!resolved.startUrl || !String(resolved.startUrl).trim()) {
      const fallbackUrl = vars.target_url || vars.url || vars.product_url || vars.website;
      if (fallbackUrl) resolved.startUrl = fallbackUrl;
    }

    // Normalize common URL inputs like "www.amazon.com" for browser navigation.
    if (resolved.startUrl) {
      resolved.startUrl = this.normalizeNavigableUrl(resolved.startUrl);
    }
    if (Array.isArray(resolved.actions)) {
      resolved.actions = resolved.actions.map((action) => {
        if (action?.type === 'navigate' && action.url) {
          return { ...action, url: this.normalizeNavigableUrl(action.url) };
        }
        return action;
      });
    }

    return resolved;
  }

  private normalizeNavigableUrl(raw: string): string {
    let value = String(raw || '').trim();
    if (!value) return value;

    // Strip simple accidental wrapping quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }

    // Remove embedded whitespace that can break navigation.
    value = value.replace(/\s+/g, '');

    // Collapse duplicated protocol prefixes like "https://https://example.com".
    while (/^(https?:\/\/)(https?:\/\/)/i.test(value)) {
      value = value.replace(/^(https?:\/\/)(https?:\/\/)/i, '$1');
    }

    // Keep explicit schemes (http, https, file, about, chrome, etc.)
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
    if (value.startsWith('//')) return `https:${value}`;

    // Common user input: domain without protocol.
    if (value.startsWith('www.')) return `https://${value}`;
    if (!/\s/.test(value) && /^[\w.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(value)) {
      return `https://${value}`;
    }

    return value;
  }

  private async extractFromSelector(
    page: any,
    selector: string,
    attribute: string | undefined,
    multiple: boolean,
    maxItems: number
  ): Promise<string[]> {
    const values = await page.$$eval(
      selector,
      (nodes: Element[], attr: string, max: number) => {
        return nodes.slice(0, max).map((node: Element) => {
          const element = node as HTMLElement;
          if (attr) return element.getAttribute(attr) || '';
          return (element.innerText || element.textContent || '').trim();
        }).filter(Boolean);
      },
      attribute || '',
      Math.max(1, maxItems)
    );
    if (!multiple) {
      return values.length > 0 ? [values[0]] : [];
    }
    return values;
  }

  private formatContent(output: Record<string, any>, outputFormat: RecipeStep['output_format']): string {
    if (outputFormat === 'json') {
      return JSON.stringify(output, null, 2);
    }
    if (outputFormat === 'markdown') {
      const sections: string[] = [
        `# Browser Automation Result`,
        `- URL: ${output.url}`,
        `- Title: ${output.title}`,
        ``,
        `## Extracted Data`,
      ];
      for (const [key, value] of Object.entries(output.extracted || {})) {
        if (Array.isArray(value)) {
          sections.push(`### ${key}`);
          value.forEach((item) => sections.push(`- ${item}`));
        } else {
          sections.push(`- **${key}**: ${String(value)}`);
        }
      }
      return sections.join('\n');
    }
    return `Browser automation completed on "${output.title}" (${output.url}). Extracted keys: ${Object.keys(output.extracted || {}).join(', ') || 'none'}.`;
  }

  private emitProgress(
    task: any,
    emitter: StepExecutorContext['emitter'],
    executionId: number,
    stepExecution: StepExecutorContext['stepExecution'],
    step: RecipeStep,
    message: string
  ): void {
    browserService.emit(task, 'message', {
      role: 'system',
      content: [{ type: 'text', text: message }],
    });
    if (emitter) {
      const progressMsg = emitter.createMessage({
        executionId,
        stepOrder: stepExecution.step_order,
        stepName: step.step_name,
        stepType: 'browser',
        type: 'progress',
        role: 'system',
        content: message,
        metadata: { taskId: task.id },
      });
      emitter.emit(executionId, progressMsg);
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  private async launchBrowserWithRetry(
    taskId: string,
    task: any,
    emitter: StepExecutorContext['emitter'],
    executionId: number,
    stepExecution: StepExecutorContext['stepExecution'],
    step: RecipeStep
  ): Promise<Page> {
    let attempt = 0;

    while (true) {
      try {
        return await browserService.launchBrowser(taskId);
      } catch (error: any) {
        const message = String(error?.message || '');
        const isCapacityError = message.includes('Max concurrent browsers');

        if (!isCapacityError || attempt >= BROWSER_CONCURRENCY_RETRY_COUNT) {
          throw error;
        }

        attempt += 1;
        const waitMs = BROWSER_CONCURRENCY_RETRY_DELAY_MS * attempt;
        this.emitProgress(
          task,
          emitter,
          executionId,
          stepExecution,
          step,
          `Browser capacity busy. Retrying launch (${attempt}/${BROWSER_CONCURRENCY_RETRY_COUNT}) in ${Math.ceil(waitMs / 1000)}s...`
        );
        await this.sleep(waitMs);
      }
    }
  }
}

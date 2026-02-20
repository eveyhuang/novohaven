import {
  ToolPlugin, PluginManifest, ToolDefinition, ToolContext, ToolResult,
} from '../../types';

type BrowserRef = {
  selector: string;
  role: string;
  label: string;
};

type SessionBrowserState = {
  taskId: string;
  refs: Map<number, BrowserRef>;
};

class BrowserToolPlugin implements ToolPlugin {
  manifest: PluginManifest;
  private config: Record<string, any> = {};
  private sessions = new Map<string, SessionBrowserState>();
  private readonly defaultTimeoutMs = 30000;
  private readonly defaultMaxNodes = 80;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    this.config = config;
  }

  async shutdown(): Promise<void> {
    const { browserService } = require('../../../services/browserService');
    for (const state of this.sessions.values()) {
      await browserService.destroyTask(state.taskId).catch(() => undefined);
    }
    this.sessions.clear();
  }

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'browser_navigate',
        description: 'Navigate to a URL and return a semantic page snapshot with reference IDs for interaction.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to navigate to' },
            waitFor: { type: 'string', description: 'Optional CSS selector to wait for' },
            maxNodes: { type: 'number', description: 'Max snapshot nodes to return (default 80)' },
          },
          required: ['url'],
        },
      },
      {
        name: 'browser_interact',
        description: 'Interact with current page using ref IDs or selectors: click, type, scroll, extract.',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['click', 'type', 'extract', 'scroll'], description: 'Interaction type' },
            ref: { type: 'number', description: 'Reference number from latest snapshot' },
            selector: { type: 'string', description: 'CSS selector (alternative to ref)' },
            text: { type: 'string', description: 'Text to type when action=type' },
            amount: { type: 'number', description: 'Pixels to scroll when action=scroll (default 1200)' },
            attribute: { type: 'string', description: 'Attribute name to extract when action=extract' },
            maxNodes: { type: 'number', description: 'Max snapshot nodes when returning updated snapshot' },
            snapshot: { type: 'boolean', description: 'Include updated snapshot after action (default true)' },
          },
          required: ['action'],
        },
      },
      {
        name: 'browser_snapshot',
        description: 'Return a semantic snapshot of the current page with reference IDs.',
        parameters: {
          type: 'object',
          properties: {
            maxNodes: { type: 'number', description: 'Max snapshot nodes to return (default 80)' },
          },
        },
      },
      {
        name: 'browser_screenshot',
        description: 'Capture a screenshot of the current page as base64 data in metadata.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'browser_close',
        description: 'Close and cleanup browser state for this chat session.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    ];
  }

  async execute(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const normalized = String(toolName || '').replace(':', '_').toLowerCase();
      switch (normalized) {
        case 'browser_navigate':
          return this.navigate(args, context);
        case 'browser_interact':
          return this.interact(args, context);
        case 'browser_snapshot':
          return this.snapshot(args, context);
        case 'browser_screenshot':
          return this.screenshot(context);
        case 'browser_close':
          return this.close(context);
        default:
          return { success: false, output: `Unknown browser tool: ${toolName}` };
      }
    } catch (err: any) {
      return { success: false, output: `Browser error: ${err.message}` };
    }
  }

  private async navigate(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const url = String(args.url || '').trim();
    if (!url) return { success: false, output: 'Missing required parameter: url' };

    const state = await this.ensureSessionTask(context);
    const { browserService } = require('../../../services/browserService');
    const task = browserService.getTask(state.taskId);
    if (!task?.page) return { success: false, output: 'No active browser page for this session.' };

    const timeout = this.getTimeout();
    await task.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    if (args.waitFor) {
      await task.page.waitForSelector(String(args.waitFor), { timeout }).catch(() => undefined);
    }
    await this.sleep(400);

    const snapshot = await this.captureSemanticSnapshot(state, task.page, args.maxNodes);
    return {
      success: true,
      output: [
        `Navigated to: ${task.page.url()}`,
        `Title: ${await task.page.title()}`,
        '',
        snapshot.text,
      ].join('\n'),
      metadata: { taskId: state.taskId, refs: snapshot.count },
    };
  }

  private async interact(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const action = String(args.action || '').trim().toLowerCase();
    if (!action) return { success: false, output: 'Missing required parameter: action' };

    const state = await this.ensureSessionTask(context);
    const { browserService } = require('../../../services/browserService');
    const task = browserService.getTask(state.taskId);
    if (!task?.page) return { success: false, output: 'No active browser page for this session.' };
    const page = task.page;
    const selector = this.resolveSelector(state, args);

    switch (action) {
      case 'click': {
        if (!selector) return { success: false, output: 'Click requires ref or selector. Call browser_snapshot first.' };
        const timeout = this.getTimeout();
        const navWait = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => null);
        await page.click(selector, { timeout });
        await navWait;
        await this.sleep(300);
        break;
      }
      case 'type': {
        if (!selector) return { success: false, output: 'Type requires ref or selector. Call browser_snapshot first.' };
        const text = String(args.text || '');
        if (!text) return { success: false, output: 'Type action requires non-empty text.' };
        const timeout = this.getTimeout();
        await page.focus(selector);
        await page.click(selector, { clickCount: 3, timeout }).catch(() => undefined);
        await page.keyboard.type(text);
        await this.sleep(200);
        break;
      }
      case 'scroll': {
        const amount = Number.isFinite(Number(args.amount)) ? Number(args.amount) : 1200;
        await page.evaluate((step: number) => {
          window.scrollBy(0, step);
        }, amount);
        await this.sleep(250);
        break;
      }
      case 'extract': {
        if (!selector) return { success: false, output: 'Extract requires ref or selector. Call browser_snapshot first.' };
        const attribute = args.attribute ? String(args.attribute) : '';
        const extracted = await page.$$eval(selector, (nodes: Element[], attr: string) => {
          return nodes.slice(0, 20).map((node: Element) => {
            const el = node as HTMLElement;
            const text = (el.innerText || el.textContent || '').trim();
            const value = attr ? el.getAttribute(attr) || '' : '';
            return { text, value };
          });
        }, attribute);
        return {
          success: true,
          output: `Extracted ${extracted.length} node(s) from "${selector}":\n${JSON.stringify(extracted, null, 2)}`,
          metadata: { taskId: state.taskId, selector, extractedCount: extracted.length },
        };
      }
      default:
        return { success: false, output: `Unsupported browser_interact action: ${action}` };
    }

    const includeSnapshot = args.snapshot !== false;
    if (!includeSnapshot) {
      return {
        success: true,
        output: `Action "${action}" completed${selector ? ` on ${selector}` : ''}.`,
        metadata: { taskId: state.taskId, action, selector },
      };
    }

    const snapshot = await this.captureSemanticSnapshot(state, page, args.maxNodes);
    return {
      success: true,
      output: [
        `Action "${action}" completed${selector ? ` on ${selector}` : ''}.`,
        '',
        snapshot.text,
      ].join('\n'),
      metadata: { taskId: state.taskId, action, selector, refs: snapshot.count },
    };
  }

  private async snapshot(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const state = await this.ensureSessionTask(context);
    const { browserService } = require('../../../services/browserService');
    const task = browserService.getTask(state.taskId);
    if (!task?.page) return { success: false, output: 'No active browser page for this session.' };

    const snapshot = await this.captureSemanticSnapshot(state, task.page, args.maxNodes);
    return {
      success: true,
      output: snapshot.text,
      metadata: { taskId: state.taskId, refs: snapshot.count, url: task.page.url() },
    };
  }

  private async screenshot(context: ToolContext): Promise<ToolResult> {
    const state = await this.ensureSessionTask(context);
    const { browserService } = require('../../../services/browserService');
    const image = await browserService.takeScreenshot(state.taskId);
    if (!image) return { success: false, output: 'Unable to capture screenshot.' };
    return {
      success: true,
      output: `Captured screenshot for task ${state.taskId}.`,
      metadata: { taskId: state.taskId, imageBase64: image },
    };
  }

  private async close(context: ToolContext): Promise<ToolResult> {
    const state = this.sessions.get(context.sessionId);
    if (!state) return { success: true, output: 'No active browser session to close.' };
    const { browserService } = require('../../../services/browserService');
    await browserService.destroyTask(state.taskId);
    this.sessions.delete(context.sessionId);
    return { success: true, output: `Closed browser session for ${context.sessionId}.` };
  }

  private async ensureSessionTask(context: ToolContext): Promise<SessionBrowserState> {
    const { browserService } = require('../../../services/browserService');
    const existing = this.sessions.get(context.sessionId);
    if (existing) {
      const task = browserService.getTask(existing.taskId);
      if (task?.page) return existing;
      this.sessions.delete(context.sessionId);
    }

    const taskId = browserService.createTask();
    await browserService.launchBrowser(taskId);
    const nextState: SessionBrowserState = { taskId, refs: new Map() };
    this.sessions.set(context.sessionId, nextState);
    return nextState;
  }

  private resolveSelector(state: SessionBrowserState, args: Record<string, any>): string | null {
    if (args.selector) return String(args.selector);
    if (args.ref == null) return null;
    const ref = Number(args.ref);
    if (!Number.isFinite(ref)) return null;
    return state.refs.get(ref)?.selector || null;
  }

  private getTimeout(): number {
    const configured = Number(this.config.timeout);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return this.defaultTimeoutMs;
  }

  private async captureSemanticSnapshot(
    state: SessionBrowserState,
    page: any,
    maxNodesRaw?: any
  ): Promise<{ text: string; count: number }> {
    const maxNodes = Number.isFinite(Number(maxNodesRaw))
      ? Math.max(10, Math.min(200, Number(maxNodesRaw)))
      : this.defaultMaxNodes;

    const snapshot = await page.evaluate((limit: number) => {
      const esc = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      const isVisible = (el: HTMLElement) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0;
      };

      const selectorFor = (el: Element): string => {
        const element = el as HTMLElement;
        const escapeCss = (s: string) => {
          const cssObj = (window as any).CSS;
          if (cssObj && typeof cssObj.escape === 'function') {
            return cssObj.escape(s);
          }
          return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        };
        if (element.id) return `#${escapeCss(element.id)}`;
        const testId = element.getAttribute('data-testid');
        if (testId) return `[data-testid="${esc(testId)}"]`;

        const parts: string[] = [];
        let current: Element | null = element;
        let depth = 0;
        while (current && depth < 6) {
          const tag = current.tagName.toLowerCase();
          const parentEl = current.parentElement as HTMLElement | null;
          if (!parentEl) {
            parts.unshift(tag);
            break;
          }
          const siblings = Array.from(parentEl.children).filter((c: Element) => c.tagName === current!.tagName);
          const nth = siblings.indexOf(current) + 1;
          parts.unshift(`${tag}:nth-of-type(${nth})`);
          if (parentEl.id) {
            parts.unshift(`#${escapeCss(parentEl.id)}`);
            break;
          }
          current = parentEl;
          depth += 1;
        }
        return parts.join(' > ');
      };

      const roleFor = (el: HTMLElement): string => {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'select') return 'combobox';
        if (tag === 'img') return 'image';
        if (tag.match(/^h[1-6]$/)) return 'heading';
        if (tag === 'li') return 'listitem';
        if (tag === 'input') {
          const type = (el as HTMLInputElement).type || 'text';
          if (['text', 'email', 'search', 'url', 'tel', 'password'].includes(type)) return 'textbox';
          if (['submit', 'button', 'reset'].includes(type)) return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
        }
        return tag;
      };

      const labelFor = (el: HTMLElement): string => {
        const attrs = ['aria-label', 'title', 'placeholder', 'alt'];
        for (const attr of attrs) {
          const v = el.getAttribute(attr);
          if (v && v.trim()) return v.trim();
        }
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, 160);
        return '';
      };

      const selectors = [
        'button',
        'a[href]',
        'input',
        'textarea',
        'select',
        '[role]',
        'h1,h2,h3',
        'li',
        '[data-testid]',
      ];

      const seen = new Set<string>();
      const nodes: Array<{ role: string; label: string; selector: string }> = [];
      for (const selector of selectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          if (nodes.length >= limit) break;
          const el = node as HTMLElement;
          if (!isVisible(el)) continue;
          const role = roleFor(el);
          const label = labelFor(el);
          const interactive = ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox'].includes(role);
          const semantic = ['heading', 'listitem'].includes(role);
          if (!interactive && !semantic) continue;
          if (!label && !interactive) continue;
          const css = selectorFor(el);
          if (!css || seen.has(css)) continue;
          seen.add(css);
          nodes.push({ role, label, selector: css });
        }
      }

      return {
        title: document.title || '',
        url: location.href,
        nodes,
      };
    }, maxNodes);

    state.refs.clear();
    const lines: string[] = [];
    let ref = 1;
    for (const node of snapshot.nodes as Array<{ role: string; label: string; selector: string }>) {
      state.refs.set(ref, { selector: node.selector, role: node.role, label: node.label });
      const labelPart = node.label ? ` "${node.label.replace(/\s+/g, ' ').trim()}"` : '';
      lines.push(`- ${node.role}${labelPart} [ref=${ref}]`);
      ref += 1;
    }

    const body = lines.length > 0
      ? lines.join('\n')
      : '- (No visible actionable elements detected)';

    return {
      text: [
        `Page: ${snapshot.title || '(untitled)'}`,
        `URL: ${snapshot.url}`,
        'Semantic Snapshot:',
        body,
        '',
        'Use browser_interact with action + ref (or selector) for next step.',
      ].join('\n'),
      count: lines.length,
    };
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export default BrowserToolPlugin;

import puppeteer, { Browser, Page } from 'puppeteer';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

// Patterns matched against VISIBLE page text (not full HTML) to detect active CAPTCHA challenges
const VISIBLE_TEXT_PATTERNS = [
  /press\s*&?\s*hold/i,
  /solve.*captcha/i,
  /complete\s+(this|the)\s+(verification|captcha|challenge)/i,
  /bot\s+detection/i,
  /please\s+verify\s+(you\s+are|that\s+you)/i,
  /are\s+you\s+a\s+(human|robot)/i,
];

// CSS selectors for known CAPTCHA challenge elements that must be visible
const CAPTCHA_SELECTORS = [
  '#px-captcha',           // PerimeterX active challenge
  '.cf-challenge-running', // Cloudflare active challenge
  '#challenge-running',    // Cloudflare variant
  'iframe[src*="captcha"]',
  'iframe[src*="challenge"]',
  '[data-captcha]',
];

export interface BrowserTask {
  id: string;
  browser: Browser | null;
  page: Page | null;
  status: 'created' | 'launching' | 'running' | 'captcha' | 'completed' | 'failed';
  emitter: EventEmitter;
  createdAt: number;
  timeoutHandle: NodeJS.Timeout | null;
}

export interface BrowserProgressEvent {
  type: 'status' | 'message' | 'take_control' | 'complete' | 'error';
  data: Record<string, any>;
}

const BROWSER_TIMEOUT = parseInt(process.env.BROWSER_TIMEOUT || '900000', 10); // 15 min
const BROWSER_MAX_CONCURRENT = parseInt(process.env.BROWSER_MAX_CONCURRENT || '5', 10); // Increased from 2 to 5
const BROWSER_DEBUG_PORT = parseInt(process.env.BROWSER_DEBUG_PORT || '9222', 10);
const BROWSER_HEADLESS = process.env.BROWSER_HEADLESS === 'true';

class BrowserService {
  private tasks = new Map<string, BrowserTask>();
  private activeBrowserCount = 0;

  createTask(): string {
    const taskId = uuidv4();
    const task: BrowserTask = {
      id: taskId,
      browser: null,
      page: null,
      status: 'created',
      emitter: new EventEmitter(),
      createdAt: Date.now(),
      timeoutHandle: null,
    };
    this.tasks.set(taskId, task);
    console.log(`[BrowserService] Created task ${taskId}, total active tasks: ${this.tasks.size}`);
    return taskId;
  }

  getTask(taskId: string): BrowserTask | undefined {
    return this.tasks.get(taskId);
  }

  async launchBrowser(taskId: string): Promise<Page> {
    console.log(`[BrowserService] launchBrowser called for task ${taskId}`);
    const task = this.tasks.get(taskId);
    if (!task) {
      console.error(`[BrowserService] Task ${taskId} not found in tasks map`);
      throw new Error(`Task ${taskId} not found`);
    }

    console.log(`[BrowserService] Active browsers: ${this.activeBrowserCount}/${BROWSER_MAX_CONCURRENT}`);
    if (this.activeBrowserCount >= BROWSER_MAX_CONCURRENT) {
      throw new Error(`Max concurrent browsers (${BROWSER_MAX_CONCURRENT}) reached. Wait for another task to complete.`);
    }

    task.status = 'launching';
    console.log(`[BrowserService] Setting task ${taskId} status to 'launching'`);
    this.emit(task, 'status', { status: 'launching', message: 'Launching browser...' });

    try {
      const launchOptions: any = {
        headless: BROWSER_HEADLESS,
        args: [
          `--remote-debugging-port=${BROWSER_DEBUG_PORT}`,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1920,1080',
        ],
        defaultViewport: { width: 1920, height: 1080 },
      };

      if (process.env.CHROME_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.CHROME_EXECUTABLE_PATH;
      }

      task.browser = await puppeteer.launch(launchOptions);
      this.activeBrowserCount++;

      const pages = await task.browser.pages();
      task.page = pages[0] || await task.browser.newPage();

      // Set a realistic user agent
      await task.page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      );

      task.status = 'running';
      this.emit(task, 'status', { status: 'running', message: 'Browser launched' });

      // Set hard timeout
      task.timeoutHandle = setTimeout(() => {
        this.emit(task, 'error', { error: `Task timed out after ${BROWSER_TIMEOUT / 1000}s` });
        this.destroyTask(taskId);
      }, BROWSER_TIMEOUT);

      return task.page;
    } catch (error: any) {
      task.status = 'failed';
      this.emit(task, 'error', { error: `Failed to launch browser: ${error.message}` });
      throw error;
    }
  }

  async navigate(taskId: string, url: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task?.page) throw new Error(`Task ${taskId} has no active page`);

    this.emit(task, 'message', { role: 'system', content: [{ type: 'text', text: `Navigating to ${url}` }] });
    await task.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  }

  async scrollIncrementally(
    taskId: string,
    totalDistance: number = 8000,
    stepSize: number = 2000,
    delayMs: number = 1000,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task?.page) throw new Error(`Task ${taskId} has no active page`);

    this.emit(task, 'message', { role: 'system', content: [{ type: 'text', text: 'Scrolling to load reviews section...' }] });

    for (let scrolled = 0; scrolled < totalDistance; scrolled += stepSize) {
      await task.page.evaluate((step: number) => {
        window.scrollBy(0, step);
      }, stepSize);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  async evaluateInPage<T>(taskId: string, script: string): Promise<T> {
    const task = this.tasks.get(taskId);
    if (!task?.page) throw new Error(`Task ${taskId} has no active page`);

    return task.page.evaluate(script) as Promise<T>;
  }

  async detectCaptcha(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task?.page) return false;

    try {
      // Check for visible CAPTCHA elements in the DOM
      const hasVisibleCaptchaElement = await task.page.evaluate((selectors: string[]) => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) {
            const rect = (el as HTMLElement).getBoundingClientRect();
            const style = window.getComputedStyle(el as HTMLElement);
            // Element must exist and be visible (not hidden/zero-sized)
            if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
              return true;
            }
          }
        }
        return false;
      }, CAPTCHA_SELECTORS);

      if (hasVisibleCaptchaElement) {
        task.status = 'captcha';
        this.emit(task, 'take_control', {
          browserUrl: `http://localhost:${BROWSER_DEBUG_PORT}`,
          message: 'CAPTCHA detected. Please solve it in the browser, then click Resume.',
        });
        return true;
      }

      // Check visible text content (not full HTML which includes scripts)
      const visibleText = await task.page.evaluate(() => document.body.innerText);
      for (const pattern of VISIBLE_TEXT_PATTERNS) {
        if (pattern.test(visibleText)) {
          task.status = 'captcha';
          this.emit(task, 'take_control', {
            browserUrl: `http://localhost:${BROWSER_DEBUG_PORT}`,
            message: 'CAPTCHA detected. Please solve it in the browser, then click Resume.',
          });
          return true;
        }
      }
    } catch {
      // Page may have navigated; ignore
    }
    return false;
  }

  async waitForCaptchaResolution(taskId: string, timeoutMs: number = 300000): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('CAPTCHA resolution timed out'));
      }, timeoutMs);

      task.emitter.once('captcha_resolved', () => {
        clearTimeout(timeout);
        task.status = 'running';
        this.emit(task, 'status', { status: 'running', message: 'CAPTCHA resolved, resuming...' });
        resolve();
      });
    });
  }

  signalCaptchaResolved(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    task.emitter.emit('captcha_resolved');
    return true;
  }

  async takeScreenshot(taskId: string): Promise<string | null> {
    const task = this.tasks.get(taskId);
    if (!task?.page) return null;

    try {
      const buffer = await task.page.screenshot({ encoding: 'base64' });
      return buffer as string;
    } catch {
      return null;
    }
  }

  emit(task: BrowserTask, type: string, data: Record<string, any>): void {
    console.log(`[BrowserService] Emitting event to task ${task.id}: type=${type}, listeners=${task.emitter.listenerCount('progress')}`);
    console.log(`[BrowserService] Event data:`, JSON.stringify(data).substring(0, 200));
    task.emitter.emit('progress', { type, data } as BrowserProgressEvent);
  }

  async destroyTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
    }

    try {
      if (task.browser) {
        await task.browser.close();
        this.activeBrowserCount = Math.max(0, this.activeBrowserCount - 1);
      }
    } catch (err: any) {
      console.error(`[BrowserService] Error closing browser for task ${taskId}:`, err.message);
    }

    this.tasks.delete(taskId);
  }
}

export const browserService = new BrowserService();

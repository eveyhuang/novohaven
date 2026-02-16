import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { browserService, BrowserProgressEvent } from '../services/browserService';
import { getStrategy, getAllStrategies } from '../services/extractionStrategies';
import { logUsage } from '../services/usageTrackingService';

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// POST /api/browser/tasks — Create + start browser task
router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const { platform, urls, maxReviews } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!platform || typeof platform !== 'string') {
      res.status(400).json({ error: 'platform is required' });
      return;
    }

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      res.status(400).json({ error: 'urls array is required and must not be empty' });
      return;
    }

    const strategy = getStrategy(platform);
    if (!strategy) {
      const available = getAllStrategies().map(s => s.platform);
      res.status(400).json({ error: `Unsupported platform: ${platform}. Available: ${available.join(', ')}` });
      return;
    }

    const taskId = browserService.createTask();

    // Log usage
    logUsage(userId, 'browser', 'create_task', 1, 0, { taskId, platform });

    res.json({ taskId, platform });

    // Run extraction asynchronously (after response is sent)
    runExtraction(taskId, platform, urls, userId, maxReviews).catch(err => {
      console.error(`[Browser] Extraction error for task ${taskId}:`, err.message);
    });
  } catch (error: any) {
    console.error('[Browser] Create task error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/browser/tasks/:id/stream — SSE event stream
router.get('/tasks/:id/stream', (req: Request, res: Response) => {
  const { id: taskId } = req.params;
  const userId = req.user?.id;

  console.log(`[Browser SSE] Client attempting to connect to task ${taskId}, userId: ${userId}`);

  if (!userId) {
    console.log(`[Browser SSE] Rejected: No userId`);
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const task = browserService.getTask(taskId);
  if (!task) {
    console.log(`[Browser SSE] Task ${taskId} not found`);
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  console.log(`[Browser SSE] Task ${taskId} found, status: ${task.status}`);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let isClientConnected = true;

  const sendEvent = (type: string, data: any) => {
    if (!isClientConnected) return;
    console.log(`[Browser SSE] Sending event to client: type=${type}`);
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial connection event and current task status
  console.log(`[Browser SSE] Sending initial connection event`);
  sendEvent('status', { status: task.status, taskId });

  // If task is already completed/failed, send that info immediately
  if (task.status === 'completed') {
    console.log(`[Browser SSE] Task already completed, sending completion event`);
    sendEvent('message', { 
      role: 'system', 
      content: [{ type: 'text', text: 'Task completed (reconnected to finished task)' }] 
    });
  } else if (task.status === 'failed') {
    console.log(`[Browser SSE] Task already failed, sending failure event`);
    sendEvent('message', { 
      role: 'system', 
      content: [{ type: 'text', text: 'Task failed (reconnected to failed task)' }] 
    });
  } else {
    sendEvent('message', { 
      role: 'system', 
      content: [{ type: 'text', text: `Connected to browser task. Status: ${task.status}` }] 
    });
  }

  // Listen for progress events from the task
  const onProgress = (event: BrowserProgressEvent) => {
    console.log(`[Browser SSE] Received progress event: type=${event.type}`);
    sendEvent(event.type, event.data);

    // Close stream on terminal events
    if (event.type === 'complete' || event.type === 'error') {
      setTimeout(() => {
        if (isClientConnected) {
          console.log(`[Browser SSE] Closing stream for task ${taskId} (terminal event)`);
          res.end();
        }
      }, 500);
    }
  };

  console.log(`[Browser SSE] Attaching progress listener to task ${taskId}`);
  task.emitter.on('progress', onProgress);
  console.log(`[Browser SSE] Current listener count: ${task.emitter.listenerCount('progress')}`);

  // Handle client disconnect
  req.on('close', () => {
    isClientConnected = false;
    task.emitter.removeListener('progress', onProgress);
    console.log(`[Browser SSE] Client disconnected from task ${taskId}`);
  });
});

// POST /api/browser/tasks/:id/resume — Signal CAPTCHA solved
router.post('/tasks/:id/resume', (req: Request, res: Response) => {
  const { id: taskId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const resolved = browserService.signalCaptchaResolved(taskId);
  if (!resolved) {
    res.status(404).json({ error: 'Task not found or not waiting for CAPTCHA' });
    return;
  }

  res.json({ success: true, message: 'CAPTCHA resolution signaled' });
});

// GET /api/browser/tasks/:id/screenshot — Current page screenshot
router.get('/tasks/:id/screenshot', async (req: Request, res: Response) => {
  const { id: taskId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const screenshot = await browserService.takeScreenshot(taskId);
  if (!screenshot) {
    res.status(404).json({ error: 'No screenshot available' });
    return;
  }

  res.json({ screenshot });
});

// Async extraction runner
async function runExtraction(
  taskId: string,
  platform: string,
  urls: string[],
  userId: number,
  maxReviews?: number,
): Promise<void> {
  const task = browserService.getTask(taskId);
  if (!task) return;

  try {
    const page = await browserService.launchBrowser(taskId);
    const strategy = getStrategy(platform);
    if (!strategy) throw new Error(`Strategy not found for platform: ${platform}`);

    const onProgress = (message: string) => {
      browserService.emit(task, 'message', {
        role: 'system',
        content: [{ type: 'text', text: message }],
      });
    };

    const result = await strategy.execute(page, urls, onProgress);

    // Check for CAPTCHA after execution
    const hasCaptcha = await browserService.detectCaptcha(taskId);
    if (hasCaptcha) {
      onProgress('Waiting for CAPTCHA to be resolved...');
      await browserService.waitForCaptchaResolution(taskId);
      // Re-run extraction after CAPTCHA resolution
      const retryResult = await strategy.execute(page, urls, onProgress);
      task.status = 'completed';
      browserService.emit(task, 'complete', {
        output: JSON.stringify(retryResult.data, null, 2),
        reviewCount: retryResult.reviewCount,
      });
    } else {
      task.status = 'completed';
      browserService.emit(task, 'complete', {
        output: JSON.stringify(result.data, null, 2),
        reviewCount: result.reviewCount,
      });
    }

    // Log usage
    logUsage(userId, 'browser', 'extract', 1, result.reviewCount || 0, { taskId, platform });
  } catch (error: any) {
    console.error(`[Browser] Task ${taskId} failed:`, error.message);
    const t = browserService.getTask(taskId);
    if (t) {
      t.status = 'failed';
      browserService.emit(t, 'error', { error: error.message });
    }
  } finally {
    await browserService.destroyTask(taskId);
  }
}

export default router;

import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  isManusConfigured,
  createTask,
  getTaskMessages,
  sendMessage,
} from '../services/manusService';
import { compilePrompt } from '../services/promptParser';
import { logUsage } from '../services/usageTrackingService';
import { queries, getDatabase } from '../models/database';

const router = Router();

// In-memory map: taskId → { prompt, userId } for saving outputs on completion
const taskPrompts = new Map<string, { prompt: string; userId: number }>();

// Apply auth middleware to all routes
router.use(authMiddleware);

// POST /api/manus/tasks — Start a Manus task (returns immediately)
router.post('/tasks', async (req: Request, res: Response) => {
  try {
    const { prompt, urls } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'A prompt is required' });
      return;
    }

    if (!isManusConfigured()) {
      res.status(503).json({ error: 'Manus AI is not configured. Set MANUS_API_KEY environment variable.' });
      return;
    }

    // Build full prompt with optional URLs
    let fullPrompt = prompt.trim();
    if (urls && Array.isArray(urls) && urls.length > 0) {
      fullPrompt += '\n\nURLs to scrape:\n' + urls.join('\n');
    }

    const taskId = await createTask(fullPrompt);

    // Remember prompt for saving output later
    taskPrompts.set(taskId, { prompt: fullPrompt, userId });

    // Log usage
    logUsage(userId, 'manus', 'chat_task', 1, 0, { taskId });

    // Return immediately — client will connect via SSE to stream messages
    res.json({ taskId });
  } catch (error: any) {
    console.error('[Manus] Create task error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/manus/tasks/from-skill — Start a task from a saved skill
router.post('/tasks/from-skill', async (req: Request, res: Response) => {
  try {
    const { skillId, variables } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!skillId) {
      res.status(400).json({ error: 'skillId is required' });
      return;
    }

    if (!isManusConfigured()) {
      res.status(503).json({ error: 'Manus AI is not configured. Set MANUS_API_KEY environment variable.' });
      return;
    }

    // Load the skill and its first step
    const db = getDatabase();
    const skill = db.prepare('SELECT * FROM skills WHERE id = ?').get(skillId) as any;
    if (!skill) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const steps = db.prepare(
      "SELECT * FROM skill_steps WHERE parent_id = ? AND parent_type = 'skill' ORDER BY step_order"
    ).all(skillId) as any[];
    const step = steps[0];
    if (!step || !step.prompt_template) {
      res.status(400).json({ error: 'Skill has no prompt template' });
      return;
    }

    // Compile the prompt with variables and company standards
    const compiled = compilePrompt(step.prompt_template, {
      userId,
      userInputs: variables || {},
      stepExecutions: [],
    });

    const compiledPrompt = compiled.compiledPrompt;

    // Create the Manus task
    const taskId = await createTask(compiledPrompt);

    // Remember prompt for saving output later
    taskPrompts.set(taskId, { prompt: compiledPrompt, userId });

    // Log usage
    logUsage(userId, 'manus', 'skill_task', 1, 0, { taskId, skillId });

    res.json({ taskId, compiledPrompt });
  } catch (error: any) {
    console.error('[Manus] From-skill error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/manus/tasks/:taskId/stream — SSE message stream
router.get('/tasks/:taskId/stream', async (req: Request, res: Response) => {
  const { taskId } = req.params;
  const userId = req.user?.id;

  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  let lastMessageCount = 0;
  let consecutiveErrors = 0;
  let isClientConnected = true;
  let hasSentTakeControl = false; // avoid sending duplicate take_control events
  const POLL_INTERVAL = 6000; // 6 seconds
  const MAX_DURATION = 15 * 60 * 1000; // 15 minutes
  const MAX_CONSECUTIVE_ERRORS = 5;
  const startTime = Date.now();

  // Handle client disconnect
  req.on('close', () => {
    isClientConnected = false;
    console.log(`[Manus SSE] Client disconnected from task ${taskId}`);
  });

  const sendEvent = (type: string, data: any) => {
    if (!isClientConnected) return;
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial connection event
  sendEvent('status', { status: 'connected', taskId });

  const poll = async () => {
    if (!isClientConnected) return;

    // Check timeout
    if (Date.now() - startTime > MAX_DURATION) {
      sendEvent('error', { error: 'Stream timeout after 15 minutes' });
      res.end();
      return;
    }

    try {
      const result = await getTaskMessages(taskId);
      consecutiveErrors = 0; // Reset on success

      // Send any new messages (include index for client-side deduplication)
      if (result.messages.length > lastMessageCount) {
        const newMessages = result.messages.slice(lastMessageCount);
        for (let i = 0; i < newMessages.length; i++) {
          sendEvent('message', { ...newMessages[i], _idx: lastMessageCount + i });
        }
        lastMessageCount = result.messages.length;
      }

      // Send status updates (include stop_reason and task_url)
      sendEvent('status', {
        status: result.status,
        stopReason: result.stopReason,
        taskUrl: result.taskUrl,
      });

      // When Manus is waiting for user input (detected from message content),
      // send a dedicated take_control event so the frontend can show the UI.
      // Only send once per verification encounter; reset when message count changes
      // (meaning Manus resumed and may hit another verification later).
      if (result.stopReason === 'ask' && result.taskUrl && !hasSentTakeControl) {
        hasSentTakeControl = true;
        sendEvent('take_control', {
          taskUrl: result.taskUrl,
          message: 'Manus is waiting for your input. You can take control of the browser to complete verification.',
        });
      } else if (result.stopReason !== 'ask' && hasSentTakeControl) {
        // Manus resumed — reset so we can detect future verifications
        hasSentTakeControl = false;
      }

      // Check if task is done
      if (result.status === 'completed') {
        // Extract final output text from assistant messages
        const outputText = result.messages
          .filter(m => m.role === 'assistant')
          .flatMap(m => m.content)
          .filter(c => c.type === 'output_text' && c.text)
          .map(c => c.text)
          .join('\n\n');

        sendEvent('complete', {
          output: outputText,
          files: result.files,
          creditsUsed: result.creditsUsed,
        });

        // Save output to manus_outputs table
        const taskInfo = taskPrompts.get(taskId);
        try {
          queries.createManusOutput(
            taskInfo?.userId || userId,
            taskId,
            taskInfo?.prompt || '',
            outputText,
            result.files ? JSON.stringify(result.files) : null,
            result.creditsUsed ?? null,
          );
          console.log(`[Manus] Output saved to manus_outputs for task ${taskId}`);
        } catch (saveErr: any) {
          console.error(`[Manus] Failed to save output for task ${taskId}:`, saveErr.message);
        }
        taskPrompts.delete(taskId);

        // Log final usage
        logUsage(userId, 'manus', 'chat_complete', 0, 0, {
          taskId,
          creditsUsed: result.creditsUsed,
        });

        res.end();
        return;
      }

      if (result.status === 'failed') {
        sendEvent('error', { error: 'Manus task failed' });
        res.end();
        return;
      }

      // Continue polling (including when stopped with stop_reason "ask" — user will reply)
      setTimeout(poll, POLL_INTERVAL);
    } catch (error: any) {
      consecutiveErrors++;
      console.error(`[Manus SSE] Error polling task ${taskId} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error.message);

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        // Only send error to client on fatal give-up
        sendEvent('error', { error: `Gave up after ${MAX_CONSECUTIVE_ERRORS} consecutive errors: ${error.message}` });
        res.end();
        return;
      }

      // Transient errors: log server-side but don't send to client
      // (avoids "task failed" flash while Manus task is still starting)
      setTimeout(poll, POLL_INTERVAL);
    }
  };

  // Start polling
  poll();
});

// GET /api/manus/tasks/:taskId/messages — Get conversation history for chat reconstruction
router.get('/tasks/:taskId/messages', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const result = await getTaskMessages(taskId);
    res.json({
      taskId,
      messages: result.messages,
      status: result.status,
      files: result.files,
      creditsUsed: result.creditsUsed,
    });
  } catch (error: any) {
    console.error('[Manus] Get messages error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/manus/tasks/:taskId/messages — Send reply to a task
router.post('/tasks/:taskId/messages', async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const { message } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'A message is required' });
      return;
    }

    await sendMessage(taskId, message.trim());

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Manus] Send message error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

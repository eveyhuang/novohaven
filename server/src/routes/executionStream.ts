import { Router, Request, Response } from 'express';
import { executionEvents } from '../services/executionEvents';
import { ExecutionChatMessage } from '../types';

const router = Router();

// GET /api/executions/:id/stream - SSE endpoint for execution chat messages
router.get('/:id/stream', (req: Request, res: Response) => {
  const executionId = parseInt(req.params.id, 10);

  if (isNaN(executionId)) {
    res.status(400).json({ error: 'Invalid execution ID' });
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', executionId })}\n\n`);

  // Subscribe to execution events
  const onMessage = (message: ExecutionChatMessage) => {
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  };

  executionEvents.subscribe(executionId, onMessage);

  // Keep-alive ping every 30 seconds
  const keepAlive = setInterval(() => {
    res.write(': ping\n\n');
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepAlive);
    executionEvents.unsubscribe(executionId, onMessage);
  });
});

export default router;

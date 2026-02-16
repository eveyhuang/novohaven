import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { isManusConfigured, createTask, waitForCompletion } from '../services/manusService';
import { logUsage } from '../services/usageTrackingService';

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// GET /api/scraping/status - Check scraping service status
router.get('/status', (req: Request, res: Response) => {
  res.json({
    manus_configured: isManusConfigured(),
  });
});

// POST /api/scraping/test - Test a scraping prompt via Manus AI
router.post('/test', async (req: Request, res: Response) => {
  try {
    const { prompt, urls } = req.body;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'A scraping prompt is required' });
      return;
    }

    if (!isManusConfigured()) {
      res.status(503).json({ error: 'Manus AI is not configured. Set MANUS_API_KEY environment variable.' });
      return;
    }

    // Build full prompt
    let fullPrompt = prompt.trim();
    if (urls && Array.isArray(urls) && urls.length > 0) {
      fullPrompt += '\n\nURLs to scrape:\n' + urls.join('\n');
    }

    const taskId = await createTask(fullPrompt);
    const result = await waitForCompletion(taskId);

    // Log usage
    logUsage(userId, 'manus', 'scrape_test', 1, 0, {
      taskId,
      creditsUsed: result.creditsUsed,
    });

    res.json({
      success: result.status === 'completed',
      taskId: result.taskId,
      output: result.output,
      files: result.files,
      creditsUsed: result.creditsUsed,
    });

  } catch (error: any) {
    console.error('Scraping test error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

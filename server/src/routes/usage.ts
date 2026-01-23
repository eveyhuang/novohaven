import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import {
  getUserUsageStats,
  getUserUsageHistory,
  getAllUsageAdmin,
  generateBillingReport,
} from '../services/usageTrackingService';

const router = Router();

// Apply auth middleware to all routes
router.use(authMiddleware);

// GET /api/usage - Get current user's usage stats
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const stats = getUserUsageStats(userId);
    res.json(stats);

  } catch (error: any) {
    console.error('Get usage error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/usage/history - Get detailed usage history
router.get('/history', (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;
    const service = req.query.service as string | undefined;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const history = getUserUsageHistory(userId, service);
    res.json(history);

  } catch (error: any) {
    console.error('Get usage history error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/usage/billing - Get billing report for current user
router.get('/billing', (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const report = generateBillingReport(userId);
    res.json(report);

  } catch (error: any) {
    console.error('Get billing report error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/usage/admin - Get all users' usage (admin only)
// Note: In production, add admin role check here
router.get('/admin', (req: Request, res: Response) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // TODO: Add admin role check
    // For now, allow all authenticated users (MVP)

    const allUsage = getAllUsageAdmin();
    res.json(allUsage);

  } catch (error: any) {
    console.error('Get admin usage error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

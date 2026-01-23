import { Router, Request, Response } from 'express';
import { queries } from '../models/database';
import { authMiddleware } from '../middleware/auth';
import { User, UserPublic } from '../types';

const router = Router();

// POST /api/auth/login - Mock login
router.post('/login', (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // For MVP, accept any credentials and return the demo user
    // In production, implement proper password verification
    const user = queries.getUserByEmail('demo@novohaven.com') as User | undefined;

    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // Return user without sensitive data
    const userPublic: UserPublic = {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
    };

    // In production, generate and return a JWT token here
    res.json({
      user: userPublic,
      token: 'mock_jwt_token_for_mvp',
      message: 'Login successful (mock authentication)',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/register - Mock registration
router.post('/register', (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    // For MVP, just return success without creating a new user
    // In production, implement proper user creation
    res.json({
      message: 'Registration successful (mock - using demo account)',
      user: {
        id: 1,
        email: 'demo@novohaven.com',
        created_at: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/me - Get current user
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    res.json({ user: req.user });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/logout - Logout
router.post('/logout', (req: Request, res: Response) => {
  try {
    // For MVP, just return success
    // In production, invalidate the JWT token
    res.json({ message: 'Logout successful' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/auth/api-keys - Update API keys
router.put('/api-keys', authMiddleware, (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { openai, anthropic, google } = req.body;

    // Store API keys (in production, these should be encrypted)
    const apiKeys = JSON.stringify({
      openai: openai || null,
      anthropic: anthropic || null,
      google: google || null,
    });

    queries.updateUserApiKeys(apiKeys, userId);

    res.json({ message: 'API keys updated successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

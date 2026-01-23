import { Request, Response, NextFunction } from 'express';
import { queries } from '../models/database';
import { User, UserPublic } from '../types';

// Mock authentication middleware for MVP
// In production, replace with proper JWT/session authentication
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // For MVP, use a hardcoded demo user
  // Check for Authorization header (for future JWT implementation)
  const authHeader = req.headers.authorization;

  // For now, always authenticate as the demo user
  const mockUser = queries.getUserByEmail('demo@novohaven.com') as User | undefined;

  if (!mockUser) {
    res.status(401).json({ error: 'Authentication required. Demo user not found.' });
    return;
  }

  // Attach user to request (without sensitive data)
  const userPublic: UserPublic = {
    id: mockUser.id,
    email: mockUser.email,
    created_at: mockUser.created_at,
  };

  req.user = userPublic;
  next();
}

// Optional auth - attaches user if available but doesn't require it
export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const mockUser = queries.getUserByEmail('demo@novohaven.com') as User | undefined;

  if (mockUser) {
    const userPublic: UserPublic = {
      id: mockUser.id,
      email: mockUser.email,
      created_at: mockUser.created_at,
    };
    req.user = userPublic;
  }

  next();
}

// Require specific user to own a resource
export function requireOwnership(
  getResourceUserId: (req: Request) => number | null
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const resourceUserId = getResourceUserId(req);

    // For MVP, skip ownership check since we only have one user
    // In production, uncomment the following:
    // if (resourceUserId !== null && resourceUserId !== req.user.id) {
    //   res.status(403).json({ error: 'Access denied' });
    //   return;
    // }

    next();
  };
}

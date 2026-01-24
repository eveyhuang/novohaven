"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
exports.optionalAuthMiddleware = optionalAuthMiddleware;
exports.requireOwnership = requireOwnership;
const database_1 = require("../models/database");
// Mock authentication middleware for MVP
// In production, replace with proper JWT/session authentication
function authMiddleware(req, res, next) {
    // For MVP, use a hardcoded demo user
    // Check for Authorization header (for future JWT implementation)
    const authHeader = req.headers.authorization;
    // For now, always authenticate as the demo user
    const mockUser = database_1.queries.getUserByEmail('demo@novohaven.com');
    if (!mockUser) {
        res.status(401).json({ error: 'Authentication required. Demo user not found.' });
        return;
    }
    // Attach user to request (without sensitive data)
    const userPublic = {
        id: mockUser.id,
        email: mockUser.email,
        created_at: mockUser.created_at,
    };
    req.user = userPublic;
    next();
}
// Optional auth - attaches user if available but doesn't require it
function optionalAuthMiddleware(req, res, next) {
    const mockUser = database_1.queries.getUserByEmail('demo@novohaven.com');
    if (mockUser) {
        const userPublic = {
            id: mockUser.id,
            email: mockUser.email,
            created_at: mockUser.created_at,
        };
        req.user = userPublic;
    }
    next();
}
// Require specific user to own a resource
function requireOwnership(getResourceUserId) {
    return (req, res, next) => {
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
//# sourceMappingURL=auth.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../models/database");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// POST /api/auth/login - Mock login
router.post('/login', (req, res) => {
    try {
        const { email, password } = req.body;
        // For MVP, accept any credentials and return the demo user
        // In production, implement proper password verification
        const user = database_1.queries.getUserByEmail('demo@novohaven.com');
        if (!user) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }
        // Return user without sensitive data
        const userPublic = {
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// POST /api/auth/register - Mock registration
router.post('/register', (req, res) => {
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// GET /api/auth/me - Get current user
router.get('/me', auth_1.authMiddleware, (req, res) => {
    try {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated' });
            return;
        }
        res.json({ user: req.user });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// POST /api/auth/logout - Logout
router.post('/logout', (req, res) => {
    try {
        // For MVP, just return success
        // In production, invalidate the JWT token
        res.json({ message: 'Logout successful' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// PUT /api/auth/api-keys - Update API keys
router.put('/api-keys', auth_1.authMiddleware, (req, res) => {
    try {
        const userId = req.user.id;
        const { openai, anthropic, google } = req.body;
        // Store API keys (in production, these should be encrypted)
        const apiKeys = JSON.stringify({
            openai: openai || null,
            anthropic: anthropic || null,
            google: google || null,
        });
        database_1.queries.updateUserApiKeys(apiKeys, userId);
        res.json({ message: 'API keys updated successfully' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map
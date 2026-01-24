"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const usageTrackingService_1 = require("../services/usageTrackingService");
const router = (0, express_1.Router)();
// Apply auth middleware to all routes
router.use(auth_1.authMiddleware);
// GET /api/usage - Get current user's usage stats
router.get('/', (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        const stats = (0, usageTrackingService_1.getUserUsageStats)(userId);
        res.json(stats);
    }
    catch (error) {
        console.error('Get usage error:', error);
        res.status(500).json({ error: error.message });
    }
});
// GET /api/usage/history - Get detailed usage history
router.get('/history', (req, res) => {
    try {
        const userId = req.user?.id;
        const service = req.query.service;
        if (!userId) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        const history = (0, usageTrackingService_1.getUserUsageHistory)(userId, service);
        res.json(history);
    }
    catch (error) {
        console.error('Get usage history error:', error);
        res.status(500).json({ error: error.message });
    }
});
// GET /api/usage/billing - Get billing report for current user
router.get('/billing', (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        const report = (0, usageTrackingService_1.generateBillingReport)(userId);
        res.json(report);
    }
    catch (error) {
        console.error('Get billing report error:', error);
        res.status(500).json({ error: error.message });
    }
});
// GET /api/usage/admin - Get all users' usage (admin only)
// Note: In production, add admin role check here
router.get('/admin', (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        // TODO: Add admin role check
        // For now, allow all authenticated users (MVP)
        const allUsage = (0, usageTrackingService_1.getAllUsageAdmin)();
        res.json(allUsage);
    }
    catch (error) {
        console.error('Get admin usage error:', error);
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=usage.js.map
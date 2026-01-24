"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const database_1 = require("./models/database");
// Import routes
const recipes_1 = __importDefault(require("./routes/recipes"));
const executions_1 = __importDefault(require("./routes/executions"));
const standards_1 = __importDefault(require("./routes/standards"));
const ai_1 = __importDefault(require("./routes/ai"));
const auth_1 = __importDefault(require("./routes/auth"));
const outputs_1 = __importDefault(require("./routes/outputs"));
const scraping_1 = __importDefault(require("./routes/scraping"));
const usage_1 = __importDefault(require("./routes/usage"));
// Load environment variables
dotenv_1.default.config();
// Initialize Express app
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3001;
// Middleware
app.use((0, cors_1.default)({
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true,
}));
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
// Request logging middleware
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
});
// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    });
});
// API routes
app.use('/api/recipes', recipes_1.default);
app.use('/api/executions', executions_1.default);
app.use('/api/standards', standards_1.default);
app.use('/api/ai', ai_1.default);
app.use('/api/auth', auth_1.default);
app.use('/api/outputs', outputs_1.default);
app.use('/api/scraping', scraping_1.default);
app.use('/api/usage', usage_1.default);
// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});
// Error handler
app.use((err, req, res, next) => {
    console.error('Error:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
});
// Initialize database and start server
async function start() {
    try {
        console.log('Initializing database...');
        (0, database_1.initializeDatabase)();
        console.log('Database initialized successfully');
        app.listen(PORT, () => {
            console.log(`Server running on http://localhost:${PORT}`);
            console.log(`Health check: http://localhost:${PORT}/api/health`);
            console.log('\nAvailable endpoints:');
            console.log('  - GET  /api/recipes');
            console.log('  - POST /api/recipes');
            console.log('  - GET  /api/recipes/:id');
            console.log('  - PUT  /api/recipes/:id');
            console.log('  - DELETE /api/recipes/:id');
            console.log('  - POST /api/recipes/:id/clone');
            console.log('  - GET  /api/executions');
            console.log('  - POST /api/executions');
            console.log('  - GET  /api/executions/:id');
            console.log('  - POST /api/executions/:id/steps/:stepId/approve');
            console.log('  - POST /api/executions/:id/steps/:stepId/reject');
            console.log('  - POST /api/executions/:id/steps/:stepId/retry');
            console.log('  - GET  /api/standards');
            console.log('  - POST /api/standards');
            console.log('  - GET  /api/standards/:id');
            console.log('  - PUT  /api/standards/:id');
            console.log('  - DELETE /api/standards/:id');
            console.log('  - GET  /api/ai/models');
            console.log('  - GET  /api/ai/providers');
            console.log('  - POST /api/ai/test');
            console.log('  - POST /api/auth/login');
            console.log('  - GET  /api/auth/me');
            console.log('  - GET  /api/scraping/status');
            console.log('  - POST /api/scraping/reviews');
            console.log('  - POST /api/scraping/csv/parse');
            console.log('  - POST /api/scraping/export');
            console.log('  - GET  /api/usage');
            console.log('  - GET  /api/usage/history');
            console.log('  - GET  /api/usage/billing');
        });
    }
    catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
}
start();
//# sourceMappingURL=index.js.map
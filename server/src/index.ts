import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { initializeDatabase } from './models/database';

// Import routes
import recipesRouter from './routes/recipes';
import executionsRouter from './routes/executions';
import standardsRouter from './routes/standards';
import aiRouter from './routes/ai';
import authRouter from './routes/auth';
import outputsRouter from './routes/outputs';
import scrapingRouter from './routes/scraping';
import usageRouter from './routes/usage';
import executorsRouter from './routes/executors';
import assistantRouter from './routes/assistant';

// Load environment variables from server directory
// This ensures .env is loaded whether running from project root or server directory
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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
app.use('/api/recipes', recipesRouter);
app.use('/api/executions', executionsRouter);
app.use('/api/standards', standardsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/auth', authRouter);
app.use('/api/outputs', outputsRouter);
app.use('/api/scraping', scrapingRouter);
app.use('/api/usage', usageRouter);
app.use('/api/executors', executorsRouter);
app.use('/api/assistant', assistantRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err.message);
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize database and start server
async function start() {
  try {
    console.log('Initializing database...');
    initializeDatabase();
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
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

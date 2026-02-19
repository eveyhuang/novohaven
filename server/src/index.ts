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
import manusRouter from './routes/manus';
import browserRouter from './routes/browser';
import executionStreamRouter from './routes/executionStream';
import pluginsRouter from './routes/plugins';
import sessionsRouter from './routes/sessions';
import agentsRouter from './routes/agents';
import skillsRouter from './routes/skills';
import workflowsRouter from './routes/workflows';
import skillDraftsRouter from './routes/skillDrafts';
import { loadAllPlugins } from './plugins/loader';
import { createChannelRouter } from './gateway/channelRouter';
import { SessionManager } from './gateway/sessionManager';
import { AgentSupervisor } from './gateway/agentSupervisor';
import { pluginRegistry } from './plugins/registry';

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
app.use('/api/manus', manusRouter);
app.use('/api/browser', browserRouter);
app.use('/api/executions', executionStreamRouter);
app.use('/api/plugins', pluginsRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/skills/drafts', skillDraftsRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/workflows', workflowsRouter);

// Initialize database and start server
async function start() {
  try {
    console.log('Initializing database...');
    initializeDatabase();
    console.log('Database initialized successfully');

    console.log('Loading plugins...');
    await loadAllPlugins();
    console.log('Plugins loaded successfully');

    // Initialize gateway components
    console.log('Initializing gateway...');
    const sessionManager = new SessionManager();

    // Response handler: route agent responses back to the correct channel
    const agentSupervisor = new AgentSupervisor({
      sessionManager,
      onResponse: async (sessionId, response) => {
        const session = sessionManager.getSession(sessionId);
        if (!session) {
          console.warn(`[Gateway] No session found for response: ${sessionId}`);
          return;
        }

        // Route response back to the originating channel (AgentRunner persists messages itself)
        for (const [name, channel] of pluginRegistry.getAllChannels()) {
          if (name.includes(session.channel_type) || session.channel_type === name.replace('channel-', '')) {
            try {
              await channel.sendOutbound(session.channel_id, response);
            } catch (err: any) {
              console.error(`[Gateway] Failed to send response via ${name}:`, err.message);
            }
            break;
          }
        }
      },
    });
    agentSupervisor.start();

    // Mount channel routes — wire to agent supervisor
    const channelRouter = createChannelRouter(async (message) => {
      console.log(`[Gateway] Routing message from ${message.channelType}: ${message.content.text?.substring(0, 50)}`);

      // Ensure session exists (AgentRunner persists messages itself)
      sessionManager.resolveSession(
        message.channelType, message.channelId,
        message.userId, message.threadId
      );

      // Route to agent
      await agentSupervisor.routeMessage(message);
    });
    app.use('/channels', channelRouter);
    console.log('Gateway initialized successfully');

    // 404 handler — must be registered AFTER all routes (including async channel routes)
    app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Error handler
    app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
      console.error('Error:', err.message);
      console.error(err.stack);
      res.status(500).json({ error: 'Internal server error' });
    });

    app.listen(PORT, () => {
      console.log(`\nServer running on http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
      console.log('\nGateway endpoints:');
      console.log('  - POST /channels/channel-web/message');
      console.log('  - GET  /channels/channel-web/stream');
      console.log('  - POST /channels/channel-lark/webhook');
      console.log('\nAPI endpoints:');
      console.log('  - /api/skills, /api/workflows, /api/sessions');
      console.log('  - /api/agents, /api/plugins, /api/skills/drafts');
      console.log('  - /api/recipes, /api/executions, /api/standards');
      console.log('  - /api/ai, /api/auth, /api/outputs, /api/usage');
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

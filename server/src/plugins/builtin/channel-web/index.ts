import { Request, Response, Router } from 'express';
import {
  ChannelPlugin, PluginManifest, ChannelMessage, AgentResponse,
} from '../../types';

// Store SSE connections by session ID
const sseConnections = new Map<string, Response[]>();

// Message handler — set by the gateway during wiring
let messageHandler: ((message: ChannelMessage) => Promise<void>) | null = null;

class WebChannelPlugin implements ChannelPlugin {
  manifest: PluginManifest;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(): Promise<void> {
    console.log('[channel-web] Web channel initialized');
  }

  async shutdown(): Promise<void> {
    // Close all SSE connections
    for (const [, connections] of sseConnections) {
      for (const res of connections) {
        try { res.end(); } catch {}
      }
    }
    sseConnections.clear();
  }

  verifyAuth(req: Request): boolean {
    // Delegate to existing JWT auth — check for Authorization header or token query param
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    return !!token;
  }

  parseInbound(req: Request): ChannelMessage | null {
    const { text, sessionId, attachments } = req.body;
    if (!text && (!attachments || attachments.length === 0)) return null;

    return {
      channelType: 'web',
      channelId: sessionId || 'web-default',
      userId: (req as any).userId?.toString() || '1',
      content: {
        text,
        attachments: attachments?.map((a: any) => ({
          type: a.type || 'image',
          url: a.data, // base64 data URL
          name: a.name,
          mimeType: a.mimeType,
        })),
      },
      metadata: { sessionId },
      timestamp: new Date(),
    };
  }

  async sendOutbound(channelId: string, response: AgentResponse): Promise<void> {
    const connections = sseConnections.get(channelId);
    if (!connections || connections.length === 0) {
      console.warn(`[channel-web] No SSE connections for channel ${channelId}`);
      return;
    }

    // Determine event type: chunk, done, or complete message
    const isChunk = (response as any).isChunk === true;
    const isDone = (response as any).isDone === true;
    const messageId = (response as any).messageId;

    const event = JSON.stringify({
      type: isDone ? 'done' : isChunk ? 'chunk' : 'message',
      messageId,
      content: response.text,
      text: response.text,
      attachments: response.attachments?.map(a => ({
        type: a.type,
        name: a.name,
        mimeType: a.mimeType,
        url: typeof a.data === 'string' ? a.data : undefined,
      })),
      timestamp: new Date().toISOString(),
    });

    // Send to all connected clients for this channel
    for (const res of connections) {
      try {
        res.write(`data: ${event}\n\n`);
      } catch {
        // Connection closed, will be cleaned up
      }
    }
  }

  setMessageHandler(handler: (message: ChannelMessage) => Promise<void>): void {
    messageHandler = handler;
  }

  registerRoutes(router: Router): void {
    // Send a message to the agent
    router.post('/message', async (req: Request, res: Response) => {
      const message = this.parseInbound(req);
      if (!message) {
        res.status(400).json({ error: 'Missing text in request body' });
        return;
      }

      try {
        if (messageHandler) {
          await messageHandler(message);
        }
        res.json({ success: true, channelId: message.channelId });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // SSE stream for receiving agent responses
    router.get('/stream', (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string || 'web-default';

      // Set SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      // Send initial connected event
      res.write(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);

      // Register connection
      if (!sseConnections.has(sessionId)) {
        sseConnections.set(sessionId, []);
      }
      sseConnections.get(sessionId)!.push(res);

      // Keep alive
      const keepAlive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch {}
      }, 30000);

      // Cleanup on close
      req.on('close', () => {
        clearInterval(keepAlive);
        const connections = sseConnections.get(sessionId);
        if (connections) {
          const idx = connections.indexOf(res);
          if (idx >= 0) connections.splice(idx, 1);
          if (connections.length === 0) sseConnections.delete(sessionId);
        }
      });
    });

    // Get active sessions for this channel
    router.get('/sessions', (req: Request, res: Response) => {
      const sessions = Array.from(sseConnections.keys()).map(id => ({
        sessionId: id,
        connections: sseConnections.get(id)?.length || 0,
      }));
      res.json(sessions);
    });
  }
}

// Allow the gateway to set the message handler
export function setWebMessageHandler(handler: (message: ChannelMessage) => Promise<void>): void {
  messageHandler = handler;
}

// Allow sending responses to web clients
export function sendToWebSession(sessionId: string, response: AgentResponse): void {
  const connections = sseConnections.get(sessionId);
  if (!connections) return;

  const event = JSON.stringify({
    type: 'message',
    text: response.text,
    timestamp: new Date().toISOString(),
  });

  for (const res of connections) {
    try { res.write(`data: ${event}\n\n`); } catch {}
  }
}

export default WebChannelPlugin;

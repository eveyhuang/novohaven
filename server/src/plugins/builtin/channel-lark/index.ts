/**
 * channel-lark — Lark/Feishu bot channel plugin.
 *
 * Supports:
 * - DM conversations
 * - Group chat @mentions
 * - URL verification challenge
 * - Rich text / markdown outbound messages
 */
import { Request, Response, Router } from 'express';
import {
  ChannelPlugin, PluginManifest, ChannelMessage, AgentResponse,
} from '../../types';

// Message handler — set by the gateway
let messageHandler: ((message: ChannelMessage) => Promise<void>) | null = null;

// Dedup: Lark sometimes sends duplicate events
const processedEvents = new Map<string, number>();
const DEDUP_TTL_MS = 60_000;

class LarkChannelPlugin implements ChannelPlugin {
  manifest: PluginManifest;
  private config: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey?: string;
  } = { appId: '', appSecret: '', verificationToken: '' };
  private tenantAccessToken: string = '';
  private tokenExpiresAt: number = 0;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    this.config = {
      appId: config.appId || process.env.LARK_APP_ID || '',
      appSecret: config.appSecret || process.env.LARK_APP_SECRET || '',
      verificationToken: config.verificationToken || process.env.LARK_VERIFICATION_TOKEN || '',
      encryptKey: config.encryptKey || process.env.LARK_ENCRYPT_KEY,
    };

    if (!this.config.appId || !this.config.appSecret) {
      console.warn('[channel-lark] No Lark credentials configured, plugin will not be functional');
      return;
    }

    // Clean up dedup map periodically
    setInterval(() => {
      const now = Date.now();
      for (const [key, time] of processedEvents) {
        if (now - time > DEDUP_TTL_MS) processedEvents.delete(key);
      }
    }, DEDUP_TTL_MS);

    console.log('[channel-lark] Lark channel initialized');
  }

  async shutdown(): Promise<void> {
    processedEvents.clear();
  }

  verifyAuth(req: Request): boolean {
    // Lark sends verification_token in the event body
    const body = req.body;
    if (body?.token === this.config.verificationToken) return true;
    if (body?.header?.token === this.config.verificationToken) return true;
    return false;
  }

  parseInbound(req: Request): ChannelMessage | null {
    const body = req.body;

    // v2 event format (im.message.receive_v1)
    const event = body.event;
    if (!event?.message?.content) return null;

    let text = '';
    try {
      const content = JSON.parse(event.message.content);
      text = content.text || '';
    } catch {
      text = event.message.content;
    }

    // Strip @mention in group chats
    text = text.replace(/@_user_\d+/g, '').trim();
    if (!text) return null;

    const chatType = event.message.chat_type; // 'p2p' or 'group'
    const chatId = event.message.chat_id;
    const userId = event.sender?.sender_id?.open_id || 'unknown';
    const messageId = event.message.message_id;

    return {
      channelType: 'lark',
      channelId: chatId,
      userId,
      threadId: chatType === 'group' ? event.message.root_id || messageId : undefined,
      content: { text },
      metadata: {
        chatType,
        messageId,
        larkEvent: body.header?.event_id,
      },
      timestamp: new Date(),
    };
  }

  async sendOutbound(channelId: string, response: AgentResponse): Promise<void> {
    if (!this.config.appId) return;

    const token = await this.getTenantToken();
    if (!token) {
      console.error('[channel-lark] No tenant access token available');
      return;
    }

    const text = response.text || '';

    // Chunk long messages (Lark has ~4000 char limit for text)
    const chunks = this.chunkText(text, 3800);

    for (const chunk of chunks) {
      const body = {
        receive_id: channelId,
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      };

      try {
        const res = await fetch('https://open.larksuite.com/open-apis/im/v1/messages?receive_id_type=chat_id', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          console.error('[channel-lark] Failed to send message:', err);
        }
      } catch (err: any) {
        console.error('[channel-lark] Error sending message:', err.message);
      }
    }
  }

  registerRoutes(router: Router): void {
    // Webhook endpoint for Lark events
    router.post('/webhook', async (req: Request, res: Response) => {
      const body = req.body;

      // URL verification challenge
      if (body.type === 'url_verification') {
        res.json({ challenge: body.challenge });
        return;
      }

      // Verify token
      if (!this.verifyAuth(req)) {
        res.status(403).json({ error: 'Invalid verification token' });
        return;
      }

      // Acknowledge immediately (Lark expects quick response)
      res.json({ code: 0 });

      // Dedup check
      const eventId = body.header?.event_id || body.event?.message?.message_id;
      if (eventId && processedEvents.has(eventId)) {
        return;
      }
      if (eventId) processedEvents.set(eventId, Date.now());

      // Parse and forward message
      const message = this.parseInbound(req);
      if (message && messageHandler) {
        try {
          await messageHandler(message);
        } catch (err: any) {
          console.error('[channel-lark] Error handling message:', err.message);
        }
      }
    });
  }

  /**
   * Get Lark tenant access token (cached).
   */
  private async getTenantToken(): Promise<string | null> {
    if (this.tenantAccessToken && Date.now() < this.tokenExpiresAt) {
      return this.tenantAccessToken;
    }

    try {
      const res = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      });

      const data = await res.json() as any;
      if (data.code === 0) {
        this.tenantAccessToken = data.tenant_access_token;
        this.tokenExpiresAt = Date.now() + (data.expire - 300) * 1000; // Refresh 5 min early
        return this.tenantAccessToken;
      }

      console.error('[channel-lark] Failed to get tenant token:', data);
      return null;
    } catch (err: any) {
      console.error('[channel-lark] Error getting tenant token:', err.message);
      return null;
    }
  }

  /**
   * Chunk text into smaller pieces.
   */
  private chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      chunks.push(text.substring(i, i + maxLen));
    }
    return chunks;
  }
}

export function setLarkMessageHandler(handler: (message: ChannelMessage) => Promise<void>): void {
  messageHandler = handler;
}

export default LarkChannelPlugin;

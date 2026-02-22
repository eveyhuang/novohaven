/**
 * channel-lark — Lark/Feishu channel plugin.
 *
 * OpenClaw-style capabilities adapted to the NovoHaven channel interface:
 * - SDK-based client (@larksuiteoapi/node-sdk)
 * - Dual mode receive path (WebSocket long connection or webhook)
 * - Message/media parsing for text, post, image, file, audio, video, sticker
 * - Outbound text + media uploads
 */
import fs from 'fs';
import path from 'path';
import { Request, Response, Router } from 'express';
import * as Lark from '@larksuiteoapi/node-sdk';
import {
  ChannelPlugin, PluginManifest, ChannelMessage, AgentResponse,
} from '../../types';
import { getUploadsDir } from '../../../utils/uploadHelpers';

type LarkConnectionMode = 'webhook' | 'websocket';
type LarkDomain = 'feishu' | 'lark' | string;
type LarkReceiveIdType = 'chat_id' | 'open_id' | 'user_id';
type LarkMediaAttachmentType = 'image' | 'file' | 'audio' | 'video';

type LarkMention = {
  key?: string;
  name?: string;
  id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
};

type LarkMessageEvent = {
  sender?: {
    sender_type?: string;
    sender_id?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
  };
  message?: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'group';
    message_type: string;
    content: string;
    mentions?: LarkMention[];
  };
};

type ParsedPostContent = {
  text: string;
  imageKeys: string[];
  mentionedOpenIds: string[];
};

type DownloadedMedia = {
  buffer: Buffer;
  fileName?: string;
  contentType?: string;
};

type LoadedOutboundMedia = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
};

type RuntimeOutboundResponse = AgentResponse & {
  isChunk?: boolean;
  isDone?: boolean;
  messageId?: string;
};

type PendingStreamOutput = {
  text: string;
  attachments: NonNullable<AgentResponse['attachments']>;
  updatedAt: number;
};

// Message handler — set by the gateway
let messageHandler: ((message: ChannelMessage) => Promise<void>) | null = null;

const DEDUP_TTL_MS = 30 * 60 * 1000;
const DEDUP_MAX_SIZE = 1000;
const DEDUP_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.ico', '.tiff', '.tif']);
const FILE_TYPE_MAP: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
  '.opus': 'opus',
  '.ogg': 'opus',
  '.mp4': 'mp4',
  '.mov': 'mp4',
  '.avi': 'mp4',
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'doc',
  '.xls': 'xls',
  '.xlsx': 'xls',
  '.ppt': 'ppt',
  '.pptx': 'ppt',
};

class LarkChannelPlugin implements ChannelPlugin {
  manifest: PluginManifest;
  private config: {
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey?: string;
    domain?: LarkDomain;
    connectionMode: LarkConnectionMode;
    requireMention: boolean;
    textChunkLimit: number;
    mediaMaxMb: number;
  } = {
      appId: '',
      appSecret: '',
      verificationToken: '',
      connectionMode: 'websocket',
      requireMention: true,
      textChunkLimit: 3800,
      mediaMaxMb: 30,
    };

  private client: any = null;
  private wsClient: any = null;
  private wsStarted = false;
  private eventDispatcher: any = null;
  private botOpenId = '';
  private processedMessageIds = new Map<string, number>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private pendingStreamOutputs = new Map<string, PendingStreamOutput>();

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    this.config = {
      appId: config.appId || process.env.LARK_APP_ID || '',
      appSecret: config.appSecret || process.env.LARK_APP_SECRET || '',
      verificationToken: config.verificationToken || process.env.LARK_VERIFICATION_TOKEN || '',
      encryptKey: config.encryptKey || process.env.LARK_ENCRYPT_KEY || undefined,
      domain: config.domain || process.env.LARK_DOMAIN || 'feishu',
      connectionMode: this.resolveConnectionMode(config.connectionMode || process.env.LARK_CONNECTION_MODE),
      requireMention: config.requireMention ?? this.parseBoolean(process.env.LARK_REQUIRE_MENTION, true),
      textChunkLimit: Number(config.textChunkLimit || process.env.LARK_TEXT_CHUNK_LIMIT || 3800),
      mediaMaxMb: Number(config.mediaMaxMb || process.env.LARK_MEDIA_MAX_MB || 30),
    };

    if (!this.config.appId || !this.config.appSecret) {
      console.warn('[channel-lark] Missing appId/appSecret; plugin is inactive');
      return;
    }

    this.client = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: this.resolveDomain(this.config.domain),
    });

    this.eventDispatcher = new Lark.EventDispatcher({
      encryptKey: this.config.encryptKey,
      verificationToken: this.config.verificationToken,
    });
    this.registerSdkEventHandlers();

    this.cleanupTimer = setInterval(() => this.cleanupDedup(), DEDUP_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();

    await this.fetchBotOpenId();

    if (this.config.connectionMode === 'websocket' && messageHandler) {
      await this.startWebSocket();
    } else if (this.config.connectionMode === 'websocket') {
      console.log('[channel-lark] WebSocket mode configured; waiting for message handler');
    }

    console.log(`[channel-lark] Initialized (mode=${this.config.connectionMode}, mentionRequired=${this.config.requireMention})`);
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.processedMessageIds.clear();
    this.pendingStreamOutputs.clear();
    await this.stopWebSocket();
  }

  verifyAuth(req: Request): boolean {
    // In WebSocket mode we still allow webhook route for challenge/fallback; token check is optional.
    if (!this.config.verificationToken) return true;
    const body = req.body || {};
    return body.token === this.config.verificationToken || body.header?.token === this.config.verificationToken;
  }

  parseInbound(req: Request): ChannelMessage | null {
    // parseInbound is kept for interface compatibility; webhook path uses async processing.
    const event = req.body?.event as LarkMessageEvent | undefined;
    if (!event?.message?.chat_id) return null;
    const parsedText = this.parseTextFromEvent(event);
    if (!parsedText) return null;
    return {
      channelType: 'lark',
      channelId: event.message.chat_id,
      userId: event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || 'unknown',
      threadId: event.message.chat_type === 'group'
        ? (event.message.root_id || event.message.message_id)
        : undefined,
      content: { text: parsedText },
      metadata: {
        chatType: event.message.chat_type,
        messageId: event.message.message_id,
        msgType: event.message.message_type,
        larkEvent: req.body?.header?.event_id,
      },
      timestamp: new Date(),
    };
  }

  async sendOutbound(channelId: string, response: AgentResponse): Promise<void> {
    if (!this.client) return;
    const runtimeResponse = response as RuntimeOutboundResponse;
    const streamKey = `${channelId}:${runtimeResponse.messageId || '__stream__'}`;
    const text = runtimeResponse.text || '';
    const attachments = (runtimeResponse.attachments || []) as NonNullable<AgentResponse['attachments']>;

    if (runtimeResponse.isChunk) {
      const pending = this.pendingStreamOutputs.get(streamKey) || {
        text: '',
        attachments: [],
        updatedAt: Date.now(),
      };
      pending.text += text;
      pending.updatedAt = Date.now();
      this.pendingStreamOutputs.set(streamKey, pending);
      return;
    }

    if (runtimeResponse.isDone) {
      const pending = this.pendingStreamOutputs.get(streamKey);
      this.pendingStreamOutputs.delete(streamKey);
      const finalText = `${pending?.text || ''}${text || ''}`;
      const finalAttachments = [
        ...(pending?.attachments || []),
        ...attachments,
      ] as NonNullable<AgentResponse['attachments']>;
      await this.sendTextAndAttachments(channelId, finalText, finalAttachments);
      return;
    }

    // Non-stream path. If we somehow have pending text for this key, flush it together.
    const pending = this.pendingStreamOutputs.get(streamKey);
    if (pending) {
      this.pendingStreamOutputs.delete(streamKey);
      const mergedText = `${pending.text}${text}`;
      const mergedAttachments = [
        ...pending.attachments,
        ...attachments,
      ] as NonNullable<AgentResponse['attachments']>;
      await this.sendTextAndAttachments(channelId, mergedText, mergedAttachments);
      return;
    }

    await this.sendTextAndAttachments(channelId, text, attachments);
  }

  setMessageHandler(handler: (message: ChannelMessage) => Promise<void>): void {
    messageHandler = handler;
    if (this.config.connectionMode === 'websocket' && this.client && !this.wsStarted) {
      void this.startWebSocket();
    }
  }

  registerRoutes(router: Router): void {
    router.post('/webhook', async (req: Request, res: Response) => {
      const body = req.body || {};

      if (body.type === 'url_verification') {
        res.json({ challenge: body.challenge });
        return;
      }

      if (!this.verifyAuth(req)) {
        res.status(403).json({ error: 'Invalid verification token' });
        return;
      }

      // Acknowledge quickly, process asynchronously.
      res.json({ code: 0 });
      void this.handleWebhookEvent(body);
    });
  }

  private resolveConnectionMode(value?: string): LarkConnectionMode {
    return String(value || '').toLowerCase() === 'webhook' ? 'webhook' : 'websocket';
  }

  private parseBoolean(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const v = String(value).trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes') return true;
    if (v === '0' || v === 'false' || v === 'no') return false;
    return fallback;
  }

  private resolveDomain(domain?: LarkDomain): any {
    if (!domain || domain === 'feishu') return Lark.Domain.Feishu;
    if (domain === 'lark') return Lark.Domain.Lark;
    return String(domain).replace(/\/+$/, '');
  }

  private registerSdkEventHandlers(): void {
    if (!this.eventDispatcher) return;
    this.eventDispatcher.register({
      'im.message.receive_v1': async (event: unknown) => {
        await this.handleMessageEvent(event as LarkMessageEvent, undefined);
      },
      'im.chat.member.bot.added_v1': async (event: any) => {
        const chatId = event?.chat_id || 'unknown';
        console.log(`[channel-lark] Bot added to chat ${chatId}`);
      },
      'im.chat.member.bot.deleted_v1': async (event: any) => {
        const chatId = event?.chat_id || 'unknown';
        console.log(`[channel-lark] Bot removed from chat ${chatId}`);
      },
    });
  }

  private async fetchBotOpenId(): Promise<void> {
    if (!this.client) return;
    try {
      const response: any = await this.client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        data: {},
      });
      const bot = response?.bot || response?.data?.bot;
      this.botOpenId = bot?.open_id || '';
      if (this.botOpenId) {
        console.log(`[channel-lark] Bot open_id resolved: ${this.botOpenId}`);
      }
    } catch (err: any) {
      console.warn('[channel-lark] Failed to resolve bot open_id:', err?.message || String(err));
    }
  }

  private async startWebSocket(): Promise<void> {
    if (!this.client || this.wsStarted) return;
    if (!this.eventDispatcher) return;

    try {
      this.wsClient = new Lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain: this.resolveDomain(this.config.domain),
        loggerLevel: Lark.LoggerLevel.info,
      });
      this.wsClient.start({ eventDispatcher: this.eventDispatcher });
      this.wsStarted = true;
      console.log('[channel-lark] WebSocket long connection started');
    } catch (err: any) {
      this.wsStarted = false;
      console.error('[channel-lark] Failed to start WebSocket connection:', err?.message || String(err));
    }
  }

  private async stopWebSocket(): Promise<void> {
    if (!this.wsClient || !this.wsStarted) return;
    try {
      await this.wsClient.stop();
    } catch (err: any) {
      console.warn('[channel-lark] Failed to stop WebSocket client:', err?.message || String(err));
    } finally {
      this.wsStarted = false;
      this.wsClient = null;
    }
  }

  private async handleWebhookEvent(body: any): Promise<void> {
    try {
      const eventType = body?.header?.event_type;
      if (eventType && eventType !== 'im.message.receive_v1') return;
      if (!body?.event?.message) return;
      await this.handleMessageEvent(body.event as LarkMessageEvent, body?.header?.event_id);
    } catch (err: any) {
      console.error('[channel-lark] Webhook event handling failed:', err?.message || String(err));
    }
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [messageId, ts] of this.processedMessageIds) {
      if (now - ts > DEDUP_TTL_MS) this.processedMessageIds.delete(messageId);
    }
    for (const [streamKey, pending] of this.pendingStreamOutputs) {
      if (now - pending.updatedAt > DEDUP_TTL_MS) {
        this.pendingStreamOutputs.delete(streamKey);
      }
    }
  }

  private async sendTextAndAttachments(
    channelId: string,
    text: string,
    attachments: NonNullable<AgentResponse['attachments']>,
  ): Promise<void> {
    if (text.trim()) {
      const chunks = this.chunkText(text, Math.max(256, this.config.textChunkLimit || 3800));
      for (const chunk of chunks) {
        await this.sendTextMessage(channelId, chunk);
      }
    }

    for (const attachment of attachments) {
      try {
        const loaded = await this.loadOutboundMedia(attachment);
        if (!loaded) continue;
        await this.sendMediaMessage(channelId, loaded);
      } catch (err: any) {
        console.error('[channel-lark] Failed to send attachment:', err?.message || String(err));
      }
    }
  }

  private tryRecordMessage(messageId: string): boolean {
    if (!messageId) return false;
    this.cleanupDedup();
    if (this.processedMessageIds.has(messageId)) return false;

    if (this.processedMessageIds.size >= DEDUP_MAX_SIZE) {
      const oldest = this.processedMessageIds.keys().next().value;
      if (oldest) this.processedMessageIds.delete(oldest);
    }
    this.processedMessageIds.set(messageId, Date.now());
    return true;
  }

  private parseTextFromEvent(event: LarkMessageEvent): string {
    const msgType = event.message?.message_type || '';
    if (!event.message?.content) return '';
    try {
      const parsed = JSON.parse(event.message.content);
      if (msgType === 'text') {
        return this.stripMentions(parsed?.text || '', event.message.mentions).trim();
      }
      if (msgType === 'post') {
        const post = this.parsePostContent(parsed);
        return this.stripMentions(post.text, event.message.mentions).trim();
      }
      return this.stripMentions(event.message.content, event.message.mentions).trim();
    } catch {
      return this.stripMentions(event.message.content, event.message.mentions).trim();
    }
  }

  private async handleMessageEvent(event: LarkMessageEvent, eventId?: string): Promise<void> {
    const msg = event?.message;
    if (!msg || !msg.message_id || !messageHandler) return;
    if (!this.tryRecordMessage(msg.message_id)) return;

    if (event?.sender?.sender_type === 'bot') return;

    if (msg.chat_type === 'group' && this.config.requireMention && !this.isBotMentioned(event)) {
      return;
    }

    const payload = await this.buildChannelMessageFromEvent(event, eventId);
    if (!payload) return;

    try {
      await messageHandler(payload);
    } catch (err: any) {
      console.error('[channel-lark] Failed to route message to gateway:', err?.message || String(err));
    }
  }

  private async buildChannelMessageFromEvent(
    event: LarkMessageEvent,
    eventId?: string,
  ): Promise<ChannelMessage | null> {
    const msg = event.message;
    if (!msg) return null;

    const contentJson = this.safeParseJson(msg.content);
    const msgType = msg.message_type;
    let text = '';
    const attachments: Array<{
      type: 'image' | 'file' | 'audio' | 'video';
      url: string;
      name?: string;
      mimeType?: string;
    }> = [];

    if (msgType === 'text') {
      text = this.stripMentions(contentJson?.text || '', msg.mentions);
    } else if (msgType === 'post') {
      const parsedPost = this.parsePostContent(contentJson);
      text = this.stripMentions(parsedPost.text, msg.mentions);
      for (const imageKey of parsedPost.imageKeys) {
        const media = await this.downloadAndStoreMedia({
          messageId: msg.message_id,
          chatId: msg.chat_id,
          fileKey: imageKey,
          resourceType: 'image',
          fallbackName: this.buildFallbackMediaName(imageKey, 'image', msg.message_id),
        });
        if (media) {
          attachments.push({ type: 'image', url: media.url, name: media.name, mimeType: media.mimeType });
        }
      }
    } else if (['image', 'file', 'audio', 'video', 'sticker'].includes(msgType)) {
      const mediaMeta = this.parseMediaMeta(msgType, contentJson);
      if (mediaMeta.fileKey) {
        const media = await this.downloadAndStoreMedia({
          messageId: msg.message_id,
          chatId: msg.chat_id,
          fileKey: mediaMeta.fileKey,
          resourceType: msgType === 'image' ? 'image' : 'file',
          fallbackName: mediaMeta.fileName || this.buildFallbackMediaName(mediaMeta.fileKey, msgType, msg.message_id),
        });
        if (media) {
          attachments.push({
            type: mediaMeta.attachmentType,
            url: media.url,
            name: media.name,
            mimeType: media.mimeType,
          });
        }
      }
      text = `<media:${mediaMeta.attachmentType}>`;
    } else {
      text = `[${msgType}]`;
    }

    text = (text || '').trim();
    if (!text && attachments.length === 0) return null;

    const userId = event.sender?.sender_id?.open_id || event.sender?.sender_id?.user_id || 'unknown';
    return {
      channelType: 'lark',
      channelId: msg.chat_id,
      userId,
      threadId: msg.chat_type === 'group' ? (msg.root_id || msg.message_id) : undefined,
      content: {
        text,
        attachments: attachments.length ? attachments : undefined,
      },
      metadata: {
        chatType: msg.chat_type,
        messageId: msg.message_id,
        parentId: msg.parent_id,
        rootId: msg.root_id,
        msgType: msg.message_type,
        larkEvent: eventId,
      },
      timestamp: new Date(),
    };
  }

  private isBotMentioned(event: LarkMessageEvent): boolean {
    const mentions = event.message?.mentions || [];
    if (this.botOpenId && mentions.some((m) => m?.id?.open_id === this.botOpenId)) return true;
    if (event.message?.message_type === 'post') {
      const parsed = this.parsePostContent(this.safeParseJson(event.message.content));
      return this.botOpenId ? parsed.mentionedOpenIds.includes(this.botOpenId) : mentions.length > 0;
    }
    return mentions.length > 0;
  }

  private parsePostContent(contentJson: any): ParsedPostContent {
    const result: ParsedPostContent = {
      text: '',
      imageKeys: [],
      mentionedOpenIds: [],
    };

    const pickLanguagePayload = (value: any): any => {
      if (!value || typeof value !== 'object') return {};
      if (Array.isArray(value.content)) return value;
      return value.zh_cn || value.en_us || value.ja_jp || value;
    };

    const payload = pickLanguagePayload(contentJson);
    const title = String(payload?.title || '').trim();
    const blocks = Array.isArray(payload?.content) ? payload.content : [];

    const parts: string[] = [];
    if (title) parts.push(title);

    for (const paragraph of blocks) {
      if (!Array.isArray(paragraph)) continue;
      const p: string[] = [];
      for (const el of paragraph) {
        if (!el || typeof el !== 'object') continue;
        const tag = String(el.tag || '');
        if (tag === 'text') {
          p.push(String(el.text || ''));
        } else if (tag === 'a') {
          p.push(String(el.text || el.href || ''));
        } else if (tag === 'at') {
          const name = String(el.user_name || el.user_id || 'user');
          p.push(`@${name}`);
          if (el.user_id) result.mentionedOpenIds.push(String(el.user_id));
        } else if (tag === 'img' && el.image_key) {
          result.imageKeys.push(String(el.image_key));
        }
      }
      const line = p.join('').trim();
      if (line) parts.push(line);
    }

    result.text = parts.join('\n').trim();
    return result;
  }

  private parseMediaMeta(
    msgType: string,
    contentJson: any,
  ): { fileKey?: string; fileName?: string; attachmentType: LarkMediaAttachmentType } {
    const imageKey = contentJson?.image_key ? String(contentJson.image_key) : undefined;
    const fileKey = contentJson?.file_key ? String(contentJson.file_key) : undefined;
    const fileName = contentJson?.file_name ? String(contentJson.file_name) : undefined;

    if (msgType === 'image') return { fileKey: imageKey, fileName, attachmentType: 'image' };
    if (msgType === 'audio') return { fileKey, fileName, attachmentType: 'audio' };
    if (msgType === 'video') return { fileKey, fileName, attachmentType: 'video' };
    return { fileKey: fileKey || imageKey, fileName, attachmentType: 'file' };
  }

  private safeParseJson(raw: string): any {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }

  private stripMentions(text: string, mentions?: LarkMention[]): string {
    let result = String(text || '');
    // text content can include explicit <at ...> blocks
    result = result.replace(/<at\b[^>]*>.*?<\/at>/gi, ' ');
    result = result.replace(/@_user_\d+/g, ' ');

    for (const mention of mentions || []) {
      const key = mention?.key || '';
      const name = mention?.name || '';
      if (key) result = result.replace(new RegExp(this.escapeRegExp(key), 'g'), ' ');
      if (name) result = result.replace(new RegExp(`@${this.escapeRegExp(name)}\\s*`, 'g'), ' ');
    }
    return result.replace(/\s+/g, ' ').trim();
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private async downloadAndStoreMedia(params: {
    messageId: string;
    chatId: string;
    fileKey: string;
    resourceType: 'image' | 'file';
    fallbackName: string;
  }): Promise<{ url: string; name: string; mimeType: string } | null> {
    const { messageId, chatId, fileKey, resourceType, fallbackName } = params;
    try {
      const media = await this.downloadMessageResource(messageId, fileKey, resourceType);
      if (!media) return null;

      const maxBytes = Math.max(1, this.config.mediaMaxMb || 30) * 1024 * 1024;
      if (media.buffer.length > maxBytes) {
        console.warn(`[channel-lark] Skip oversized media ${fileKey} (${media.buffer.length} bytes)`);
        return null;
      }

      const name = this.safeFileName(media.fileName || fallbackName || 'file.bin');
      const mimeType = media.contentType || this.guessMimeType(name) || 'application/octet-stream';
      const rel = this.saveBufferToUploads(chatId, messageId, media.buffer, name);
      return { url: rel.url, name: rel.name, mimeType };
    } catch (err: any) {
      console.warn(`[channel-lark] Failed downloading media ${fileKey}:`, err?.message || String(err));
      return null;
    }
  }

  private async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
  ): Promise<DownloadedMedia | null> {
    if (!this.client) return null;
    const response: any = await this.client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type },
    });
    const buffer = await this.readSdkBinaryResponse(response, 'lark message resource download failed');

    const contentTypeHeader = this.readHeader(response, 'content-type');
    const contentDisposition = this.readHeader(response, 'content-disposition');
    const fileNameFromDisposition = this.parseFilenameFromDisposition(contentDisposition);
    const fileName = response?.file_name || response?.fileName || fileNameFromDisposition || undefined;
    const contentType = contentTypeHeader || undefined;
    return { buffer, fileName, contentType };
  }

  private readHeader(response: any, key: string): string | null {
    const normalized = key.toLowerCase();
    const direct = response?.headers?.[normalized] || response?.headers?.[key];
    if (typeof direct === 'string') return direct;
    if (Array.isArray(direct) && direct[0]) return String(direct[0]);
    return null;
  }

  private parseFilenameFromDisposition(disposition: string | null): string | null {
    if (!disposition) return null;
    const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8?.[1]) {
      try { return decodeURIComponent(utf8[1]); } catch { return utf8[1]; }
    }
    const basic = disposition.match(/filename="?([^";]+)"?/i);
    return basic?.[1] || null;
  }

  private async readSdkBinaryResponse(response: any, errorPrefix: string): Promise<Buffer> {
    if (!response) throw new Error(`${errorPrefix}: empty response`);

    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`${errorPrefix}: ${response.msg || `code ${response.code}`}`);
    }

    if (Buffer.isBuffer(response)) return response;
    if (response instanceof ArrayBuffer) return Buffer.from(response);
    if (Buffer.isBuffer(response.data)) return response.data;
    if (response.data instanceof ArrayBuffer) return Buffer.from(response.data);

    if (typeof response.getReadableStream === 'function') {
      const stream = response.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }

    if (typeof response.writeFile === 'function') {
      const tmpPath = path.join(
        process.env.TMPDIR || '/tmp',
        `novohaven-lark-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`,
      );
      await response.writeFile(tmpPath);
      const data = await fs.promises.readFile(tmpPath);
      await fs.promises.unlink(tmpPath).catch(() => {});
      return data;
    }

    if (typeof response[Symbol.asyncIterator] === 'function') {
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }

    if (typeof response.read === 'function') {
      const chunks: Buffer[] = [];
      for await (const chunk of response) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }

    throw new Error(`${errorPrefix}: unsupported SDK response shape`);
  }

  private saveBufferToUploads(
    chatId: string,
    messageId: string,
    data: Buffer,
    fileName: string,
  ): { url: string; name: string } {
    const uploadsRoot = getUploadsDir();
    const chatSeg = this.safePathSegment(chatId || 'unknown-chat');
    const dir = path.join(uploadsRoot, 'lark', chatSeg);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const safeName = this.safeFileName(fileName) || 'file.bin';
    const uniqueName = this.makeUniqueMediaFileName(safeName, messageId);
    const fullPath = path.join(dir, uniqueName);
    fs.writeFileSync(fullPath, data);

    return {
      url: `/uploads/lark/${chatSeg}/${uniqueName}`,
      name: uniqueName,
    };
  }

  private safePathSegment(value: string): string {
    const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
    return normalized || 'unknown';
  }

  private safeFileName(value: string): string {
    const base = path.basename(value || 'file.bin');
    return base.replace(/[^\w.\-() ]+/g, '_').slice(0, 160) || 'file.bin';
  }

  private buildFallbackMediaName(fileKey: string, msgType: string, messageId: string): string {
    const keyPart = this.safePathSegment(String(fileKey || 'media')).slice(0, 64);
    const msgPart = this.safePathSegment(String(messageId || 'msg')).slice(-16);
    const ext = msgType === 'audio'
      ? '.opus'
      : msgType === 'video'
        ? '.mp4'
        : msgType === 'image' || msgType === 'sticker'
          ? '.png'
          : '.bin';
    return `${keyPart}-${msgPart}${ext}`;
  }

  private makeUniqueMediaFileName(fileName: string, messageId: string): string {
    const parsed = path.parse(fileName);
    const base = this.safePathSegment(parsed.name || 'media').slice(0, 96);
    const ext = parsed.ext || '.bin';
    const msgPart = this.safePathSegment(messageId || 'msg').slice(-16);
    return `${base}-${msgPart}-${Date.now()}${ext}`;
  }

  private guessMimeType(fileName: string): string | null {
    const ext = path.extname(fileName).toLowerCase();
    const map: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.ico': 'image/x-icon',
      '.tiff': 'image/tiff',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.opus': 'audio/opus',
      '.ogg': 'audio/ogg',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
    };
    return map[ext] || null;
  }

  private chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const lines = text.split('\n');
    const chunks: string[] = [];
    let current = '';

    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length <= maxLen) {
        current = next;
        continue;
      }
      if (current) chunks.push(current);
      if (line.length <= maxLen) {
        current = line;
      } else {
        for (let i = 0; i < line.length; i += maxLen) {
          chunks.push(line.slice(i, i + maxLen));
        }
        current = '';
      }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [''];
  }

  private resolveReceiveIdType(receiveId: string): LarkReceiveIdType {
    if (receiveId.startsWith('oc_')) return 'chat_id';
    if (receiveId.startsWith('ou_') || receiveId.startsWith('on_')) return 'open_id';
    if (receiveId.startsWith('u_')) return 'user_id';
    return 'chat_id';
  }

  private buildPostContent(text: string): string {
    return JSON.stringify({
      zh_cn: {
        content: [
          [
            {
              tag: 'md',
              text,
            },
          ],
        ],
      },
    });
  }

  private async sendTextMessage(receiveId: string, text: string): Promise<void> {
    if (!this.client) return;
    const receiveIdType = this.resolveReceiveIdType(receiveId);
    const payload = {
      receive_id: receiveId,
      msg_type: 'post',
      content: this.buildPostContent(text),
    };

    try {
      const response: any = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: payload,
      });
      if (response?.code !== undefined && response.code !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
    } catch (err: any) {
      // Fallback to text if post rendering fails.
      const fallbackPayload = {
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      };
      try {
        await this.client.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: fallbackPayload,
        });
      } catch (fallbackErr: any) {
        console.error('[channel-lark] Failed to send text message:', fallbackErr?.message || String(fallbackErr));
      }
    }
  }

  private async sendMediaMessage(receiveId: string, media: LoadedOutboundMedia): Promise<void> {
    if (!this.client) return;
    const receiveIdType = this.resolveReceiveIdType(receiveId);
    const ext = path.extname(media.fileName).toLowerCase();
    const isImage = media.mimeType.startsWith('image/') || IMAGE_EXTS.has(ext);

    if (isImage) {
      const uploadRes: any = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: media.buffer,
        },
      });
      if (uploadRes?.code !== undefined && uploadRes.code !== 0) {
        throw new Error(uploadRes.msg || `image upload code ${uploadRes.code}`);
      }
      const imageKey = uploadRes?.image_key || uploadRes?.data?.image_key;
      if (!imageKey) throw new Error('image upload returned no image_key');

      await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });
      return;
    }

    const fileType = FILE_TYPE_MAP[ext] || 'stream';
    const uploadRes: any = await this.client.im.file.create({
      data: {
        file_type: fileType,
        file_name: media.fileName,
        file: media.buffer,
      },
    });
    if (uploadRes?.code !== undefined && uploadRes.code !== 0) {
      throw new Error(uploadRes.msg || `file upload code ${uploadRes.code}`);
    }
    const fileKey = uploadRes?.file_key || uploadRes?.data?.file_key;
    if (!fileKey) throw new Error('file upload returned no file_key');

    const msgType = fileType === 'opus' || fileType === 'mp4' ? 'media' : 'file';
    await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        msg_type: msgType,
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
  }

  private async loadOutboundMedia(
    attachment: NonNullable<AgentResponse['attachments']>[number],
  ): Promise<LoadedOutboundMedia | null> {
    if (!attachment?.data) return null;

    const providedName = attachment.name || 'attachment.bin';
    const providedMime = attachment.mimeType || this.guessMimeType(providedName) || 'application/octet-stream';

    if (Buffer.isBuffer(attachment.data)) {
      return {
        buffer: attachment.data,
        fileName: this.safeFileName(providedName),
        mimeType: providedMime,
      };
    }

    if (typeof attachment.data !== 'string') return null;
    const source = attachment.data;

    if (source.startsWith('/uploads/')) {
      const rel = source.replace(/^\/uploads\//, '');
      const fullPath = path.join(getUploadsDir(), rel);
      const buffer = await fs.promises.readFile(fullPath);
      return {
        buffer,
        fileName: this.safeFileName(attachment.name || path.basename(fullPath)),
        mimeType: attachment.mimeType || this.guessMimeType(path.basename(fullPath)) || providedMime,
      };
    }

    if (source.startsWith('http://') || source.startsWith('https://')) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`HTTP ${res.status} loading attachment`);
      const ab = await res.arrayBuffer();
      const guessed = attachment.mimeType || res.headers.get('content-type') || providedMime;
      const nameFromUrl = attachment.name || path.basename(new URL(source).pathname) || providedName;
      return {
        buffer: Buffer.from(ab),
        fileName: this.safeFileName(nameFromUrl),
        mimeType: guessed,
      };
    }

    if (fs.existsSync(source)) {
      const buffer = await fs.promises.readFile(source);
      return {
        buffer,
        fileName: this.safeFileName(attachment.name || path.basename(source)),
        mimeType: attachment.mimeType || this.guessMimeType(path.basename(source)) || providedMime,
      };
    }

    return null;
  }
}

export function setLarkMessageHandler(handler: (message: ChannelMessage) => Promise<void>): void {
  messageHandler = handler;
}

export default LarkChannelPlugin;

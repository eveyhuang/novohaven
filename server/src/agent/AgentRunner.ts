/**
 * AgentRunner — the core agentic loop.
 *
 * Runs inside a child process (one per session). Implements the 5-step loop:
 * 1. Load session state (from DB)
 * 2. Assemble context (system prompt + history + tools)
 * 3. Stream LLM response (via provider plugin)
 * 4. Execute tool calls (via tool plugins)
 * 5. Persist state (messages to DB)
 *
 * Uses PromptBuilder for context assembly and ToolExecutor for tool dispatch.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ChannelMessage, CompletionRequest, MessageAttachment, ProviderPlugin, ToolPlugin } from '../plugins/types';
import { getUploadsDir } from '../utils/uploadHelpers';
import { Session, AgentConfig } from '../types';
import { PromptBuilder } from './PromptBuilder';
import { ToolExecutor } from './ToolExecutor';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/novohaven.db');
const AUTO_NEW_TASK_IDLE_SECONDS = 72 * 60 * 60;
const INLINE_FILE_MAX_ATTACHMENTS = Math.max(1, Number(process.env.AGENT_INLINE_FILE_MAX_ATTACHMENTS || 3));
const INLINE_FILE_MAX_BYTES = Math.max(16 * 1024, Number(process.env.AGENT_INLINE_FILE_MAX_BYTES || 256 * 1024));
const INLINE_FILE_MAX_CHARS = Math.max(2000, Number(process.env.AGENT_INLINE_FILE_MAX_CHARS || 12000));
const INLINE_OFFICE_EXTRACT_TIMEOUT_MS = Math.max(500, Number(process.env.AGENT_INLINE_OFFICE_EXTRACT_TIMEOUT_MS || 5000));
const ASSET_NAME_LOCALIZATION: Array<{ aliases: string[]; en: string; zh: string }> = [
  {
    aliases: ['Image Style Analyzer', '图像风格分析器'],
    en: 'Image Style Analyzer',
    zh: '图像风格分析器',
  },
  {
    aliases: ['Modify Images', '修改图片'],
    en: 'Modify Images',
    zh: '修改图片',
  },
  {
    aliases: ['生成产品图片', 'Product Image Generator'],
    en: 'Product Image Generator',
    zh: '生成产品图片',
  },
  {
    aliases: ['电商评论动机分析', 'E-commerce Review Motivation Analysis'],
    en: 'E-commerce Review Motivation Analysis',
    zh: '电商评论动机分析',
  },
];

interface PendingApproval {
  resolve: (result: { approved: boolean; data?: any }) => void;
}

interface TaskWorkflowSelection {
  id: number;
  name: string;
}

export class AgentRunner {
  private sessionId: string;
  private db: Database.Database;
  private provider: ProviderPlugin | null = null;
  private tools: Map<string, ToolPlugin> = new Map();
  private promptBuilder: PromptBuilder;
  private toolExecutor: ToolExecutor | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  private maxToolRounds = Math.max(1, parseInt(process.env.AGENT_MAX_TOOL_ROUNDS || '20', 10));
  private ready: Promise<void>;

  constructor(sessionId: string) {
    this.sessionId = sessionId;

    // Open our own DB connection (WAL mode allows concurrent access)
    this.db = new Database(DB_PATH, { readonly: false });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.promptBuilder = new PromptBuilder(this.db);
    this.ready = this.initializeAll();
  }

  private async initializeAll(): Promise<void> {
    await Promise.all([
      this.initializeProvider(),
      this.initializeToolPlugins(),
    ]);
  }

  /**
   * Initialize the provider plugin in the child process.
   * Loads provider based on the session's agent config.
   */
  private async initializeProvider(): Promise<void> {
    // Get agent config for this session
    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(this.sessionId) as Session | undefined;
    const configId = session?.agent_config_id || 1;

    const agentConfig = this.db.prepare('SELECT * FROM agent_configs WHERE id = ?').get(configId) as AgentConfig | undefined;
    if (!agentConfig) {
      console.warn(`[AgentRunner] No agent config found (id=${configId}), using defaults`);
      return;
    }

    // Determine provider from model name
    const model = agentConfig.default_model;
    const providerName = this.resolveProviderName(model);

    // Load provider plugin directly (child process can't access parent's registry)
    try {
      const pluginDir = path.join(__dirname, '../plugins/builtin', providerName);
      const manifest = require(path.join(pluginDir, 'manifest.json'));
      const entryPath = this.resolvePluginEntryPath(pluginDir, manifest.entry || './index.ts');
      if (!entryPath) {
        throw new Error(`Provider entry not found for ${providerName}`);
      }
      const PluginModule = require(entryPath);
      const PluginClass = PluginModule.default || PluginModule;
      const provider = new PluginClass(manifest);

      // Get config from DB
      const dbConfig = this.db.prepare(
        'SELECT config FROM plugin_configs WHERE plugin_name = ?'
      ).get(providerName) as any;
      const config = this.parsePluginConfig(dbConfig?.config);

      await provider.initialize(config);
      this.provider = provider;
      console.log(`[AgentRunner] Provider ${providerName} initialized for session ${this.sessionId}`);
    } catch (err: any) {
      console.error(`[AgentRunner] Failed to load provider ${providerName}:`, err.message);
    }
  }

  /**
   * Initialize tool plugins in the child process.
   */
  private async initializeToolPlugins(): Promise<void> {
    const toolPluginNames = [
      'tool-skill-manager',
      'tool-browser',
      'tool-fileops',
      'tool-bash',
    ];

    for (const pluginName of toolPluginNames) {
      try {
        const dbConfig = this.db.prepare(
          'SELECT enabled, config FROM plugin_configs WHERE plugin_name = ?'
        ).get(pluginName) as any;
        if (dbConfig && !dbConfig.enabled) {
          console.log(`[AgentRunner] Tool plugin ${pluginName} disabled in config, skipping.`);
          continue;
        }

        const pluginDir = path.join(__dirname, '../plugins/builtin', pluginName);
        const manifest = require(path.join(pluginDir, 'manifest.json'));
        const entryPath = this.resolvePluginEntryPath(pluginDir, manifest.entry || './index.ts');
        if (!entryPath) {
          throw new Error(`Tool entry not found for ${pluginName}`);
        }
        const PluginModule = require(entryPath);
        const PluginClass = PluginModule.default || PluginModule;
        const plugin = new PluginClass(manifest);
        const config = this.parsePluginConfig(dbConfig?.config);
        await plugin.initialize(config);
        this.tools.set(pluginName, plugin);
        console.log(`[AgentRunner] Tool plugin ${pluginName} loaded`);
      } catch (err: any) {
        console.error(`[AgentRunner] Failed to load ${pluginName}:`, err.message);
      }
    }

    this.rebuildToolExecutor();
  }

  /**
   * Rebuild the ToolExecutor when tool plugins change.
   */
  private rebuildToolExecutor(): void {
    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(this.sessionId) as any;
    this.toolExecutor = new ToolExecutor(this.tools, {
      sessionId: this.sessionId,
      userId: session?.user_id || 1,
    });
  }

  private parsePluginConfig(raw: unknown): Record<string, any> {
    if (!raw) return {};
    if (typeof raw === 'object') return raw as Record<string, any>;
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private resolvePluginEntryPath(pluginDir: string, manifestEntry: string): string | null {
    const normalized = manifestEntry || './index.ts';
    const direct = path.join(pluginDir, normalized);
    if (fs.existsSync(direct)) return direct;

    const ext = path.extname(normalized);
    if (ext === '.ts') {
      const jsVariant = path.join(pluginDir, normalized.replace(/\.ts$/i, '.js'));
      if (fs.existsSync(jsVariant)) return jsVariant;
    } else if (ext === '.js') {
      const tsVariant = path.join(pluginDir, normalized.replace(/\.js$/i, '.ts'));
      if (fs.existsSync(tsVariant)) return tsVariant;
    } else {
      const jsVariant = `${direct}.js`;
      if (fs.existsSync(jsVariant)) return jsVariant;
      const tsVariant = `${direct}.ts`;
      if (fs.existsSync(tsVariant)) return tsVariant;
    }

    return null;
  }

  private resolveProviderName(model: string): string {
    if (model.startsWith('claude') || model.startsWith('anthropic')) return 'provider-anthropic';
    if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'provider-openai';
    if (model.startsWith('gemini')) return 'provider-google';
    return 'provider-anthropic'; // default
  }

  /**
   * Handle an inbound user message — the main agentic loop.
   */
  async handleTurn(message: ChannelMessage): Promise<void> {
    // Wait for provider and tools to finish initializing
    await this.ready;

    // Step 1: Load session state
    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(this.sessionId) as Session;
    const agentConfig = this.db.prepare(
      'SELECT * FROM agent_configs WHERE id = ?'
    ).get(session.agent_config_id || 1) as AgentConfig;
    const inboundText = String(message.content.text || '').trim();
    const isManualNewTask = this.isNewTaskCommand(inboundText);
    const shouldAutoNewTask = !isManualNewTask && this.shouldAutoStartNewTask();

    // Auto-reset context for stale sessions before persisting the current user turn.
    if (shouldAutoNewTask) {
      this.createTaskBoundary('inactivity_72h');
    }

    // Step 2: Persist user message
    const inboundAttachments = message.content.attachments;
    this.db.prepare(`
      INSERT INTO session_messages (session_id, role, content, metadata)
      VALUES (?, 'user', ?, ?)
    `).run(this.sessionId, message.content.text, JSON.stringify({
      ...message.metadata,
      ...(inboundAttachments?.length ? {
        attachmentCount: inboundAttachments.length,
        attachments: inboundAttachments.map(a => ({
          type: a.type,
          url: a.url,
          name: a.name,
          mimeType: a.mimeType,
        })),
      } : {}),
    }));

    // Update session last_active_at
    this.db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(this.sessionId);

    // Manual /new command: create a hard boundary and stop this turn.
    if (isManualNewTask) {
      this.createTaskBoundary('manual_new');
      const confirmation = this.buildNewTaskConfirmation(inboundText);
      this.sendResponse(confirmation);
      this.persistAssistantMessage(confirmation);
      return;
    }

    if (this.isHelpIntent(inboundText)) {
      const helpMessage = this.buildHelpMessage(inboundText, session?.user_id || 1);
      this.sendResponse(helpMessage);
      this.persistAssistantMessage(helpMessage);
      return;
    }

    // If user explicitly mentions a workflow, pin execution to that workflow for this task segment.
    this.maybePinWorkflowFromUserText(inboundText);

    // Step 3: Assemble context using PromptBuilder
    const toolDefs = this.toolExecutor ? this.toolExecutor.getToolDefinitions() : [];
    const built = this.promptBuilder.build({
      sessionId: this.sessionId,
      agentConfig,
      tools: toolDefs,
      currentUserText: message.content.text || '',
    });
    const { systemPrompt, messages } = built;

    // Attach images to the last user message so the LLM can see them
    if (inboundAttachments?.length && messages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg.role === 'user') {
        const imageAttachments = inboundAttachments.filter((a) => this.isImageLikeAttachment(a));
        const nonImageAttachments = inboundAttachments.filter((a) => !this.isImageLikeAttachment(a));

        lastMsg.attachments = imageAttachments
          .map(a => {
            const url = a.url || '';
            // Case 1: still a data URL (fallback path or old format)
            const dataUrlMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
            if (dataUrlMatch) {
              return {
                type: 'image' as const,
                mimeType: dataUrlMatch[1],
                data: dataUrlMatch[2],
              };
            }
            // Case 2: file stored on disk at /uploads/session-<id>/...
            if (url.startsWith('/uploads/')) {
              try {
                const uploadsRoot = getUploadsDir();
                const relPath = url.replace(/^\/uploads\//, '');
                const filePath = path.join(uploadsRoot, relPath);
                const base64Data = fs.readFileSync(filePath).toString('base64');
                return {
                  type: 'image' as const,
                  mimeType: a.mimeType || 'image/png',
                  data: base64Data,
                };
              } catch (err) {
                console.error('[AgentRunner] Failed to read upload file for LLM vision:', err);
                return { type: 'image' as const, mimeType: a.mimeType || 'image/png', data: '' };
              }
            }
            // Case 3: unknown format — pass as-is
            return {
              type: 'image' as const,
              mimeType: a.mimeType || 'image/png',
              data: url,
            };
          });

        if (nonImageAttachments.length > 0) {
          const attachmentNames = nonImageAttachments.map(a => a.name || 'attachment');
          const attachmentHint = `[Attached files: ${attachmentNames.join(', ')}]`;
          const inlineSections = this.buildInlineFileAttachmentSections(nonImageAttachments);
          const pieces = [lastMsg.content, attachmentHint, ...inlineSections].filter(Boolean);
          lastMsg.content = pieces.join('\n\n');
        }
      }
    }

    // Pass recent image batch to ToolExecutor so multi-turn input collection can map images reliably.
    // This keeps the latest contiguous image-upload block available across follow-up text turns.
    if (this.toolExecutor) {
      const toolAttachments = this.getRecentToolImageBatch();
      this.toolExecutor.setAttachments(toolAttachments);
    }

    // Step 4: Stream LLM response with tool call loop
    if (!this.provider) {
      const errorMsg = 'No LLM provider available. Please configure an API key.';
      this.sendResponse(errorMsg);
      this.persistAssistantMessage(errorMsg);
      return;
    }

    let round = 0;
    let toolRounds = 0;
    let currentMessages = [...messages];
    let pendingImageUrls: string[] = [];
    let pendingGeneratedFiles: Array<{ name: string; url: string; mimeType?: string; type?: string; size?: number }> = [];

    while (true) {
      round++;

      const request: CompletionRequest = {
        model: agentConfig?.default_model || 'gemini-3-flash-preview',
        systemPrompt,
        messages: currentMessages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        maxTokens: 4096,
      };

      let fullText = '';
      let toolCalls: Array<{ id: string; name: string; args: Record<string, any>; providerData?: Record<string, any> }> = [];
      const messageId = `msg-${Date.now()}-${round}`;

      // Stream the response
      for await (const event of this.provider.stream(request)) {
        switch (event.type) {
          case 'text':
            fullText += event.text || '';
            // Stream chunk back to gateway
            process.send!({
              type: 'stream_chunk',
              sessionId: this.sessionId,
              messageId,
              content: event.text,
            });
            break;

          case 'tool_call':
            if (event.toolCall) {
              toolCalls.push(event.toolCall);
            }
            break;

          case 'error':
            console.error(`[AgentRunner] Stream error: ${event.error}`);
            this.sendResponse(`Error: ${event.error}`);
            this.persistAssistantMessage(`Error: ${event.error}`);
            return;

          case 'done':
            break;
        }
      }

      // If no tool calls, we're done — signal stream complete (no need to re-send full text)
      if (toolCalls.length === 0) {
        if (fullText || pendingImageUrls.length > 0 || pendingGeneratedFiles.length > 0) {
          process.send!({
            type: 'stream_done',
            sessionId: this.sessionId,
            messageId,
            ...(pendingImageUrls.length > 0 ? { generatedImageUrls: pendingImageUrls } : {}),
            ...(pendingGeneratedFiles.length > 0 ? { generatedFiles: pendingGeneratedFiles } : {}),
          });
          this.persistAssistantMessage(fullText, pendingImageUrls, pendingGeneratedFiles);
          pendingImageUrls = [];
          pendingGeneratedFiles = [];
        }
        return;
      }

      // Enforce a hard cap on tool rounds, but allow a final non-tool response turn.
      if (toolRounds >= this.maxToolRounds) {
        break;
      }
      toolRounds++;

      // Persist assistant message with tool calls
      this.db.prepare(`
        INSERT INTO session_messages (session_id, role, content, tool_calls)
        VALUES (?, 'assistant', ?, ?)
      `).run(this.sessionId, fullText, JSON.stringify(toolCalls));

      currentMessages.push({
        role: 'assistant' as const,
        content: fullText || 'Calling tools...',
        toolCalls,
      });

      // Execute tool calls via ToolExecutor
      for (const tc of toolCalls) {
        let result: string;
        try {
          const executor = this.toolExecutor || new ToolExecutor(this.tools, { sessionId: this.sessionId, userId: 1 });
          const toolResult = await executor.execute(tc.name, tc.args);
          result = toolResult.output;
          if (toolResult.metadata?.generatedImageUrls?.length) {
            pendingImageUrls.push(...toolResult.metadata.generatedImageUrls);
          }
          if (Array.isArray(toolResult.metadata?.generatedFiles) && toolResult.metadata.generatedFiles.length > 0) {
            for (const f of toolResult.metadata.generatedFiles) {
              if (!f || !f.url) continue;
              pendingGeneratedFiles.push({
                name: f.name || 'download',
                url: f.url,
                mimeType: f.type || 'application/octet-stream',
                type: f.type,
                size: Number.isFinite(Number(f.size)) ? Number(f.size) : undefined,
              });
            }
          }
        } catch (err: any) {
          result = `Tool error: ${err.message}`;
        }

        // Persist tool result
        this.db.prepare(`
          INSERT INTO session_messages (session_id, role, content, tool_results)
          VALUES (?, 'tool', ?, ?)
        `).run(this.sessionId, result, JSON.stringify({ toolCallId: tc.id, name: tc.name }));

        currentMessages.push({
          role: 'tool' as const,
          content: result,
          toolCallId: tc.id,
        });
      }

      // Loop continues — LLM will see tool results and decide next action
    }

    // Max rounds exceeded
    const msg = `Reached maximum tool execution rounds (${this.maxToolRounds}). Please try a simpler request.`;
    this.sendResponse(msg);
    this.persistAssistantMessage(msg);
  }

  private getRecentToolImageBatch(limit = 120): MessageAttachment[] {
    type Row = { id: number; metadata: string | null };
    const rows = this.db.prepare(
      `SELECT id, metadata
       FROM session_messages
       WHERE session_id = ? AND role = 'user'
       ORDER BY id DESC
       LIMIT ?`
    ).all(this.sessionId, limit) as Row[];

    // Collect the most recent contiguous block of user messages that include image attachments.
    // Example: [text(requirements), image, image, text(restart)] -> keep the two images.
    let seenImage = false;
    const batchInReverse: Array<Array<{ url: string; mimeType?: string }>> = [];
    for (const row of rows) {
      const images = this.extractImageAttachmentRefs(row.metadata);
      if (images.length > 0) {
        seenImage = true;
        batchInReverse.push(images);
        continue;
      }
      if (seenImage) break;
    }

    if (!seenImage) return [];

    const orderedRefs: Array<{ url: string; mimeType?: string }> = [];
    for (let i = batchInReverse.length - 1; i >= 0; i--) {
      orderedRefs.push(...batchInReverse[i]);
    }

    const attachments: MessageAttachment[] = [];
    for (const ref of orderedRefs) {
      const parsed = this.toMessageAttachment(ref.url, ref.mimeType);
      if (parsed?.data) attachments.push(parsed);
    }
    return attachments;
  }

  private extractImageAttachmentRefs(metadataRaw: string | null): Array<{ url: string; mimeType?: string }> {
    if (!metadataRaw) return [];
    try {
      const metadata = JSON.parse(metadataRaw);
      const attachments = Array.isArray(metadata?.attachments) ? metadata.attachments : [];
      return attachments
        .filter((a: any) => a && a.type === 'image' && typeof a.url === 'string' && a.url.length > 0)
        .map((a: any) => ({ url: String(a.url), mimeType: a.mimeType ? String(a.mimeType) : undefined }));
    } catch {
      return [];
    }
  }

  private toMessageAttachment(url: string, mimeType?: string): MessageAttachment | null {
    if (!url) return null;

    const dataUrlMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (dataUrlMatch) {
      return {
        type: 'image',
        mimeType: dataUrlMatch[1],
        data: dataUrlMatch[2],
      };
    }

    if (url.startsWith('/uploads/')) {
      try {
        const uploadsRoot = getUploadsDir();
        const relPath = url.replace(/^\/uploads\//, '');
        const filePath = path.join(uploadsRoot, relPath);
        const base64Data = fs.readFileSync(filePath).toString('base64');
        return {
          type: 'image',
          mimeType: mimeType || 'image/png',
          data: base64Data,
        };
      } catch (err) {
        console.error('[AgentRunner] Failed to read upload for tool context:', err);
        return null;
      }
    }

    // Fallback for unknown storage format.
    return {
      type: 'image',
      mimeType: mimeType || 'image/png',
      data: url,
    };
  }

  private buildInlineFileAttachmentSections(
    attachments: Array<{ type: string; url: string; name?: string; mimeType?: string }>
  ): string[] {
    const sections: string[] = [];
    let inlinedCount = 0;

    for (const attachment of attachments) {
      if (inlinedCount >= INLINE_FILE_MAX_ATTACHMENTS) break;
      if (!attachment || !attachment.url) continue;
      if (this.isImageLikeAttachment(attachment)) continue;

      const preview = this.readAttachmentPreview(attachment);
      if (!preview) continue;

      const fileLabel = attachment.name || path.basename(attachment.url) || `file_${inlinedCount + 1}`;
      const mimeLabel = attachment.mimeType || 'application/octet-stream';
      sections.push(
        [
          `[Attached file content: ${fileLabel} (${mimeLabel})]`,
          '```text',
          preview.text,
          '```',
          preview.truncated ? '[Content truncated for context window.]' : '',
        ].filter(Boolean).join('\n')
      );
      inlinedCount += 1;
    }

    return sections;
  }

  private readAttachmentPreview(
    attachment: { url: string; name?: string; mimeType?: string }
  ): { text: string; truncated: boolean } | null {
    const fromDataUrl = this.readTextFromDataUrl(attachment.url, attachment.mimeType, attachment.name);
    if (fromDataUrl) return fromDataUrl;

    const filePath = this.resolveUploadsPath(attachment.url);
    if (!filePath) return null;

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return null;
      const ext = path.extname(String(attachment.name || filePath)).toLowerCase();

      if (this.isOfficeDocumentExt(ext)) {
        const extracted = this.extractOfficeDocumentText(filePath, ext);
        if (extracted && extracted.trim()) {
          const truncatedByBytes = stat.size > INLINE_FILE_MAX_BYTES;
          return this.limitPreviewText(extracted.replace(/\u0000/g, ''), truncatedByBytes);
        }
      }

      const bytesToRead = Math.min(stat.size, INLINE_FILE_MAX_BYTES);
      const raw = fs.readFileSync(filePath);
      const sliced = raw.subarray(0, bytesToRead);
      if (!this.isTextLikeAttachment(attachment.mimeType, attachment.name || filePath)) {
        return null;
      }
      const text = sliced.toString('utf8').replace(/\u0000/g, '');
      const truncatedByBytes = stat.size > bytesToRead;
      return this.limitPreviewText(text, truncatedByBytes);
    } catch {
      return null;
    }
  }

  private readTextFromDataUrl(
    source: string,
    mimeType?: string,
    name?: string
  ): { text: string; truncated: boolean } | null {
    const raw = String(source || '');
    if (!raw.startsWith('data:')) return null;
    const match = raw.match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
    if (!match) return null;
    const detectedMime = (match[1] || mimeType || '').toLowerCase();
    if (!this.isTextLikeAttachment(detectedMime, name || 'attachment')) return null;

    const payload = match[2] || '';
    const isBase64 = /;base64,/.test(raw.slice(0, raw.indexOf(',') + 1));
    try {
      const decoded = isBase64
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload);
      return this.limitPreviewText(decoded.replace(/\u0000/g, ''), false);
    } catch {
      return null;
    }
  }

  private limitPreviewText(text: string, alreadyTruncated: boolean): { text: string; truncated: boolean } {
    const normalized = String(text || '').trim();
    if (!normalized) {
      return { text: '[File is empty]', truncated: alreadyTruncated };
    }
    if (normalized.length <= INLINE_FILE_MAX_CHARS) {
      return { text: normalized, truncated: alreadyTruncated };
    }
    return {
      text: normalized.slice(0, INLINE_FILE_MAX_CHARS),
      truncated: true,
    };
  }

  private isTextLikeAttachment(mimeType: string | undefined, name: string): boolean {
    const mime = String(mimeType || '').toLowerCase();
    const ext = path.extname(String(name || '')).toLowerCase();
    if (mime.startsWith('text/')) return true;
    if (mime.includes('json') || mime.includes('csv') || mime.includes('xml') || mime.includes('yaml')) return true;
    return new Set([
      '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.sql', '.py', '.js', '.ts', '.tsx', '.jsx',
    ]).has(ext);
  }

  private isImageLikeAttachment(attachment: { type?: string; url?: string; name?: string; mimeType?: string }): boolean {
    const mime = String(attachment?.mimeType || '').toLowerCase();
    if (mime.startsWith('image/')) return true;

    const url = String(attachment?.url || '');
    const dataUrlMatch = url.match(/^data:([^;,]+)[;,]/i);
    if (dataUrlMatch?.[1] && String(dataUrlMatch[1]).toLowerCase().startsWith('image/')) return true;

    const ext = path.extname(String(attachment?.name || url)).toLowerCase();
    if (new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif', '.svg']).has(ext)) {
      return true;
    }

    return String(attachment?.type || '').toLowerCase() === 'image' && ext === '';
  }

  private isOfficeDocumentExt(ext: string): boolean {
    return new Set(['.docx', '.pptx', '.xlsx']).has(String(ext || '').toLowerCase());
  }

  private extractOfficeDocumentText(filePath: string, ext: string): string | null {
    const script = String.raw`import re, sys, zipfile, xml.etree.ElementTree as ET
path = sys.argv[1]
ext = (sys.argv[2] if len(sys.argv) > 2 else "").lower()
MAX_CHARS = 80000

def qname(tag):
    return tag.split("}")[-1] if "}" in tag else tag

def collect_docx(zf):
    names = ["word/document.xml"] + sorted([n for n in zf.namelist() if n.startswith("word/header") or n.startswith("word/footer")])
    parts = []
    for name in names:
        if name not in zf.namelist():
            continue
        root = ET.fromstring(zf.read(name))
        chunk = []
        for elem in root.iter():
            t = qname(elem.tag)
            if t == "t" and elem.text:
                chunk.append(elem.text)
            elif t in ("p", "br"):
                chunk.append("\n")
            elif t == "tab":
                chunk.append("\t")
        text = "".join(chunk)
        if text.strip():
            parts.append(text)
    return "\n\n".join(parts)

def collect_pptx(zf):
    slide_names = sorted([n for n in zf.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")])
    slides = []
    for name in slide_names:
        root = ET.fromstring(zf.read(name))
        chunk = []
        for elem in root.iter():
            if qname(elem.tag) == "t" and elem.text:
                chunk.append(elem.text)
        text = "\n".join([c for c in chunk if c.strip()])
        if text.strip():
            slides.append(text)
    return "\n\n".join(slides)

def collect_xlsx(zf):
    shared = []
    if "xl/sharedStrings.xml" in zf.namelist():
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
        for si in root.iter():
            if qname(si.tag) == "t" and si.text is not None:
                shared.append(si.text)

    out_lines = []
    sheet_names = sorted([n for n in zf.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")])
    for sheet in sheet_names:
        root = ET.fromstring(zf.read(sheet))
        row_count = 0
        for row in root.iter():
            if qname(row.tag) != "row":
                continue
            row_count += 1
            if row_count > 200:
                break
            vals = []
            for c in row:
                if qname(c.tag) != "c":
                    continue
                t = c.attrib.get("t")
                v = None
                for child in c:
                    if qname(child.tag) == "v":
                        v = child.text
                        break
                if v is None:
                    vals.append("")
                    continue
                if t == "s":
                    try:
                        idx = int(v)
                        vals.append(shared[idx] if 0 <= idx < len(shared) else v)
                    except Exception:
                        vals.append(v)
                else:
                    vals.append(v)
            if any(x.strip() for x in vals):
                out_lines.append("\t".join(vals))
    return "\n".join(out_lines)

try:
    with zipfile.ZipFile(path) as zf:
        if ext == ".docx":
            text = collect_docx(zf)
        elif ext == ".pptx":
            text = collect_pptx(zf)
        elif ext == ".xlsx":
            text = collect_xlsx(zf)
        else:
            text = ""
except Exception:
    text = ""

text = re.sub(r"\n{3,}", "\n\n", text).strip()
if len(text) > MAX_CHARS:
    text = text[:MAX_CHARS]
sys.stdout.write(text)`;

    try {
      const output = execFileSync(
        'python3',
        ['-c', script, filePath, ext],
        {
          encoding: 'utf8',
          timeout: INLINE_OFFICE_EXTRACT_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        }
      );
      return String(output || '').trim();
    } catch {
      return null;
    }
  }

  private resolveUploadsPath(url: string): string | null {
    const raw = String(url || '').trim();
    if (!raw.startsWith('/uploads/')) return null;
    const rel = raw.replace(/^\/uploads\//, '');
    const uploadsRoot = path.resolve(getUploadsDir());
    const fullPath = path.resolve(path.join(uploadsRoot, rel));
    if (!(fullPath === uploadsRoot || fullPath.startsWith(`${uploadsRoot}${path.sep}`))) return null;
    return fullPath;
  }

  private isHelpIntent(text: string): boolean {
    const raw = String(text || '').trim();
    if (!raw) return false;

    if (/^[\/\\]help(?:\s+.*)?$/i.test(raw)) return true;

    const lowered = raw.toLowerCase();
    const normalized = lowered.replace(/[?.!]/g, '').trim();

    const exactMatches = new Set([
      'help',
      'what can you do',
      'what do you do',
      'show help',
      'show commands',
      'commands',
      'capabilities',
      '你会做什么',
      '你能做什么',
      '你可以做什么',
      '帮助',
      '功能',
      '功能列表',
    ]);
    if (exactMatches.has(normalized)) return true;

    const shortText = raw.length <= 80;
    if (shortText) {
      if (/what can you do/i.test(raw)) return true;
      if (/what do you do/i.test(raw)) return true;
      if (/你[能会可]做什么/.test(raw)) return true;
      if (/有什么功能/.test(raw)) return true;
      if (/帮助|命令/.test(raw)) return true;
    }

    return false;
  }

  private buildHelpMessage(userText: string, userId: number): string {
    const lang = this.getSessionPreferredLanguage(userText);
    const modelName = this.getCurrentDefaultModelName();
    const workflows = this.getAvailableAssets('workflow', userId, 6);
    const skills = this.getAvailableAssets('skill', userId, 6);

    if (lang === 'zh') {
      const workflowLines = workflows.items.length > 0
        ? workflows.items.map((w) => `- ${this.localizeAssetName(w.name, 'zh')}：${this.oneLineDescription(w.description, '用于自动化多步骤任务执行。')}`).join('\n')
        : '- 暂无可用工作流';
      const skillLines = skills.items.length > 0
        ? skills.items.map((s) => `- ${this.localizeAssetName(s.name, 'zh')}：${this.oneLineDescription(s.description, '用于完成特定单项能力。')}`).join('\n')
        : '- 暂无可用技能';

      return [
        '我可以这样帮你：',
        '- 普通对话问答与任务拆解',
        '- 分析你上传的图片与文本文件（如 CSV/JSON/TXT）',
        '- 调用系统里的技能/工作流执行多步骤任务',
        '',
        `当前底层模型：\`${modelName}\``,
        '',
        `可用工作流（${workflows.total}）：`,
        workflowLines,
        workflows.total > workflows.items.length ? `- 还有 ${workflows.total - workflows.items.length} 个工作流` : '',
        '',
        `可用技能（${skills.total}）：`,
        skillLines,
        skills.total > skills.items.length ? `- 还有 ${skills.total - skills.items.length} 个技能` : '',
        '',
        '命令：',
        '- `/new` 开始一个新任务（清空当前任务上下文）',
        '- `/help` 查看这条帮助',
        '',
        '你可以直接这样说：',
        '- “分析这个CSV里的差评原因”',
      ].filter(Boolean).join('\n');
    }

    const workflowLines = workflows.items.length > 0
      ? workflows.items.map((w) => `- ${this.localizeAssetName(w.name, 'en')}: ${this.oneLineDescription(w.description, 'Automates a multi-step task flow.')}`).join('\n')
      : '- No active workflows';
    const skillLines = skills.items.length > 0
      ? skills.items.map((s) => `- ${this.localizeAssetName(s.name, 'en')}: ${this.oneLineDescription(s.description, 'Handles a focused capability.')}`).join('\n')
      : '- No active skills';

    return [
      'I can help with:',
      '- Regular chat, Q&A, and task planning',
      '- Analyzing uploaded images and text files (CSV/JSON/TXT)',
      '- Running available skills/workflows for multi-step tasks',
      '',
      `Current model: \`${modelName}\``,
      '',
      `Available workflows (${workflows.total}):`,
      workflowLines,
      workflows.total > workflows.items.length ? `- Plus ${workflows.total - workflows.items.length} more workflows` : '',
      '',
      `Available skills (${skills.total}):`,
      skillLines,
      skills.total > skills.items.length ? `- Plus ${skills.total - skills.items.length} more skills` : '',
      '',
      'Commands:',
      '- `/new` start a new task (reset current task context)',
      '- `/help` show this help',
      '',
      'You can start with:',
      '- "Analyze this CSV and summarize negative feedback themes."',
    ].filter(Boolean).join('\n');
  }

  private detectLanguageFromText(text: string): 'zh' | 'en' | null {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (/[\u4e00-\u9fff]/u.test(raw)) return 'zh';
    const latinLetters = raw.match(/[A-Za-z]/g) || [];
    if (latinLetters.length >= 3) return 'en';
    return null;
  }

  private getSessionPreferredLanguage(currentText: string): 'zh' | 'en' {
    const rows = this.db.prepare(
      `SELECT content
       FROM session_messages
       WHERE session_id = ? AND role = 'user'
       ORDER BY id DESC
       LIMIT 80`
    ).all(this.sessionId) as Array<{ content?: string }>;

    for (const row of rows) {
      const content = String(row?.content || '').trim();
      if (!content) continue;
      if (this.isCommandOnlyMessage(content)) continue;
      const detected = this.detectLanguageFromText(content);
      if (detected) return detected;
    }

    return this.detectLanguageFromText(currentText) || 'en';
  }

  private isCommandOnlyMessage(text: string): boolean {
    const raw = String(text || '').trim();
    if (!raw) return false;
    if (/^[\/\\](new|help)(?:\s+.*)?$/i.test(raw)) return true;
    if (/^new\s+task$/i.test(raw)) return true;
    if (/^(新任务|重新开始|开始新任务|帮助|命令|功能列表)$/.test(raw)) return true;
    return false;
  }

  private oneLineDescription(raw: string | undefined, fallback: string): string {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return fallback;
    const sentence = text.split(/[。.!?]/).map((s) => s.trim()).find(Boolean) || text;
    return sentence.length > 90 ? `${sentence.slice(0, 90)}...` : sentence;
  }

  private localizeAssetName(name: string, lang: 'zh' | 'en'): string {
    const normalized = this.normalizeAssetName(name);
    const entry = ASSET_NAME_LOCALIZATION.find((candidate) =>
      candidate.aliases.some((alias) => this.normalizeAssetName(alias) === normalized)
    );
    if (!entry) return name;
    return lang === 'zh' ? entry.zh : entry.en;
  }

  private normalizeAssetName(name: string): string {
    return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  private getCurrentDefaultModelName(): string {
    const row = this.db.prepare(
      `SELECT ac.default_model
       FROM sessions s
       LEFT JOIN agent_configs ac ON ac.id = s.agent_config_id
       WHERE s.id = ?
       LIMIT 1`
    ).get(this.sessionId) as { default_model?: string } | undefined;
    return row?.default_model || 'gemini-3-flash-preview';
  }

  private getAvailableAssets(
    assetType: 'skill' | 'workflow',
    userId: number,
    limit: number
  ): { total: number; items: Array<{ name: string; description?: string }> } {
    const table = assetType === 'workflow' ? 'workflows' : 'skills';

    const totalRow = this.db.prepare(
      `SELECT COUNT(1) AS total
       FROM ${table}
       WHERE status = 'active' AND (created_by = ? OR created_by IS NULL)`
    ).get(userId) as { total?: number } | undefined;

    const items = this.db.prepare(
      `SELECT a.name, a.description
       FROM ${table} a
       WHERE a.status = 'active' AND (a.created_by = ? OR a.created_by IS NULL)
       ORDER BY a.updated_at DESC, a.id DESC
       LIMIT ?`
    ).all(userId, limit) as Array<{ name?: string; description?: string | null }>;

    return {
      total: Number(totalRow?.total || 0),
      items: items.map((item) => ({
        name: String(item.name || `Unnamed ${assetType}`),
        description: item.description ? String(item.description) : undefined,
      })),
    };
  }

  private isNewTaskCommand(text: string): boolean {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) return false;
    if (/^[\/\\]new(?:\s+.*)?$/.test(normalized)) return true;
    if (/^new\s+task$/.test(normalized)) return true;
    if (/^(新任务|重新开始|开始新任务)$/.test(String(text || '').trim())) return true;
    return false;
  }

  private shouldAutoStartNewTask(): boolean {
    const row = this.db.prepare(
      `SELECT CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', created_at) AS INTEGER) AS idle_seconds
       FROM session_messages
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT 1`
    ).get(this.sessionId) as { idle_seconds?: number } | undefined;

    if (!row || row.idle_seconds == null) return false;
    return Number(row.idle_seconds) >= AUTO_NEW_TASK_IDLE_SECONDS;
  }

  private createTaskBoundary(reason: 'manual_new' | 'inactivity_72h'): void {
    this.db.prepare(
      'UPDATE sessions SET active_execution_id = NULL, last_active_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(this.sessionId);
    this.db.prepare(`
      INSERT INTO session_messages (session_id, role, content, metadata)
      VALUES (?, 'system', ?, ?)
    `).run(
      this.sessionId,
      '[task boundary]',
      JSON.stringify({ taskBoundary: true, reason })
    );
  }

  private buildNewTaskConfirmation(text: string): string {
    if (this.getSessionPreferredLanguage(text) === 'zh') {
      return '已开始新任务。接下来请直接发送你的新需求。';
    }
    return 'Started a new task. Send your new request when ready.';
  }

  private maybePinWorkflowFromUserText(text: string): void {
    const selection = this.resolveWorkflowSelectionFromText(text);
    if (!selection) return;
    const current = this.getCurrentTaskWorkflowPin();
    if (current && current.id === selection.id) return;
    this.db.prepare(`
      INSERT INTO session_messages (session_id, role, content, metadata)
      VALUES (?, 'system', ?, ?)
    `).run(
      this.sessionId,
      '[task selection]',
      JSON.stringify({
        taskSelection: {
          type: 'workflow',
          id: selection.id,
          name: selection.name,
        },
      })
    );
  }

  private resolveWorkflowSelectionFromText(text: string): TaskWorkflowSelection | null {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const idMatch = raw.match(/(?:workflow|工作流)\s*#?\s*(\d+)/i);
    if (idMatch) {
      const workflowId = Number(idMatch[1]);
      if (Number.isFinite(workflowId) && workflowId > 0) {
        const byId = this.db.prepare(
          'SELECT id, name FROM workflows WHERE id = ? AND status = ?'
        ).get(workflowId, 'active') as { id: number; name: string } | undefined;
        if (byId) return byId;
      }
    }

    const workflows = this.db.prepare(
      'SELECT id, name FROM workflows WHERE status = ? ORDER BY LENGTH(name) DESC, id ASC LIMIT 200'
    ).all('active') as Array<{ id: number; name: string }>;
    for (const wf of workflows) {
      if (!wf?.name) continue;
      if (raw.includes(wf.name)) {
        return { id: wf.id, name: wf.name };
      }
    }

    return null;
  }

  private getCurrentTaskWorkflowPin(scanLimit: number = 500): TaskWorkflowSelection | null {
    const rows = this.db.prepare(
      `SELECT id, metadata
       FROM session_messages
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT ?`
    ).all(this.sessionId, scanLimit) as Array<{ id: number; metadata: string | null }>;

    for (const row of rows) {
      if (!row.metadata) continue;
      try {
        const metadata = JSON.parse(row.metadata);
        if (metadata?.taskBoundary === true) break;
        const sel = metadata?.taskSelection;
        if (sel?.type === 'workflow' && Number.isFinite(Number(sel.id))) {
          return { id: Number(sel.id), name: String(sel.name || '') };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Send a complete response back to the gateway via IPC.
   */
  private sendResponse(text: string): void {
    process.send!({
      type: 'response_complete',
      sessionId: this.sessionId,
      content: text,
    });
  }

  /**
   * Persist an assistant message to the database.
   */
  private persistAssistantMessage(
    content: string,
    imageUrls: string[] = [],
    generatedFiles: Array<{ name: string; url: string; mimeType?: string; type?: string; size?: number }> = []
  ): void {
    const metadata: Record<string, any> = {};
    if (imageUrls.length > 0) metadata.generatedImageUrls = imageUrls;
    if (generatedFiles.length > 0) metadata.generatedFiles = generatedFiles;

    this.db.prepare(`
      INSERT INTO session_messages (session_id, role, content, metadata)
      VALUES (?, 'assistant', ?, ?)
    `).run(
      this.sessionId,
      content,
      JSON.stringify(metadata)
    );
  }

  /**
   * Handle approval response from the gateway (for human-in-the-loop).
   */
  handleApprovalResponse(requestId: string, approved: boolean, data?: any): void {
    const pending = this.pendingApprovals.get(requestId);
    if (pending) {
      pending.resolve({ approved, data });
      this.pendingApprovals.delete(requestId);
    }
  }

  /**
   * Register a tool plugin (called during initialization).
   */
  registerTool(name: string, plugin: ToolPlugin): void {
    this.tools.set(name, plugin);
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.provider) {
      await this.provider.shutdown();
    }
    this.db.close();
    console.log(`[AgentRunner] Shutdown complete for session ${this.sessionId}`);
  }
}

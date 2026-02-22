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
import fs from 'fs';
import path from 'path';
import { ChannelMessage, CompletionRequest, MessageAttachment, ProviderPlugin, ToolPlugin } from '../plugins/types';
import { getUploadsDir } from '../utils/uploadHelpers';
import { Session, AgentConfig } from '../types';
import { PromptBuilder } from './PromptBuilder';
import { ToolExecutor } from './ToolExecutor';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/novohaven.db');
const AUTO_NEW_TASK_IDLE_SECONDS = 72 * 60 * 60;

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
      const PluginClass = require(path.join(pluginDir, 'index.ts')).default
        || require(path.join(pluginDir, 'index.ts'));
      const provider = new PluginClass(manifest);

      // Get config from DB
      const dbConfig = this.db.prepare(
        'SELECT config FROM plugin_configs WHERE plugin_name = ?'
      ).get(providerName) as any;
      const config = dbConfig ? JSON.parse(dbConfig.config) : {};

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
        const PluginClass = require(path.join(pluginDir, 'index.ts')).default
          || require(path.join(pluginDir, 'index.ts'));
        const plugin = new PluginClass(manifest);
        const config = dbConfig?.config ? JSON.parse(dbConfig.config) : {};
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
        lastMsg.attachments = inboundAttachments
          .filter(a => a.type === 'image')
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

        const nonImageAttachments = inboundAttachments
          .filter(a => a.type !== 'image')
          .map(a => a.name || 'attachment');
        if (nonImageAttachments.length > 0) {
          const attachmentHint = `[Attached files: ${nonImageAttachments.join(', ')}]`;
          lastMsg.content = lastMsg.content
            ? `${lastMsg.content}\n\n${attachmentHint}`
            : attachmentHint;
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
        model: agentConfig?.default_model || 'gpt-5',
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

  private isNewTaskCommand(text: string): boolean {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) return false;
    if (/^\/new(?:\s+.*)?$/.test(normalized)) return true;
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
    const isChinese = /[\u4e00-\u9fff]/u.test(String(text || ''));
    if (isChinese) {
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

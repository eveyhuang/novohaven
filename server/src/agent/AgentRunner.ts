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
import path from 'path';
import { ChannelMessage, CompletionRequest, ProviderPlugin, ToolPlugin } from '../plugins/types';
import { Session, AgentConfig } from '../types';
import { PromptBuilder } from './PromptBuilder';
import { ToolExecutor } from './ToolExecutor';

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '../../data/novohaven.db');

interface PendingApproval {
  resolve: (result: { approved: boolean; data?: any }) => void;
}

export class AgentRunner {
  private sessionId: string;
  private db: Database.Database;
  private provider: ProviderPlugin | null = null;
  private tools: Map<string, ToolPlugin> = new Map();
  private promptBuilder: PromptBuilder;
  private toolExecutor: ToolExecutor | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();
  private maxToolRounds = 10;

  constructor(sessionId: string) {
    this.sessionId = sessionId;

    // Open our own DB connection (WAL mode allows concurrent access)
    this.db = new Database(DB_PATH, { readonly: false });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.promptBuilder = new PromptBuilder(this.db);
    this.initializeProvider();
    this.initializeToolPlugins();
  }

  /**
   * Initialize the provider plugin in the child process.
   * Loads provider based on the session's agent config.
   */
  private initializeProvider(): void {
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

      // Initialize synchronously-ish (we'll await in handleTurn if needed)
      provider.initialize(config).then(() => {
        this.provider = provider;
        console.log(`[AgentRunner] Provider ${providerName} initialized for session ${this.sessionId}`);
      }).catch((err: any) => {
        console.error(`[AgentRunner] Failed to initialize provider ${providerName}:`, err);
      });
    } catch (err: any) {
      console.error(`[AgentRunner] Failed to load provider ${providerName}:`, err.message);
    }
  }

  /**
   * Initialize tool plugins in the child process.
   */
  private initializeToolPlugins(): void {
    // Load tool-skill-manager plugin
    try {
      const pluginDir = path.join(__dirname, '../plugins/builtin/tool-skill-manager');
      const manifest = require(path.join(pluginDir, 'manifest.json'));
      const PluginClass = require(path.join(pluginDir, 'index.ts')).default
        || require(path.join(pluginDir, 'index.ts'));
      const plugin = new PluginClass(manifest);
      plugin.initialize({}).then(() => {
        this.tools.set('tool-skill-manager', plugin);
        this.rebuildToolExecutor();
        console.log(`[AgentRunner] Tool plugin tool-skill-manager loaded`);
      }).catch((err: any) => {
        console.error(`[AgentRunner] Failed to init tool-skill-manager:`, err);
      });
    } catch (err: any) {
      console.error(`[AgentRunner] Failed to load tool-skill-manager:`, err.message);
    }
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
    // Step 1: Load session state
    const session = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(this.sessionId) as Session;
    const agentConfig = this.db.prepare(
      'SELECT * FROM agent_configs WHERE id = ?'
    ).get(session.agent_config_id || 1) as AgentConfig;

    // Step 2: Persist user message
    this.db.prepare(`
      INSERT INTO session_messages (session_id, role, content, metadata)
      VALUES (?, 'user', ?, ?)
    `).run(this.sessionId, message.content.text, JSON.stringify(message.metadata || {}));

    // Update session last_active_at
    this.db.prepare('UPDATE sessions SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(this.sessionId);

    // Step 3: Assemble context using PromptBuilder
    const toolDefs = this.toolExecutor ? this.toolExecutor.getToolDefinitions() : [];
    const built = this.promptBuilder.build({
      sessionId: this.sessionId,
      agentConfig,
      tools: toolDefs,
    });
    const { systemPrompt, messages } = built;

    // Step 4: Stream LLM response with tool call loop
    if (!this.provider) {
      const errorMsg = 'No LLM provider available. Please configure an API key.';
      this.sendResponse(errorMsg);
      this.persistAssistantMessage(errorMsg);
      return;
    }

    let round = 0;
    let currentMessages = [...messages];

    while (round < this.maxToolRounds) {
      round++;

      const request: CompletionRequest = {
        model: agentConfig?.default_model || 'claude-sonnet-4-5-20250929',
        systemPrompt,
        messages: currentMessages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        maxTokens: 4096,
      };

      let fullText = '';
      let toolCalls: Array<{ id: string; name: string; args: Record<string, any> }> = [];

      // Stream the response
      for await (const event of this.provider.stream(request)) {
        switch (event.type) {
          case 'text':
            fullText += event.text || '';
            // Stream chunk back to gateway
            process.send!({
              type: 'stream_chunk',
              sessionId: this.sessionId,
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

      // If no tool calls, we're done — send final response
      if (toolCalls.length === 0) {
        if (fullText) {
          this.sendResponse(fullText);
          this.persistAssistantMessage(fullText);
        }
        return;
      }

      // Persist assistant message with tool calls
      this.db.prepare(`
        INSERT INTO session_messages (session_id, role, content, tool_calls)
        VALUES (?, 'assistant', ?, ?)
      `).run(this.sessionId, fullText, JSON.stringify(toolCalls));

      currentMessages.push({
        role: 'assistant' as const,
        content: fullText || 'Calling tools...',
      });

      // Execute tool calls via ToolExecutor
      for (const tc of toolCalls) {
        let result: string;
        try {
          const executor = this.toolExecutor || new ToolExecutor(this.tools, { sessionId: this.sessionId, userId: 1 });
          const toolResult = await executor.execute(tc.name, tc.args);
          result = toolResult.output;
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
    const msg = 'Reached maximum tool execution rounds. Please try a simpler request.';
    this.sendResponse(msg);
    this.persistAssistantMessage(msg);
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
  private persistAssistantMessage(content: string): void {
    this.db.prepare(`
      INSERT INTO session_messages (session_id, role, content)
      VALUES (?, 'assistant', ?)
    `).run(this.sessionId, content);
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

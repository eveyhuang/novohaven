import { Request, Router } from 'express';

// ---- Shared Types ----

export interface ChannelMessage {
  channelType: string;
  channelId: string;
  userId: string;          // platform-specific user ID
  threadId?: string;
  content: {
    text: string;
    attachments?: Array<{
      type: 'image' | 'file' | 'audio' | 'video';
      url: string;
      name?: string;
      mimeType?: string;
    }>;
  };
  metadata?: Record<string, any>;
  timestamp: Date;
}

export interface AgentResponse {
  text?: string;
  attachments?: Array<{
    type: 'image' | 'file';
    data: Buffer | string;   // Buffer for binary, string for URL
    name?: string;
    mimeType?: string;
  }>;
  metadata?: Record<string, any>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;  // JSON Schema
}

export interface ToolContext {
  sessionId: string;
  userId: number;
  workingDirectory?: string;
  /** Image attachments from the current conversation, keyed by variable name or indexed */
  attachments?: MessageAttachment[];
}

export interface ToolResult {
  success: boolean;
  output: string;
  metadata?: Record<string, any>;
}

export interface SkillIndexEntry {
  skillId: number;
  skillType: 'skill' | 'workflow';
  name: string;
  description: string;
  stepSummary: string;
  tags: string[];
}

export interface SearchResult {
  skillId: number;
  skillType: 'skill' | 'workflow';
  name: string;
  description: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  skillType?: 'skill' | 'workflow';
  minScore?: number;
}

export interface MemoryEntry {
  id: number;
  content: string;
  score: number;
  createdAt: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  supportsStreaming: boolean;
  supportsTools: boolean;
  contextWindow?: number;
}

export interface MessageAttachment {
  type: 'image';
  mimeType: string;
  data: string; // base64 encoded
}

export interface CompletionRequest {
  model: string;
  systemPrompt?: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    attachments?: MessageAttachment[];
    toolCallId?: string;
    toolCalls?: Array<{
      id: string;
      name: string;
      args: Record<string, any>;
      providerData?: Record<string, any>;
    }>;
  }>;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface StreamEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolCall?: {
    id: string;
    name: string;
    args: Record<string, any>;
    providerData?: Record<string, any>;
  };
  error?: string;
}

// ---- Plugin Manifest ----

export interface PluginManifest {
  name: string;
  version: string;
  type: 'channel' | 'tool' | 'memory' | 'provider';
  displayName: string;
  description: string;
  entry: string;
  config?: Record<string, any>; // JSON Schema for config validation
}

// ---- Base Plugin ----

export interface Plugin {
  manifest: PluginManifest;
  initialize(config: Record<string, any>): Promise<void>;
  shutdown(): Promise<void>;
}

// ---- Channel Plugin ----

export interface ChannelPlugin extends Plugin {
  parseInbound(req: Request): ChannelMessage | null;
  sendOutbound(channelId: string, response: AgentResponse): Promise<void>;
  verifyAuth(req: Request): boolean;
  registerRoutes(router: Router): void;
  setMessageHandler(handler: (message: ChannelMessage) => Promise<void>): void;
}

// ---- Tool Plugin ----

export interface ToolPlugin extends Plugin {
  getTools(): ToolDefinition[];
  execute(toolName: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult>;
}

// ---- Memory Plugin ----

export interface MemoryPlugin extends Plugin {
  index(item: SkillIndexEntry): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  storeMemory(sessionId: string, content: string, embedding?: number[]): Promise<void>;
  searchMemory(sessionId: string, query: string, limit?: number): Promise<MemoryEntry[]>;
}

// ---- Provider Plugin ----

export interface ProviderPlugin extends Plugin {
  listModels(): ModelInfo[];
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>;
  embed?(texts: string[]): Promise<number[][]>;
}

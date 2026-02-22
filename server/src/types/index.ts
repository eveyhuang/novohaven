// User types
export interface User {
  id: number;
  email: string;
  password_hash: string;
  api_keys?: string;
  created_at: string;
}

export interface UserPublic {
  id: number;
  email: string;
  created_at: string;
}

// Recipe types
export interface Recipe {
  id: number;
  name: string;
  description?: string;
  created_by: number;
  is_template: boolean;
  created_at: string;
  updated_at: string;
}

export interface RecipeWithSteps extends Recipe {
  steps: RecipeStep[];
}

export type StepType = 'ai' | 'scraping' | 'manus' | 'script' | 'browser' | 'http' | 'transform' | string;

export interface RecipeStep {
  id: number;
  recipe_id: number;
  step_order: number;
  step_name: string;
  step_type: StepType;
  ai_model: string;
  prompt_template: string;
  input_config?: string;
  output_format: 'text' | 'json' | 'markdown' | 'image' | 'file';
  model_config?: string;
  api_config?: string; // For non-AI steps: { service: 'manus', endpoint: 'scrape' }
  executor_config?: string; // JSON: executor-specific configuration
  created_at: string;
}

export interface StepInputConfig {
  variables: VariableConfig[];
}

export interface VariableConfig {
  name: string;
  source: 'user_input' | 'previous_step' | 'company_standard';
  stepId?: number;
  standardId?: number;
  required?: boolean;
  defaultValue?: string;
}

export interface ModelConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

// --- New gateway types ---

export interface Skill {
  id: number;
  name: string;
  description: string;
  created_by: number;
  status: 'draft' | 'active' | 'archived';
  tags: string; // JSON array
  created_at: string;
  updated_at: string;
}

export interface Workflow {
  id: number;
  name: string;
  description: string;
  created_by: number;
  status: 'draft' | 'active' | 'archived';
  tags: string;
  created_at: string;
  updated_at: string;
}

export interface SkillStep {
  id: number;
  parent_id: number;
  parent_type: 'skill' | 'workflow';
  step_order: number;
  step_name: string;
  step_type: string;
  ai_model: string;
  prompt_template: string;
  input_config: string;
  output_format: string;
  model_config: string;
  executor_config: string;
}

export interface Session {
  id: string;
  channel_type: string;
  channel_id: string;
  user_id: number;
  thread_id: string | null;
  agent_pid: number | null;
  status: 'active' | 'idle' | 'closed';
  agent_config_id: number | null;
  active_execution_id: number | null;
  created_at: string;
  last_active_at: string;
}

export interface SessionMessage {
  id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls: string | null;
  tool_results: string | null;
  metadata: string;
  created_at: string;
}

export interface AgentConfig {
  id: number;
  name: string;
  description: string;
  default_model: string;
  system_prompt: string;
  allowed_tools: string; // JSON array
  allowed_channels: string; // JSON array
  max_turns_per_session: number;
  created_at: string;
}

export interface PluginConfig {
  id: number;
  plugin_name: string;
  plugin_type: 'channel' | 'tool' | 'memory' | 'provider';
  enabled: boolean;
  config: string; // JSON
  updated_at: string;
}

export interface SkillDraft {
  id: number;
  original_skill_id: number | null;
  skill_type: 'skill' | 'workflow';
  proposed_by_session: string | null;
  name: string;
  description: string;
  steps: string; // JSON array
  change_summary: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  reviewed_at: string | null;
}

// Company Standards types
export interface CompanyStandard {
  id: number;
  user_id: number;
  standard_type: 'voice' | 'platform' | 'image';
  name: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface VoiceStandardContent {
  tone: string;
  style: string;
  guidelines: string[];
  examples?: string[];
}

export interface PlatformStandardContent {
  platform: string;
  requirements: string[];
  characterLimits?: Record<string, number>;
  formatting?: string;
}

export interface ImageStandardContent {
  style: string;
  dimensions?: string;
  guidelines: string[];
}

// Workflow Execution types
export type ExecutionStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed';
export type StepExecutionStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting_review';

export interface WorkflowExecution {
  id: number;
  recipe_id: number;
  user_id: number;
  status: ExecutionStatus;
  current_step: number;
  input_data?: string;
  started_at?: string;
  completed_at?: string;
  created_at: string;
}

export interface WorkflowExecutionWithDetails extends WorkflowExecution {
  recipe: Recipe;
  step_executions: StepExecution[];
}

export interface StepExecution {
  id: number;
  execution_id: number;
  step_id: number;
  step_order: number;
  status: StepExecutionStatus;
  input_data?: string;
  output_data?: string;
  ai_model_used?: string;
  prompt_used?: string;
  approved: boolean;
  error_message?: string;
  executed_at?: string;
}

// AI Service types
export type AIProvider = 'openai' | 'anthropic' | 'google' | 'mock';

export interface ImageData {
  base64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AIServiceConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  images?: ImageData[];
  // Image generation specific config
  numberOfImages?: number;
  aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  negativePrompt?: string;
  // Multi-turn conversation support
  systemMessage?: string;
  messages?: ChatMessage[];
}

export interface GeneratedImage {
  base64: string;
  mimeType: string;
}

export interface AIResponse {
  success: boolean;
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  error?: string;
  generatedImages?: GeneratedImage[];
}

export interface AIModelInfo {
  id: string;
  name: string;
  provider: AIProvider;
  maxTokens: number;
  supportsVision?: boolean;
  supportsImageGeneration?: boolean;
}

// Available AI Models
export const AI_MODELS: AIModelInfo[] = [
  // OpenAI
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai', maxTokens: 128000, supportsVision: true },
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', maxTokens: 128000, supportsVision: true },
  { id: 'gpt-4', name: 'GPT-4', provider: 'openai', maxTokens: 8192 },
  // Anthropic
  { id: 'claude-opus-4-6', name: 'Claude 4.6 Opus', provider: 'anthropic', maxTokens: 200000, supportsVision: true },
  // Google
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', provider: 'google', maxTokens: 1000000, supportsVision: true },
  { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', provider: 'google', maxTokens: 1000000, supportsVision: true },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', maxTokens: 1000000, supportsVision: true },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', maxTokens: 1000000, supportsVision: true },
  { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', provider: 'google', maxTokens: 1000000, supportsVision: true },
  // Google Image Generation
  { id: 'gemini-3-pro-image-preview', name: 'Gemini 3 Pro Image (Nanobanana)', provider: 'google', maxTokens: 1000000, supportsVision: true, supportsImageGeneration: true },

  ];

// API Request/Response types
export interface CreateRecipeRequest {
  name: string;
  description?: string;
  steps?: Omit<RecipeStep, 'id' | 'recipe_id' | 'created_at'>[];
  is_template?: boolean;
}

export interface UpdateRecipeRequest {
  name?: string;
  description?: string;
  steps?: Omit<RecipeStep, 'id' | 'recipe_id' | 'created_at'>[];
  is_template?: boolean;
}

export interface CreateStandardRequest {
  standard_type: 'voice' | 'platform' | 'image';
  name: string;
  content: string;
}

export interface StartExecutionRequest {
  recipe_id: number;
  input_data: Record<string, any>;
}

export interface ApproveStepRequest {
  approved: boolean;
  modifications?: string;
}

export interface RetryStepRequest {
  modified_prompt?: string;
  modified_input?: Record<string, any>;
}

export interface TestAIRequest {
  provider: AIProvider;
  model: string;
  prompt: string;
  config?: AIServiceConfig;
}

// Manus AI scraping types
export interface ManusFile {
  name: string;
  url: string;
  type: string;
  size?: number;
}

export interface ManusTaskResult {
  taskId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output: string;
  files?: ManusFile[];
  creditsUsed?: number;
}

export interface ManusMessage {
  role: 'assistant' | 'user' | 'system';
  content: Array<{ type: string; text?: string; url?: string; [key: string]: any }>;
  timestamp?: string;
}

export interface ScrapingStatus {
  manus_configured: boolean;
}

// Browser automation types
export interface BrowserTaskResult {
  taskId: string;
  status: 'created' | 'launching' | 'running' | 'captcha' | 'completed' | 'failed';
  output?: string;
  reviewCount?: number;
  error?: string;
}

export interface BrowserProgressEvent {
  type: 'status' | 'message' | 'take_control' | 'complete' | 'error';
  data: Record<string, any>;
}

// Usage tracking types
export interface ApiUsage {
  id: number;
  user_id: number;
  service: string;
  endpoint: string;
  request_count: number;
  records_fetched: number;
  created_at: string;
}

export interface UsageStats {
  total_requests: number;
  total_records: number;
  by_service: Record<string, { requests: number; records: number }>;
  by_period: {
    today: number;
    this_week: number;
    this_month: number;
  };
}


// Execution Chat Message types (unified chat protocol)
export type ExecutionChatMessageType =
  | 'step-start' | 'progress' | 'agent-message' | 'user-message'
  | 'step-output' | 'step-error' | 'action-required'
  | 'step-approved' | 'step-rejected' | 'execution-complete';

export interface ExecutionChatMessage {
  id: string;
  executionId: number;
  stepOrder: number;
  stepName: string;
  stepType: StepType;
  type: ExecutionChatMessageType;
  role: 'system' | 'assistant' | 'user';
  content: string;
  metadata?: {
    taskId?: string;
    images?: GeneratedImage[];
    files?: ManusFile[];
    usage?: { promptTokens: number; completionTokens: number };
    model?: string;
    actionType?: 'approve' | 'captcha' | 'take-control';
    debuggerUrl?: string;
    isJson?: boolean;
    stepExecutionId?: number;
  };
  timestamp: string;
}

// Express extended types
declare global {
  namespace Express {
    interface Request {
      user?: UserPublic;
    }
  }
}

// User types
export interface User {
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
  step_count?: number;
  steps?: RecipeStep[];
  required_inputs?: string[];
}

export interface RecipeStep {
  id?: number;
  recipe_id?: number;
  step_order: number;
  step_name: string;
  ai_model: string;
  prompt_template: string;
  input_config?: string;
  output_format: 'text' | 'json' | 'markdown' | 'image';
  model_config?: string;
  created_at?: string;
}

export interface ModelConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

// Input type configurations for template variables
export type InputType = 'text' | 'textarea' | 'image' | 'url_list' | 'file';

export interface InputTypeConfig {
  type: InputType;
  label?: string;
  placeholder?: string;
  description?: string;
  // For file inputs
  acceptedFileTypes?: string[]; // e.g., ['.csv', '.xlsx', '.json']
  // For url_list inputs
  minUrls?: number;
  maxUrls?: number;
  // For image inputs
  maxImageSize?: number; // in MB
  acceptedImageTypes?: string[]; // e.g., ['image/png', 'image/jpeg']
}

export interface TemplateInputConfig {
  variables: Record<string, InputTypeConfig>;
}

// Company Standards types
export interface CompanyStandard {
  id: number;
  user_id: number;
  standard_type: 'voice' | 'platform' | 'image';
  name: string;
  content: any;
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
  input_data?: Record<string, any>;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  recipe?: Recipe;
  recipe_name?: string;
  step_executions?: StepExecution[];
  total_steps?: number;
}

export interface StepExecution {
  id: number;
  execution_id: number;
  step_id: number;
  step_order: number;
  status: StepExecutionStatus;
  input_data?: string;
  output_data?: string;
  output?: {
    content: string;
    model: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
    };
    generatedImages?: GeneratedImage[];
  };
  ai_model_used?: string;
  ai_model?: string;
  prompt_used?: string;
  approved: boolean;
  error_message?: string;
  executed_at?: string;
  step_name?: string;
}

export interface ExecutionResult {
  success: boolean;
  executionId: number;
  status: ExecutionStatus;
  currentStep: number;
  stepResults: StepExecutionResult[];
  error?: string;
}

export interface StepExecutionResult {
  stepId: number;
  stepOrder: number;
  stepName: string;
  status: StepExecutionStatus;
  output?: string;
  error?: string;
}

// AI types
export type AIProvider = 'openai' | 'anthropic' | 'google' | 'mock';

export interface AIModel {
  id: string;
  name: string;
  provider: AIProvider;
  maxTokens: number;
  available?: boolean;
  supportsVision?: boolean;
  supportsImageGeneration?: boolean;
}

export interface AIProvider_Status {
  id: AIProvider;
  name: string;
  configured: boolean;
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

// API Request types
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
  content: any;
}

export interface StartExecutionRequest {
  recipe_id: number;
  input_data: Record<string, any>;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  user: User;
  token: string;
  message: string;
}

// Scraping types
export type ScrapingPlatform = 'amazon' | 'walmart' | 'wayfair';

export interface ReviewData {
  id: string;
  platform: ScrapingPlatform;
  product_url: string;
  product_name?: string;
  product_price?: string;
  product_features?: string[];
  reviewer_name?: string;
  rating: number;
  review_title?: string;
  review_text: string;
  review_date?: string;
  verified_purchase?: boolean;
  helpful_votes?: number;
  sentiment?: 'positive' | 'neutral' | 'negative';
}

export interface ScrapedProductData {
  url: string;
  platform: ScrapingPlatform;
  product_name: string;
  product_price?: string;
  product_features?: string[];
  average_rating?: number;
  total_reviews?: number;
  reviews: ReviewData[];
  scraped_at: string;
}

export interface ScrapingResponse {
  success: boolean;
  data?: ScrapedProductData[];
  error?: string;
  invalid_urls?: string[];
  usage?: {
    requests_made: number;
    reviews_fetched: number;
  };
}

export interface ScrapingStatus {
  brightdata_configured: boolean;
  supported_platforms: string[];
  csv_upload_enabled: boolean;
}

export interface CSVParseResult {
  success: boolean;
  data?: ReviewData[];
  error?: string;
  warnings?: string[];
}

// Usage tracking types
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

export interface UsageHistoryItem {
  id: number;
  user_id: number;
  service: string;
  endpoint: string;
  request_count: number;
  records_fetched: number;
  metadata?: string;
  created_at: string;
}

export interface BillingReport {
  userId: number;
  stats: UsageStats;
  estimatedCost?: number;
}

export interface AdminUsageItem {
  user_id: number;
  email: string;
  service: string;
  total_requests: number;
  total_records: number;
  last_used: string;
}

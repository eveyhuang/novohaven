import {
  Recipe,
  CreateRecipeRequest,
  UpdateRecipeRequest,
  CompanyStandard,
  CreateStandardRequest,
  WorkflowExecution,
  ExecutionResult,
  AIModel,
  AIProvider_Status,
  AIResponse,
  LoginRequest,
  LoginResponse,
  User,
  ScrapingResponse,
  ScrapingStatus,
  CSVParseResult,
  ScrapingPlatform,
  ReviewData,
  UsageStats,
  UsageHistoryItem,
  BillingReport,
  AdminUsageItem,
} from '../types';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('auth_token', token);
    } else {
      localStorage.removeItem('auth_token');
    }
  }

  getToken(): string | null {
    if (!this.token) {
      this.token = localStorage.getItem('auth_token');
    }
    return this.token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${API_BASE_URL}${endpoint}`;
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const token = this.getToken();
    if (token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP error ${response.status}`);
    }

    return response.json();
  }

  // Auth endpoints
  async login(credentials: LoginRequest): Promise<LoginResponse> {
    const response = await this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    this.setToken(response.token);
    return response;
  }

  async logout(): Promise<void> {
    await this.request<{ message: string }>('/auth/logout', {
      method: 'POST',
    });
    this.setToken(null);
  }

  async getCurrentUser(): Promise<{ user: User }> {
    return this.request<{ user: User }>('/auth/me');
  }

  // Recipe endpoints
  async getRecipes(): Promise<Recipe[]> {
    return this.request<Recipe[]>('/recipes');
  }

  async getRecipe(id: number): Promise<Recipe> {
    return this.request<Recipe>(`/recipes/${id}`);
  }

  async createRecipe(data: CreateRecipeRequest): Promise<Recipe> {
    return this.request<Recipe>('/recipes', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateRecipe(id: number, data: UpdateRecipeRequest): Promise<Recipe> {
    return this.request<Recipe>(`/recipes/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteRecipe(id: number): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/recipes/${id}`, {
      method: 'DELETE',
    });
  }

  async cloneRecipe(id: number, name?: string): Promise<Recipe> {
    return this.request<Recipe>(`/recipes/${id}/clone`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  // Execution endpoints
  async getExecutions(): Promise<WorkflowExecution[]> {
    return this.request<WorkflowExecution[]>('/executions');
  }

  async getExecution(id: number): Promise<WorkflowExecution> {
    return this.request<WorkflowExecution>(`/executions/${id}`);
  }

  async startExecution(
    recipeId: number,
    inputData: Record<string, any>,
    modifiedSteps?: any[]
  ): Promise<ExecutionResult> {
    return this.request<ExecutionResult>('/executions', {
      method: 'POST',
      body: JSON.stringify({
        recipe_id: recipeId,
        input_data: inputData,
        steps: modifiedSteps,
      }),
    });
  }

  async approveStep(executionId: number, stepId: number): Promise<ExecutionResult> {
    return this.request<ExecutionResult>(`/executions/${executionId}/steps/${stepId}/approve`, {
      method: 'POST',
    });
  }

  async rejectStep(executionId: number, stepId: number): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/executions/${executionId}/steps/${stepId}/reject`, {
      method: 'POST',
    });
  }

  async retryStep(
    executionId: number,
    stepId: number,
    modifiedPrompt?: string,
    modifiedInput?: Record<string, any>
  ): Promise<ExecutionResult> {
    return this.request<ExecutionResult>(`/executions/${executionId}/steps/${stepId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ modified_prompt: modifiedPrompt, modified_input: modifiedInput }),
    });
  }

  async getExecutionStatus(id: number): Promise<ExecutionResult> {
    return this.request<ExecutionResult>(`/executions/${id}/status`);
  }

  async cancelExecution(id: number): Promise<{ success: boolean; message: string }> {
    return this.request(`/executions/${id}/cancel`, {
      method: 'POST',
    });
  }

  async deleteExecution(id: number): Promise<{ success: boolean; message: string }> {
    return this.request(`/executions/${id}`, {
      method: 'DELETE',
    });
  }

  // Standards endpoints
  async getStandards(): Promise<CompanyStandard[]> {
    return this.request<CompanyStandard[]>('/standards');
  }

  async getStandard(id: number): Promise<CompanyStandard> {
    return this.request<CompanyStandard>(`/standards/${id}`);
  }

  async getStandardsByType(type: 'voice' | 'platform' | 'image'): Promise<CompanyStandard[]> {
    return this.request<CompanyStandard[]>(`/standards/type/${type}`);
  }

  async createStandard(data: CreateStandardRequest): Promise<CompanyStandard> {
    return this.request<CompanyStandard>('/standards', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateStandard(id: number, data: Partial<CreateStandardRequest>): Promise<CompanyStandard> {
    return this.request<CompanyStandard>(`/standards/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteStandard(id: number): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/standards/${id}`, {
      method: 'DELETE',
    });
  }

  async previewStandard(id: number): Promise<{ preview: string }> {
    return this.request<{ preview: string }>(`/standards/preview/${id}`);
  }

  // AI endpoints
  async getAIModels(): Promise<{ available: AIModel[]; all: AIModel[] }> {
    return this.request<{ available: AIModel[]; all: AIModel[] }>('/ai/models');
  }

  async getAIProviders(): Promise<AIProvider_Status[]> {
    return this.request<AIProvider_Status[]>('/ai/providers');
  }

  async testAI(
    provider: string,
    model: string,
    prompt: string,
    config?: { temperature?: number; maxTokens?: number },
    images?: Array<{ base64: string; mediaType: string }>
  ): Promise<AIResponse> {
    return this.request<AIResponse>('/ai/test', {
      method: 'POST',
      body: JSON.stringify({ provider, model, prompt, config, images }),
    });
  }

  async validatePrompt(prompt: string): Promise<{
    valid: boolean;
    variables: {
      all: string[];
      user_input: string[];
      step_output: string[];
      company_standard: string[];
    };
    prompt_length: number;
  }> {
    return this.request('/ai/validate', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
  }

  // Executor endpoints
  async getExecutors(): Promise<ExecutorInfo[]> {
    return this.request<ExecutorInfo[]>('/executors');
  }

  // Health check
  async healthCheck(): Promise<{ status: string; timestamp: string }> {
    return this.request<{ status: string; timestamp: string }>('/health');
  }

  // Outputs endpoints
  async getOutputs(): Promise<OutputsResponse> {
    return this.request('/outputs');
  }

  async getOutput(id: number): Promise<OutputItem> {
    return this.request(`/outputs/${id}`);
  }

  // Scraping endpoints
  async getScrapingStatus(): Promise<ScrapingStatus> {
    return this.request<ScrapingStatus>('/scraping/status');
  }

  async scrapeReviews(urls: string[]): Promise<ScrapingResponse> {
    return this.request<ScrapingResponse>('/scraping/reviews', {
      method: 'POST',
      body: JSON.stringify({ urls }),
    });
  }

  async parseCSV(
    content: string,
    platform?: ScrapingPlatform,
    productUrl?: string
  ): Promise<CSVParseResult> {
    return this.request<CSVParseResult>('/scraping/csv/parse', {
      method: 'POST',
      body: JSON.stringify({ content, platform, product_url: productUrl }),
    });
  }

  async exportReviews(
    reviews: ReviewData[],
    format: 'csv' | 'json' = 'json'
  ): Promise<Blob> {
    const url = `${API_BASE_URL}/scraping/export`;
    const token = this.getToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };
    if (token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ reviews, format }),
    });

    if (!response.ok) {
      throw new Error('Export failed');
    }

    return response.blob();
  }

  async normalizeReviews(
    scrapedData?: any[],
    csvReviews?: ReviewData[]
  ): Promise<{
    success: boolean;
    total_reviews: number;
    products: any[];
    all_reviews: ReviewData[];
  }> {
    return this.request('/scraping/normalize', {
      method: 'POST',
      body: JSON.stringify({
        scraped_data: scrapedData,
        csv_reviews: csvReviews,
      }),
    });
  }

  // Usage tracking endpoints
  async getUsageStats(): Promise<UsageStats> {
    return this.request<UsageStats>('/usage');
  }

  async getUsageHistory(service?: string): Promise<UsageHistoryItem[]> {
    const endpoint = service ? `/usage/history?service=${service}` : '/usage/history';
    return this.request<UsageHistoryItem[]>(endpoint);
  }

  async getBillingReport(): Promise<BillingReport> {
    return this.request<BillingReport>('/usage/billing');
  }

  async getAdminUsage(): Promise<AdminUsageItem[]> {
    return this.request<AdminUsageItem[]>('/usage/admin');
  }

  // Assistant endpoints
  async assistantGenerate(messages: AssistantMessage[]): Promise<AssistantResponse> {
    return this.request<AssistantResponse>('/assistant/generate', {
      method: 'POST',
      body: JSON.stringify({ messages }),
    });
  }

  async assistantSave(
    workflow: GeneratedWorkflow,
    isTemplate?: boolean
  ): Promise<{ success: boolean; recipeId: number; message: string }> {
    return this.request('/assistant/save', {
      method: 'POST',
      body: JSON.stringify({ workflow, isTemplate }),
    });
  }
}

export interface ExecutorConfigField {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number' | 'boolean' | 'json' | 'code';
  required?: boolean;
  defaultValue?: any;
  options?: { value: string; label: string }[];
  language?: string;
  helpText?: string;
}

export interface ExecutorInfo {
  type: string;
  displayName: string;
  icon: string;
  description: string;
  configSchema: { fields: ExecutorConfigField[] };
}

export interface OutputItem {
  id: number;
  executionId: number;
  stepId: number;
  recipeName: string;
  stepName: string;
  outputFormat: string;
  aiModel: string;
  executedAt: string;
  content: string;
  generatedImages?: Array<{
    base64: string;
    mimeType: string;
  }>;
}

export interface OutputsResponse {
  all: OutputItem[];
  text: OutputItem[];
  markdown: OutputItem[];
  json: OutputItem[];
  images: OutputItem[];
}

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GeneratedStep {
  step_name: string;
  step_type: string;
  ai_model: string;
  prompt_template: string;
  output_format: 'text' | 'json' | 'markdown' | 'image';
  executor_config?: Record<string, any>;
}

export interface GeneratedWorkflow {
  name: string;
  description: string;
  steps: GeneratedStep[];
  requiredInputs: { name: string; type: string; description: string }[];
}

export interface AssistantResponse {
  message: string;
  workflow?: GeneratedWorkflow;
  suggestions?: string[];
}

export const api = new ApiClient();
export default api;

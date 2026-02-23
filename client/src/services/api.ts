import {
  WorkflowDefinition,
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
  ScrapingStatus,
  ManusTestResult,
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

  // Execution endpoints
  async getExecutions(): Promise<WorkflowExecution[]> {
    return this.request<WorkflowExecution[]>('/executions');
  }

  async getExecution(id: number): Promise<WorkflowExecution> {
    return this.request<WorkflowExecution>(`/executions/${id}`);
  }

  async startQuickExecution(
    stepType: string,
    prompt: string,
    inputData?: Record<string, any>
  ): Promise<ExecutionResult> {
    return this.request<ExecutionResult>('/executions/quick', {
      method: 'POST',
      body: JSON.stringify({
        step_type: stepType,
        prompt,
        input_data: inputData || {},
      }),
    });
  }

  async startSkillExecution(
    skillId: number,
    inputData: Record<string, any>,
    modifiedSteps?: any[]
  ): Promise<ExecutionResult> {
    return this.request<ExecutionResult>('/executions', {
      method: 'POST',
      body: JSON.stringify({
        skill_id: skillId,
        input_data: inputData,
        steps: modifiedSteps,
      }),
    });
  }

  async startWorkflowExecution(
    workflowId: number,
    inputData: Record<string, any>,
    modifiedSteps?: any[]
  ): Promise<ExecutionResult> {
    return this.request<ExecutionResult>('/executions', {
      method: 'POST',
      body: JSON.stringify({
        workflow_id: workflowId,
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

  async deleteAllExecutions(): Promise<{ success: boolean; deleted: number }> {
    return this.request('/executions', { method: 'DELETE' });
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
  async getExecutors(mode: 'all' | 'business' = 'all'): Promise<ExecutorInfo[]> {
    const query = mode === 'all' ? '' : `?mode=${mode}`;
    return this.request<ExecutorInfo[]>(`/executors${query}`);
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

  async testScraping(prompt: string, urls?: string[]): Promise<ManusTestResult> {
    return this.request<ManusTestResult>('/scraping/test', {
      method: 'POST',
      body: JSON.stringify({ prompt, urls }),
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

  // Manus chat endpoints
  async startManusTask(prompt: string, urls?: string[]): Promise<{ taskId: string }> {
    return this.request<{ taskId: string }>('/manus/tasks', {
      method: 'POST',
      body: JSON.stringify({ prompt, urls }),
    });
  }

  async startManusTaskFromSkill(
    skillId: number,
    variables: Record<string, string>
  ): Promise<{ taskId: string; compiledPrompt: string }> {
    return this.request<{ taskId: string; compiledPrompt: string }>('/manus/tasks/from-skill', {
      method: 'POST',
      body: JSON.stringify({ skillId, variables }),
    });
  }

  async sendManusMessage(taskId: string, message: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/manus/tasks/${taskId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
  }

  connectManusStream(taskId: string): EventSource {
    const token = this.getToken();
    const url = `${API_BASE_URL}/manus/tasks/${taskId}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    return new EventSource(url);
  }

  // Browser automation endpoints
  async startBrowserTask(platform: string, urls: string[], maxReviews?: number): Promise<{ taskId: string; platform: string }> {
    return this.request<{ taskId: string; platform: string }>('/browser/tasks', {
      method: 'POST',
      body: JSON.stringify({ platform, urls, maxReviews }),
    });
  }

  connectBrowserStream(taskId: string): EventSource {
    const token = this.getToken();
    const url = `${API_BASE_URL}/browser/tasks/${taskId}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    return new EventSource(url);
  }

  async resumeBrowserTask(taskId: string): Promise<{ success: boolean }> {
    return this.request<{ success: boolean }>(`/browser/tasks/${taskId}/resume`, {
      method: 'POST',
    });
  }

  async getBrowserScreenshot(taskId: string): Promise<{ screenshot: string }> {
    return this.request<{ screenshot: string }>(`/browser/tasks/${taskId}/screenshot`);
  }

  // Execution stream (unified chat SSE)
  connectExecutionStream(executionId: number): EventSource {
    const token = this.getToken();
    const url = `${API_BASE_URL}/executions/${executionId}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    return new EventSource(url);
  }

  // Get Manus conversation history for chat reconstruction
  async getManusMessages(taskId: string): Promise<{
    taskId: string;
    messages: any[];
    status: string;
    files?: any[];
    creditsUsed?: number;
  }> {
    return this.request(`/manus/tasks/${taskId}/messages`);
  }

  // Skill endpoints (new architecture)
  async getSkills(): Promise<WorkflowDefinition[]> {
    return this.request('/skills');
  }

  async getSkill(id: number): Promise<WorkflowDefinition> {
    return this.request(`/skills/${id}`);
  }

  async createSkill(data: any): Promise<WorkflowDefinition> {
    return this.request('/skills', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateSkill(id: number, data: any): Promise<WorkflowDefinition> {
    return this.request(`/skills/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteSkill(id: number): Promise<{ success: boolean }> {
    return this.request(`/skills/${id}`, { method: 'DELETE' });
  }

  async cloneSkill(id: number, name?: string): Promise<WorkflowDefinition> {
    return this.request(`/skills/${id}/clone`, { method: 'POST', body: JSON.stringify({ name }) });
  }

  // Workflow endpoints (new architecture)
  async getWorkflows(): Promise<WorkflowDefinition[]> {
    return this.request('/workflows');
  }

  async getWorkflow(id: number): Promise<WorkflowDefinition> {
    return this.request(`/workflows/${id}`);
  }

  async createWorkflow(data: any): Promise<WorkflowDefinition> {
    return this.request('/workflows', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateWorkflow(id: number, data: any): Promise<WorkflowDefinition> {
    return this.request(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteWorkflow(id: number): Promise<{ success: boolean }> {
    return this.request(`/workflows/${id}`, { method: 'DELETE' });
  }

  async cloneWorkflow(id: number, name?: string): Promise<WorkflowDefinition> {
    return this.request(`/workflows/${id}/clone`, { method: 'POST', body: JSON.stringify({ name }) });
  }

  // Session endpoints
  async getSessions(): Promise<any[]> {
    return this.request('/sessions');
  }

  async getSession(id: string): Promise<any> {
    return this.request(`/sessions/${id}`);
  }

  async closeSession(id: string): Promise<{ success: boolean }> {
    return this.request(`/sessions/${id}/close`, { method: 'POST' });
  }

  async deleteSession(id: string): Promise<{ success: boolean }> {
    return this.request(`/sessions/${id}`, { method: 'DELETE' });
  }

  async deleteAllSessions(): Promise<{ success: boolean }> {
    return this.request('/sessions', { method: 'DELETE' });
  }

  async closeAllSessions(): Promise<{ success: boolean; closed: number }> {
    return this.request('/sessions/close-all', { method: 'POST' });
  }

  // Plugin endpoints
  async getPlugins(): Promise<any[]> {
    return this.request('/plugins');
  }

  async updatePlugin(name: string, data: { enabled: boolean; config?: any }): Promise<{ success: boolean }> {
    return this.request(`/plugins/${name}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async getAvailableModels(): Promise<Array<{ id: string; name: string; provider: string }>> {
    return this.request('/plugins/models');
  }

  // Agent config endpoints
  async getAgents(): Promise<any[]> {
    return this.request('/agents');
  }

  async getAgent(id: number): Promise<any> {
    return this.request(`/agents/${id}`);
  }

  async createAgent(data: any): Promise<any> {
    return this.request('/agents', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateAgent(id: number, data: any): Promise<any> {
    return this.request(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteAgent(id: number): Promise<{ success: boolean }> {
    return this.request(`/agents/${id}`, { method: 'DELETE' });
  }

  // Skill draft endpoints
  async getSkillDrafts(): Promise<any[]> {
    return this.request('/skills/drafts');
  }

  async getSkillDraft(id: number): Promise<any> {
    return this.request(`/skills/drafts/${id}`);
  }

  async approveSkillDraft(id: number): Promise<{ success: boolean }> {
    return this.request(`/skills/drafts/${id}/approve`, { method: 'POST' });
  }

  async rejectSkillDraft(id: number): Promise<{ success: boolean }> {
    return this.request(`/skills/drafts/${id}/reject`, { method: 'POST' });
  }

  // Web channel endpoints (for AgentChat)
  async sendAgentMessage(
    sessionId: string,
    text: string,
    attachments?: Array<{ type: string; data: string; name: string; mimeType: string }>
  ): Promise<any> {
    const channelBase = API_BASE_URL.replace('/api', '');
    const response = await fetch(`${channelBase}/channels/channel-web/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.getToken() ? { Authorization: `Bearer ${this.getToken()}` } : {}),
      },
      body: JSON.stringify({ sessionId, text, attachments }),
    });
    return response.json();
  }

  connectAgentStream(sessionId: string): EventSource {
    const channelBase = API_BASE_URL.replace('/api', '');
    const token = this.getToken();
    const url = `${channelBase}/channels/channel-web/stream?sessionId=${sessionId}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    return new EventSource(url);
  }

  // Assistant endpoints
  async assistantGenerate(messages: AssistantMessage[], modelId?: string): Promise<AssistantResponse> {
    return this.request<AssistantResponse>('/assistant/generate', {
      method: 'POST',
      body: JSON.stringify({ messages, modelId }),
    });
  }

  async assistantSave(
    workflow: GeneratedWorkflow,
    asSkill?: boolean
  ): Promise<{ success: boolean; entityType: 'skill' | 'workflow'; skillId?: number; workflowId?: number; createdSkillIds?: number[]; message: string }> {
    return this.request('/assistant/save', {
      method: 'POST',
      body: JSON.stringify({ workflow, asSkill }),
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

export interface ManusFileOutput {
  name: string;
  url: string;
  type: string;
  size?: number;
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
  fileName?: string;
  fileExtension?: string;
  fileMimeType?: string;
  generatedImages?: Array<{
    base64: string;
    mimeType: string;
  }>;
  manusFiles?: ManusFileOutput[];
  manusTaskId?: string;
}

export interface OutputsResponse {
  all: OutputItem[];
  text: OutputItem[];
  markdown: OutputItem[];
  json: OutputItem[];
  images: OutputItem[];
  files: OutputItem[];
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
  output_format: 'text' | 'json' | 'markdown' | 'image' | 'file';
  executor_config?: Record<string, any>;
  from_skill_id?: number;
  from_skill_blueprint?: string;
  from_skill_name?: string;
  from_step_order?: number;
  override_fields?: string[];
}

export interface GeneratedInputSpec {
  name: string;
  type: string;
  description: string;
}

export interface GeneratedSkillBlueprint {
  key?: string;
  name: string;
  description?: string;
  tags?: string[];
  requiredInputs?: GeneratedInputSpec[];
  steps: GeneratedStep[];
}

export interface GeneratedWorkflow {
  name: string;
  description: string;
  steps: GeneratedStep[];
  requiredInputs: GeneratedInputSpec[];
  skill_blueprints?: GeneratedSkillBlueprint[];
}

export interface AssistantResponse {
  message: string;
  workflow?: GeneratedWorkflow;
  suggestions?: string[];
}

export const api = new ApiClient();
export default api;

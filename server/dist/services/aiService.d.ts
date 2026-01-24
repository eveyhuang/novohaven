import { AIProvider, AIResponse, AIServiceConfig } from '../types';
export declare function getProviderForModel(modelId: string): AIProvider;
export declare function callAI(provider: AIProvider, model: string, prompt: string, config?: AIServiceConfig): Promise<AIResponse>;
export declare function callAIByModel(modelId: string, prompt: string, config?: AIServiceConfig): Promise<AIResponse>;
export declare function isProviderConfigured(provider: AIProvider): boolean;
export declare function getAvailableModels(): import("../types").AIModelInfo[];
export declare function modelSupportsVision(modelId: string): boolean;
export declare function modelSupportsImageGeneration(modelId: string): boolean;
export declare function getModelInfo(modelId: string): import("../types").AIModelInfo | undefined;
//# sourceMappingURL=aiService.d.ts.map
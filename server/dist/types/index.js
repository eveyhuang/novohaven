"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AI_MODELS = void 0;
// Available AI Models
exports.AI_MODELS = [
    // OpenAI
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openai', maxTokens: 128000, supportsVision: true },
    { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', maxTokens: 128000, supportsVision: true },
    { id: 'gpt-4', name: 'GPT-4', provider: 'openai', maxTokens: 8192 },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', provider: 'openai', maxTokens: 16385 },
    // Anthropic
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', maxTokens: 200000, supportsVision: true },
    // Google
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google', maxTokens: 1000000, supportsVision: true },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', provider: 'google', maxTokens: 1000000, supportsVision: true },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google', maxTokens: 1000000, supportsVision: true },
    // Google Image Generation
    { id: 'gemini-3-pro-image-preview', name: 'Gemini 3 Pro Image (Nanobanana)', provider: 'google', maxTokens: 1000000, supportsVision: true, supportsImageGeneration: true },
    { id: 'gemini-2.5-flash-image', name: 'Gemini 2.5 Flash Image (Nanobanana)', provider: 'google', maxTokens: 1000000, supportsVision: true, supportsImageGeneration: true },
];
//# sourceMappingURL=index.js.map
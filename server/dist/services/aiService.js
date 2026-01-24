"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getProviderForModel = getProviderForModel;
exports.callAI = callAI;
exports.callAIByModel = callAIByModel;
exports.isProviderConfigured = isProviderConfigured;
exports.getAvailableModels = getAvailableModels;
exports.modelSupportsVision = modelSupportsVision;
exports.modelSupportsImageGeneration = modelSupportsImageGeneration;
exports.getModelInfo = getModelInfo;
const openai_1 = __importDefault(require("openai"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const generative_ai_1 = require("@google/generative-ai");
const types_1 = require("../types");
// Initialize clients (lazy initialization)
let openaiClient = null;
let anthropicClient = null;
let googleClient = null;
function getOpenAIClient() {
    if (!openaiClient) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY environment variable is not set');
        }
        openaiClient = new openai_1.default({ apiKey });
    }
    return openaiClient;
}
function getAnthropicClient() {
    if (!anthropicClient) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error('ANTHROPIC_API_KEY environment variable is not set');
        }
        anthropicClient = new sdk_1.default({ apiKey });
    }
    return anthropicClient;
}
function getGoogleClient() {
    if (!googleClient) {
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey) {
            throw new Error('GOOGLE_API_KEY environment variable is not set');
        }
        googleClient = new generative_ai_1.GoogleGenerativeAI(apiKey);
    }
    return googleClient;
}
// Get provider for a model
function getProviderForModel(modelId) {
    const model = types_1.AI_MODELS.find(m => m.id === modelId);
    if (!model) {
        throw new Error(`Unknown model: ${modelId}`);
    }
    return model.provider;
}
// OpenAI implementation
async function callOpenAI(model, prompt, config) {
    try {
        const client = getOpenAIClient();
        // Build message content - handle vision if images are provided
        let messageContent;
        if (config.images && config.images.length > 0) {
            // Vision request with images
            messageContent = [
                { type: 'text', text: prompt },
                ...config.images.map((img) => ({
                    type: 'image_url',
                    image_url: {
                        url: img.base64.startsWith('data:')
                            ? img.base64
                            : `data:${img.mediaType};base64,${img.base64}`,
                    },
                })),
            ];
        }
        else {
            messageContent = prompt;
        }
        const response = await client.chat.completions.create({
            model,
            messages: [{ role: 'user', content: messageContent }],
            temperature: config.temperature ?? 0.7,
            max_tokens: config.maxTokens ?? 2000,
            top_p: config.topP ?? 1,
        });
        const content = response.choices[0]?.message?.content || '';
        return {
            success: true,
            content,
            model,
            usage: {
                promptTokens: response.usage?.prompt_tokens || 0,
                completionTokens: response.usage?.completion_tokens || 0,
            },
        };
    }
    catch (error) {
        return {
            success: false,
            content: '',
            model,
            error: error.message || 'OpenAI API call failed',
        };
    }
}
// Anthropic implementation
async function callAnthropic(model, prompt, config) {
    try {
        const client = getAnthropicClient();
        // Build message content - handle vision if images are provided
        let messageContent;
        if (config.images && config.images.length > 0) {
            // Vision request with images
            messageContent = [
                ...config.images.map((img) => ({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: img.mediaType,
                        data: img.base64.startsWith('data:')
                            ? img.base64.split(',')[1] // Extract base64 part after data:mime;base64,
                            : img.base64,
                    },
                })),
                { type: 'text', text: prompt },
            ];
        }
        else {
            messageContent = prompt;
        }
        const response = await client.messages.create({
            model,
            max_tokens: config.maxTokens ?? 2000,
            messages: [{ role: 'user', content: messageContent }],
        });
        const content = response.content[0]?.type === 'text'
            ? response.content[0].text
            : '';
        return {
            success: true,
            content,
            model,
            usage: {
                promptTokens: response.usage?.input_tokens || 0,
                completionTokens: response.usage?.output_tokens || 0,
            },
        };
    }
    catch (error) {
        return {
            success: false,
            content: '',
            model,
            error: error.message || 'Anthropic API call failed',
        };
    }
}
// Google Gemini implementation
async function callGoogle(model, prompt, config) {
    try {
        const client = getGoogleClient();
        const generativeModel = client.getGenerativeModel({
            model,
            generationConfig: {
                temperature: config.temperature ?? 0.7,
                maxOutputTokens: config.maxTokens ?? 2000,
                topP: config.topP ?? 1,
            },
        });
        // Build content parts - handle vision if images are provided
        let contentParts;
        if (config.images && config.images.length > 0) {
            // Vision request with images
            contentParts = [
                ...config.images.map((img) => ({
                    inlineData: {
                        mimeType: img.mediaType,
                        data: img.base64.startsWith('data:')
                            ? img.base64.split(',')[1] // Extract base64 part after data:mime;base64,
                            : img.base64,
                    },
                })),
                { text: prompt },
            ];
        }
        else {
            contentParts = [{ text: prompt }];
        }
        const result = await generativeModel.generateContent(contentParts);
        const response = result.response;
        const content = response.text();
        return {
            success: true,
            content,
            model,
            usage: {
                promptTokens: 0, // Gemini doesn't provide token counts in the same way
                completionTokens: 0,
            },
        };
    }
    catch (error) {
        return {
            success: false,
            content: '',
            model,
            error: error.message || 'Google Gemini API call failed',
        };
    }
}
// Google Gemini Image Generation implementation
async function callGoogleImageGeneration(model, prompt, config) {
    try {
        const client = getGoogleClient();
        const generativeModel = client.getGenerativeModel({
            model,
            generationConfig: {
                temperature: config.temperature ?? 1,
                maxOutputTokens: config.maxTokens ?? 8192,
            },
        });
        // Build content parts - include reference images if provided
        let contentParts;
        if (config.images && config.images.length > 0) {
            // Include reference images for image-to-image generation
            contentParts = [
                ...config.images.map((img) => ({
                    inlineData: {
                        mimeType: img.mediaType,
                        data: img.base64.startsWith('data:')
                            ? img.base64.split(',')[1]
                            : img.base64,
                    },
                })),
                { text: prompt },
            ];
        }
        else {
            contentParts = [{ text: prompt }];
        }
        const result = await generativeModel.generateContent(contentParts);
        const response = result.response;
        // Extract generated images and text from response
        const generatedImages = [];
        let textContent = '';
        for (const candidate of response.candidates || []) {
            for (const part of candidate.content?.parts || []) {
                if (part.text) {
                    textContent += part.text;
                }
                if (part.inlineData) {
                    generatedImages.push({
                        base64: part.inlineData.data,
                        mimeType: part.inlineData.mimeType || 'image/png',
                    });
                }
            }
        }
        return {
            success: true,
            content: textContent || `Generated ${generatedImages.length} image(s)`,
            model,
            generatedImages: generatedImages.length > 0 ? generatedImages : undefined,
        };
    }
    catch (error) {
        return {
            success: false,
            content: '',
            model,
            error: error.message || 'Google image generation API call failed',
        };
    }
}
// Mock implementation for testing
async function callMock(model, prompt, config) {
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
    // Check if this is an image generation request (mock-imagen model)
    if (model === 'mock-imagen') {
        // Generate a simple placeholder image as base64 (1x1 pink pixel as placeholder)
        const mockImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
        const numImages = config.numberOfImages || 1;
        const generatedImages = [];
        for (let i = 0; i < numImages; i++) {
            generatedImages.push({
                base64: mockImageBase64,
                mimeType: 'image/png',
            });
        }
        return {
            success: true,
            content: `Generated ${numImages} mock image(s) for testing. In production, this would use Google Imagen to generate real product images.`,
            model: 'mock-imagen',
            generatedImages,
        };
    }
    const mockResponses = {
        research: `## Product Research Results

### Product Category
Consumer Electronics > Smart Home Devices

### Key Features
- Voice-controlled operation
- Energy-efficient design
- Easy installation
- Mobile app integration

### Target Audience
- Tech-savvy homeowners aged 25-45
- Environmentally conscious consumers
- Busy professionals seeking convenience

### Competitor Analysis
1. **Competitor A** - Market leader with premium pricing
2. **Competitor B** - Budget-friendly option with limited features
3. **Competitor C** - Mid-range with strong brand recognition

### Price Range
$49.99 - $149.99 depending on features and bundle options`,
        listing: `## Amazon Product Listing

### Title
Premium Smart Home Device - Voice Controlled, Energy Efficient, Easy Setup | Works with Alexa & Google Home

### Bullet Points
• VOICE CONTROL - Simply speak to control your device hands-free
• ENERGY EFFICIENT - Save up to 30% on energy costs with smart scheduling
• EASY INSTALLATION - Set up in minutes with no tools required
• APP CONTROL - Monitor and control from anywhere using our free mobile app
• COMPATIBLE - Works seamlessly with Alexa, Google Home, and Apple HomeKit

### Description
Transform your home into a smart home with our premium device. Featuring advanced voice control technology and energy-efficient design, this device makes everyday tasks simpler and more convenient.`,
        image_analysis: `## Image Analysis Results

### Visual Elements
- Clean, modern design with minimalist aesthetics
- Primary colors: white, blue, and silver
- Professional product photography with soft lighting

### Style Characteristics
- Contemporary and sleek appearance
- High-end premium feel
- Emphasis on simplicity and functionality

### Recommendations
Based on the visual style:
1. Use similar lighting in future product shots
2. Maintain the minimalist color palette
3. Focus on the product's clean lines and modern design`,
        default: `## AI Generated Content

This is a mock response generated for testing purposes.

### Key Points
- Point 1: This is automatically generated content
- Point 2: Replace with actual AI integration for production
- Point 3: Useful for UI testing and development

### Summary
The mock AI service simulates the behavior of real AI providers, allowing for development and testing without incurring API costs.`,
    };
    // Determine which mock response to use based on prompt content and images
    let responseKey = 'default';
    if (config.images && config.images.length > 0) {
        responseKey = 'image_analysis';
    }
    else if (prompt.toLowerCase().includes('research')) {
        responseKey = 'research';
    }
    else if (prompt.toLowerCase().includes('listing') || prompt.toLowerCase().includes('amazon')) {
        responseKey = 'listing';
    }
    return {
        success: true,
        content: mockResponses[responseKey],
        model: 'mock',
        usage: {
            promptTokens: Math.floor(prompt.length / 4),
            completionTokens: Math.floor(mockResponses[responseKey].length / 4),
        },
    };
}
// Unified AI service interface
async function callAI(provider, model, prompt, config = {}) {
    // Check if this is an image generation model
    if (modelSupportsImageGeneration(model)) {
        return callGoogleImageGeneration(model, prompt, config);
    }
    switch (provider) {
        case 'openai':
            return callOpenAI(model, prompt, config);
        case 'anthropic':
            return callAnthropic(model, prompt, config);
        case 'google':
            return callGoogle(model, prompt, config);
        case 'mock':
            return callMock(model, prompt, config);
        default:
            return {
                success: false,
                content: '',
                model,
                error: `Unknown provider: ${provider}`,
            };
    }
}
// Helper to call AI by model ID (auto-detects provider)
async function callAIByModel(modelId, prompt, config = {}) {
    const provider = getProviderForModel(modelId);
    return callAI(provider, modelId, prompt, config);
}
// Check if API key is configured for a provider
function isProviderConfigured(provider) {
    switch (provider) {
        case 'openai':
            return !!process.env.OPENAI_API_KEY;
        case 'anthropic':
            return !!process.env.ANTHROPIC_API_KEY;
        case 'google':
            return !!process.env.GOOGLE_API_KEY;
        case 'mock':
            return true;
        default:
            return false;
    }
}
// Get available models (only those with configured API keys)
function getAvailableModels() {
    return types_1.AI_MODELS.filter(model => isProviderConfigured(model.provider));
}
// Check if a model supports vision
function modelSupportsVision(modelId) {
    const model = types_1.AI_MODELS.find(m => m.id === modelId);
    return model?.supportsVision ?? false;
}
// Check if a model supports image generation
function modelSupportsImageGeneration(modelId) {
    const model = types_1.AI_MODELS.find(m => m.id === modelId);
    return model?.supportsImageGeneration ?? false;
}
// Get model info
function getModelInfo(modelId) {
    return types_1.AI_MODELS.find(m => m.id === modelId);
}
//# sourceMappingURL=aiService.js.map
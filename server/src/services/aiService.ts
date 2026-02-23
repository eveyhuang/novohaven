import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProvider, AIResponse, AIServiceConfig, AI_MODELS, AIModelInfo, ImageData, GeneratedImage } from '../types';

// Initialize clients (lazy initialization)
let openaiClient: OpenAI | null = null;
let anthropicClient: Anthropic | null = null;
let googleClient: GoogleGenerativeAI | null = null;

function getAllKnownModels(): AIModelInfo[] {
  // Prefer plugin-provided models when available, with static fallback per provider.
  try {
    // Lazy require to avoid hard plugin dependency during early boot.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { pluginRegistry } = require('../plugins/registry') as { pluginRegistry: { getAllProviders: () => Map<string, any> } };
    const providers = pluginRegistry.getAllProviders();

    const pluginModels: AIModelInfo[] = [];
    for (const [, provider] of providers) {
      try {
        const listed = provider.listModels?.() || [];
        for (const model of listed) {
          const fallback = AI_MODELS.find((m) => m.id === model.id);
          const mappedProvider = String(model.provider || fallback?.provider || '').trim() as AIProvider;
          if (!mappedProvider) continue;
          pluginModels.push({
            id: String(model.id),
            name: String(model.name || model.id),
            provider: mappedProvider,
            maxTokens: Number(model.contextWindow || fallback?.maxTokens || 8192),
            supportsVision: fallback?.supportsVision,
            supportsImageGeneration: fallback?.supportsImageGeneration,
          });
        }
      } catch {
        // Ignore a broken provider and continue with others.
      }
    }

    if (pluginModels.length > 0) {
      const dedup = new Map<string, AIModelInfo>();
      for (const model of pluginModels) {
        dedup.set(model.id, model);
      }

      // Keep static fallback only for providers that have no plugin models loaded.
      const providersWithPluginModels = new Set(pluginModels.map((m) => m.provider));
      for (const model of AI_MODELS) {
        if (providersWithPluginModels.has(model.provider)) continue;
        if (!dedup.has(model.id)) dedup.set(model.id, model);
      }
      return Array.from(dedup.values());
    }
  } catch {
    // Fall back to static list below.
  }

  return AI_MODELS;
}

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is not set');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

function getGoogleClient(): GoogleGenerativeAI {
  if (!googleClient) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY environment variable is not set');
    }
    googleClient = new GoogleGenerativeAI(apiKey);
  }
  return googleClient;
}

function buildOpenAITokenParams(model: string, maxTokens: number): Record<string, number> {
  // GPT-5 class models reject max_tokens and require max_completion_tokens.
  if (/^gpt-5(?:$|[.-])/i.test(String(model || '').trim())) {
    return { max_completion_tokens: maxTokens };
  }
  return { max_tokens: maxTokens };
}

// Get provider for a model
export function getProviderForModel(modelId: string): AIProvider {
  const allModels = getAllKnownModels();
  const model = allModels.find(m => m.id === modelId);
  if (model) return model.provider;

  const lowered = String(modelId || '').toLowerCase();
  if (lowered.startsWith('gpt') || lowered.startsWith('o1') || lowered.startsWith('o3')) return 'openai';
  if (lowered.startsWith('claude')) return 'anthropic';
  if (lowered.startsWith('gemini')) return 'google';
  if (lowered.startsWith('mock')) return 'mock';

  throw new Error(`Unknown model: ${modelId}`);
}

// OpenAI implementation
async function callOpenAI(
  model: string,
  prompt: string,
  config: AIServiceConfig
): Promise<AIResponse> {
  try {
    const client = getOpenAIClient();

    // Build messages array
    let messages: OpenAI.Chat.ChatCompletionMessageParam[];

    if (config.messages && config.messages.length > 0) {
      // Multi-turn mode with optional system message
      messages = [];
      if (config.systemMessage) {
        messages.push({ role: 'system', content: config.systemMessage });
      }
      for (const msg of config.messages) {
        messages.push({ role: msg.role, content: msg.content });
      }
    } else {
      // Legacy single-prompt mode
      let messageContent: OpenAI.Chat.ChatCompletionContentPart[] | string;
      if (config.images && config.images.length > 0) {
        messageContent = [
          { type: 'text', text: prompt },
          ...config.images.map((img) => ({
            type: 'image_url' as const,
            image_url: {
              url: img.base64.startsWith('data:')
                ? img.base64
                : `data:${img.mediaType};base64,${img.base64}`,
            },
          })),
        ];
      } else {
        messageContent = prompt;
      }
      messages = [{ role: 'user', content: messageContent }];
    }

    const requestBody: any = {
      model,
      messages,
      temperature: config.temperature ?? 0.7,
      ...buildOpenAITokenParams(model, config.maxTokens ?? 2000),
      top_p: config.topP ?? 1,
    };
    const response = await client.chat.completions.create(requestBody);

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
  } catch (error: any) {
    return {
      success: false,
      content: '',
      model,
      error: error.message || 'OpenAI API call failed',
    };
  }
}

// Anthropic implementation
async function callAnthropic(
  model: string,
  prompt: string,
  config: AIServiceConfig
): Promise<AIResponse> {
  try {
    const client = getAnthropicClient();

    // Build messages array
    let apiMessages: Anthropic.MessageParam[];

    if (config.messages && config.messages.length > 0) {
      // Multi-turn mode
      apiMessages = config.messages.map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));
    } else {
      // Legacy single-prompt mode
      let messageContent: Anthropic.MessageParam['content'];
      if (config.images && config.images.length > 0) {
        messageContent = [
          ...config.images.map((img) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType,
              data: img.base64.startsWith('data:')
                ? img.base64.split(',')[1]
                : img.base64,
            },
          })),
          { type: 'text' as const, text: prompt },
        ];
      } else {
        messageContent = prompt;
      }
      apiMessages = [{ role: 'user', content: messageContent }];
    }

    const response = await client.messages.create({
      model,
      max_tokens: config.maxTokens ?? 2000,
      ...(config.systemMessage ? { system: config.systemMessage } : {}),
      messages: apiMessages,
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
  } catch (error: any) {
    return {
      success: false,
      content: '',
      model,
      error: error.message || 'Anthropic API call failed',
    };
  }
}

// Google Gemini implementation
async function callGoogle(
  model: string,
  prompt: string,
  config: AIServiceConfig
): Promise<AIResponse> {
  try {
    const client = getGoogleClient();
    const modelOptions: any = {
      model,
      generationConfig: {
        temperature: config.temperature ?? 0.7,
        maxOutputTokens: config.maxTokens ?? 2000,
        topP: config.topP ?? 1,
      },
    };
    if (config.systemMessage) {
      modelOptions.systemInstruction = { parts: [{ text: config.systemMessage }] };
    }
    const generativeModel = client.getGenerativeModel(modelOptions);

    let content: string;

    if (config.messages && config.messages.length > 0) {
      // Multi-turn mode using chat.
      // Gemini requires valid role ordering, so merge consecutive same-role turns
      // and ensure the next message sent is always from user role.
      const collapsed: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
      for (const msg of config.messages) {
        const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
        const text = String(msg.content ?? '').trim();
        if (!text) continue;

        if (collapsed.length === 0 && role === 'model') {
          // Drop orphan assistant/model turns at the beginning.
          continue;
        }

        const prev = collapsed[collapsed.length - 1];
        if (prev && prev.role === role) {
          prev.parts[0].text = `${prev.parts[0].text}\n\n${text}`;
        } else {
          collapsed.push({ role, parts: [{ text }] });
        }
      }

      let lastUserMessage = String(prompt || '').trim();
      let history = collapsed;
      const lastTurn = collapsed[collapsed.length - 1];
      if (lastTurn?.role === 'user') {
        lastUserMessage = lastTurn.parts[0].text;
        history = collapsed.slice(0, -1);
      } else if (!lastUserMessage) {
        lastUserMessage = 'Continue.';
      }

      const chat = generativeModel.startChat({ history });
      const result = await chat.sendMessage(lastUserMessage);
      content = result.response.text();
    } else {
      // Legacy single-prompt mode
      let contentParts: any[];
      if (config.images && config.images.length > 0) {
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
      } else {
        contentParts = [{ text: prompt }];
      }
      const result = await generativeModel.generateContent(contentParts);
      content = result.response.text();
    }

    return {
      success: true,
      content,
      model,
      usage: {
        promptTokens: 0, // Gemini doesn't provide token counts in the same way
        completionTokens: 0,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      content: '',
      model,
      error: error.message || 'Google Gemini API call failed',
    };
  }
}

// Google Gemini Image Generation implementation
async function callGoogleImageGeneration(
  model: string,
  prompt: string,
  config: AIServiceConfig
): Promise<AIResponse> {
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
    let contentParts: any[];

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
    } else {
      contentParts = [{ text: prompt }];
    }

    const result = await generativeModel.generateContent(contentParts);
    const response = result.response;

    // Extract generated images and text from response
    const generatedImages: GeneratedImage[] = [];
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
  } catch (error: any) {
    return {
      success: false,
      content: '',
      model,
      error: error.message || 'Google image generation API call failed',
    };
  }
}

// Mock implementation for testing
async function callMock(
  model: string,
  prompt: string,
  config: AIServiceConfig
): Promise<AIResponse> {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));

  // Check if this is an image generation request (mock-imagen model)
  if (model === 'mock-imagen') {
    // Generate a simple placeholder image as base64 (1x1 pink pixel as placeholder)
    const mockImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
    const numImages = config.numberOfImages || 1;
    const generatedImages: GeneratedImage[] = [];

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

  const mockResponses: Record<string, string> = {
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
  } else if (prompt.toLowerCase().includes('research')) {
    responseKey = 'research';
  } else if (prompt.toLowerCase().includes('listing') || prompt.toLowerCase().includes('amazon')) {
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

function isRetriableError(provider: AIProvider, errorMessage?: string): boolean {
  if (!errorMessage) return false;
  if (provider === 'mock') return false;

  const text = errorMessage.toLowerCase();
  return (
    text.includes('overloaded_error') ||
    text.includes('overloaded') ||
    text.includes('rate limit') ||
    text.includes('too many requests') ||
    text.includes('temporarily unavailable') ||
    text.includes('resource exhausted') ||
    text.includes('deadline exceeded') ||
    text.includes('timeout') ||
    /\b429\b/.test(text) ||
    /\b529\b/.test(text) ||
    /\b503\b/.test(text)
  );
}

function getRetryAttempts(provider: AIProvider): number {
  if (provider === 'anthropic') return 3;
  if (provider === 'openai' || provider === 'google') return 2;
  return 1;
}

function retryDelayMs(attempt: number): number {
  const base = 600 * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(5000, base + jitter);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Unified AI service interface
export async function callAI(
  provider: AIProvider,
  model: string,
  prompt: string,
  config: AIServiceConfig = {}
): Promise<AIResponse> {
  const runOnce = async (): Promise<AIResponse> => {
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
  };

  const attempts = getRetryAttempts(provider);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await runOnce();
    if (response.success) {
      return response;
    }

    if (attempt < attempts && isRetriableError(provider, response.error)) {
      const delay = retryDelayMs(attempt);
      console.warn(
        `[AIService] Retrying transient ${provider} error for model ${model} ` +
        `(attempt ${attempt}/${attempts}) after ${delay}ms: ${response.error}`
      );
      await sleep(delay);
      continue;
    }

    if (isRetriableError(provider, response.error)) {
      return {
        ...response,
        error: `${response.error} (provider temporarily overloaded; please retry in a moment)`,
      };
    }

    return response;
  }

  return {
    success: false,
    content: '',
    model,
    error: 'AI request failed after retry attempts',
  };
}

// Helper to call AI by model ID (auto-detects provider)
export async function callAIByModel(
  modelId: string,
  prompt: string,
  config: AIServiceConfig = {}
): Promise<AIResponse> {
  const provider = getProviderForModel(modelId);
  return callAI(provider, modelId, prompt, config);
}

// Check if API key is configured for a provider
export function isProviderConfigured(provider: AIProvider): boolean {
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
export function getAvailableModels() {
  return getAllKnownModels().filter(model => isProviderConfigured(model.provider));
}

export function getAllModels() {
  return getAllKnownModels();
}

// Check if a model supports vision
export function modelSupportsVision(modelId: string): boolean {
  const model = getAllKnownModels().find(m => m.id === modelId);
  return model?.supportsVision ?? false;
}

// Check if a model supports image generation
export function modelSupportsImageGeneration(modelId: string): boolean {
  const model = getAllKnownModels().find(m => m.id === modelId);
  return model?.supportsImageGeneration ?? false;
}

// Get model info
export function getModelInfo(modelId: string) {
  return getAllKnownModels().find(m => m.id === modelId);
}

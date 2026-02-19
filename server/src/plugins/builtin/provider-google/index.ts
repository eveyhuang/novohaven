import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  ProviderPlugin, PluginManifest, ModelInfo,
  CompletionRequest, StreamEvent
} from '../../types';

class GoogleProvider implements ProviderPlugin {
  manifest: PluginManifest;
  private client: GoogleGenerativeAI | null = null;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    const apiKey = config.apiKey || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      console.warn('[provider-google] No API key configured, plugin will not be functional');
      return;
    }
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async shutdown(): Promise<void> {
    this.client = null;
  }

  listModels(): ModelInfo[] {
    return [
      {
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        provider: 'google',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 1000000,
      },
      {
        id: 'gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash Lite',
        provider: 'google',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 1000000,
      },
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        provider: 'google',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 1000000,
      },
      {
        id: 'gemini-3-pro-image-preview',
        name: 'Gemini 3 Pro Image',
        provider: 'google',
        supportsStreaming: true,
        supportsTools: false,
        contextWindow: 1000000,
      },
    ];
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    if (!this.client) {
      yield { type: 'error', error: 'Google client not initialized (missing API key)' };
      return;
    }

    try {
      const modelOptions: any = {
        model: request.model,
        generationConfig: {
          maxOutputTokens: request.maxTokens ?? 4096,
          ...(request.temperature != null ? { temperature: request.temperature } : {}),
        },
      };

      if (request.systemPrompt) {
        modelOptions.systemInstruction = { parts: [{ text: request.systemPrompt }] };
      }

      // Build tools for Gemini function calling
      if (request.tools && request.tools.length > 0) {
        modelOptions.tools = [{
          functionDeclarations: request.tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        }];
      }

      const model = this.client.getGenerativeModel(modelOptions);

      // Build chat history (all messages except last)
      const history = request.messages.slice(0, -1).map(msg => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      }));

      const lastMessage = request.messages[request.messages.length - 1];
      if (!lastMessage) {
        yield { type: 'error', error: 'No messages provided' };
        return;
      }

      const chat = model.startChat({ history });

      // Build message parts (text + optional images)
      const messageParts: any[] = [{ text: lastMessage.content }];
      if (lastMessage.attachments?.length) {
        for (const a of lastMessage.attachments) {
          messageParts.push({
            inlineData: { mimeType: a.mimeType, data: a.data },
          });
        }
      }

      const result = await chat.sendMessageStream(messageParts);

      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          yield { type: 'text', text };
        }

        // Check for function calls
        const candidates = chunk.candidates || [];
        for (const candidate of candidates) {
          for (const part of candidate.content?.parts || []) {
            if ((part as any).functionCall) {
              const fc = (part as any).functionCall;
              yield {
                type: 'tool_call',
                toolCall: {
                  id: `google-fc-${Date.now()}`,
                  name: fc.name,
                  args: fc.args || {},
                },
              };
            }
          }
        }
      }

      yield { type: 'done' };
    } catch (err: any) {
      yield { type: 'error', error: err.message || 'Google Gemini streaming failed' };
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      throw new Error('Google client not initialized (missing API key)');
    }

    const model = this.client.getGenerativeModel({ model: 'text-embedding-004' });
    const results: number[][] = [];

    // Gemini embeddings API processes one text at a time
    for (const text of texts) {
      const result = await model.embedContent(text);
      results.push(result.embedding.values);
    }

    return results;
  }
}

export default GoogleProvider;

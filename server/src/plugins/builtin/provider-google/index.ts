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
        id: 'gemini-3-pro-preview',
        name: 'Gemini 3 Pro',
        provider: 'google',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 1000000,
      },
      {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider: 'google',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 1000000,
      },
      {
        id: 'gemini-3-pro-image-preview',
        name: 'Nanobanana',
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

    const toolLoopError = this.validateToolLoop(request);
    if (toolLoopError) {
      yield { type: 'error', error: toolLoopError };
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
      const contents = this.buildContents(request.messages);
      if (contents.length === 0) {
        yield { type: 'error', error: 'No messages provided' };
        return;
      }

      const result = await model.generateContentStream({ contents });
      let toolCallCount = 0;

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
                  id: fc.id || `google-fc-${++toolCallCount}`,
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

  private buildContents(messages: CompletionRequest['messages']): Array<{ role: 'user' | 'model'; parts: any[] }> {
    const toolNameById = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          toolNameById.set(tc.id, tc.name);
        }
      }
    }

    const contents: Array<{ role: 'user' | 'model'; parts: any[] }> = [];

    const pushParts = (role: 'user' | 'model', parts: any[]) => {
      if (parts.length === 0) return;
      const prev = contents[contents.length - 1];
      if (prev && prev.role === role) {
        prev.parts.push(...parts);
      } else {
        contents.push({ role, parts });
      }
    };

    for (const msg of messages) {
      if (msg.role === 'system') continue;

      const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
      const parts: any[] = [];

      if (msg.role === 'tool') {
        const toolName = msg.toolCallId ? toolNameById.get(msg.toolCallId) : undefined;
        if (toolName) {
          let resultPayload: any = msg.content;
          try {
            resultPayload = JSON.parse(msg.content);
          } catch {
            // Keep raw string if tool output is plain text.
          }
          parts.push({
            functionResponse: {
              name: toolName,
              response: {
                name: toolName,
                content: resultPayload,
              },
            },
          });
        } else {
          parts.push({ text: msg.content || '' });
        }
      } else {
        if (msg.content) {
          parts.push({ text: msg.content });
        }

        if (msg.role === 'user' && msg.attachments?.length) {
          for (const a of msg.attachments) {
            parts.push({
              inlineData: { mimeType: a.mimeType, data: a.data },
            });
          }
        }

        if (msg.role === 'assistant' && msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.args || {},
              },
            });
          }
        }
      }

      if (parts.length === 0) {
        parts.push({ text: '' });
      }

      pushParts(role, parts);
    }

    return contents;
  }

  private validateToolLoop(request: CompletionRequest): string | null {
    const declaredToolCalls = new Set<string>();

    for (const msg of request.messages) {
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          if (!tc.id || !tc.name) {
            return 'Invalid assistant tool call: each tool call must include both id and name.';
          }
          declaredToolCalls.add(tc.id);
        }
      }

      if (msg.role === 'tool') {
        if (!msg.toolCallId) {
          return 'Invalid tool message: toolCallId is required for tool result messages.';
        }
        if (!declaredToolCalls.has(msg.toolCallId)) {
          return `Invalid tool message: toolCallId "${msg.toolCallId}" was not declared by a prior assistant tool call.`;
        }
      }
    }

    return null;
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

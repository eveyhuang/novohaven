import OpenAI from 'openai';
import {
  ProviderPlugin, PluginManifest, ModelInfo,
  CompletionRequest, StreamEvent
} from '../../types';

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

class KimiProvider implements ProviderPlugin {
  manifest: PluginManifest;
  private client: OpenAI | null = null;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    const apiKey = config.apiKey || process.env.MOONSHOT_API_KEY;
    if (!apiKey) {
      console.warn('[provider-kimi] No API key configured, plugin will not be functional');
      return;
    }
    const baseURL = config.baseUrl || process.env.MOONSHOT_API_BASE || DEFAULT_BASE_URL;
    this.client = new OpenAI({ apiKey, baseURL });
    console.log(`[provider-kimi] Initialized with base URL: ${baseURL}`);
  }

  async shutdown(): Promise<void> {
    this.client = null;
  }

  listModels(): ModelInfo[] {
    return [
      {
        id: 'kimi-k2-0711-chat',
        name: 'Kimi K2 Chat',
        provider: 'kimi',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 256000,
      },
      {
        id: 'moonshot-v1-128k',
        name: 'Moonshot v1 128K',
        provider: 'kimi',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 128000,
      },
      {
        id: 'moonshot-v1-32k',
        name: 'Moonshot v1 32K',
        provider: 'kimi',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 32000,
      },
      {
        id: 'moonshot-v1-8k',
        name: 'Moonshot v1 8K',
        provider: 'kimi',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 8000,
      },
    ];
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    if (!this.client) {
      yield { type: 'error', error: 'Kimi client not initialized (missing API key)' };
      return;
    }

    const toolLoopError = this.validateToolLoop(request);
    if (toolLoopError) {
      yield { type: 'error', error: toolLoopError };
      return;
    }

    // Build messages
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }

    for (const msg of request.messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        messages.push({
          role: 'tool',
          content: msg.content,
          tool_call_id: msg.toolCallId,
        });
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
        messages.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args || {}),
            },
          })),
        } as any);
      } else if (msg.role === 'user' && msg.attachments?.length) {
        // Multimodal message with images
        const contentParts: OpenAI.Chat.ChatCompletionContentPart[] = [
          { type: 'text', text: msg.content },
          ...msg.attachments.map(a => ({
            type: 'image_url' as const,
            image_url: { url: `data:${a.mimeType};base64,${a.data}` },
          })),
        ];
        messages.push({ role: 'user', content: contentParts });
      } else {
        messages.push({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content,
        });
      }
    }

    // Build tools
    const tools: OpenAI.Chat.ChatCompletionTool[] | undefined = request.tools?.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    // Moonshot clamps temperature to [0, 1]
    let temperature = request.temperature;
    if (temperature != null && temperature > 1) {
      temperature = 1;
    }

    try {
      const stream = await this.client.chat.completions.create({
        model: request.model,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        ...(temperature != null ? { temperature } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        stream: true,
      });

      // Track tool calls being assembled across deltas
      const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();
      let doneEmitted = false;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta || {};

        // Text content
        if (delta.content) {
          yield { type: 'text', text: delta.content };
        }

        // Tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallAccum.has(idx)) {
              toolCallAccum.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' });
            }
            const accum = toolCallAccum.get(idx)!;
            if (tc.id) accum.id = tc.id;
            if (tc.function?.name) accum.name = tc.function.name;
            if (tc.function?.arguments) accum.args += tc.function.arguments;
          }
        }

        // Check for finish
        if (choice.finish_reason) {
          // Emit any accumulated tool calls
          for (const [, tc] of toolCallAccum) {
            let args: Record<string, any> = {};
            if (tc.args && tc.args.trim().length > 0) {
              try {
                args = JSON.parse(tc.args);
              } catch {
                yield { type: 'error', error: `Kimi returned invalid JSON arguments for tool "${tc.name || tc.id}"` };
                return;
              }
            }
            yield {
              type: 'tool_call',
              toolCall: { id: tc.id, name: tc.name, args },
            };
          }
          doneEmitted = true;
          yield { type: 'done' };
          break;
        }
      }
      if (!doneEmitted) {
        yield { type: 'done' };
      }
    } catch (err: any) {
      yield { type: 'error', error: err.message || 'Kimi streaming failed' };
    }
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
}

export default KimiProvider;

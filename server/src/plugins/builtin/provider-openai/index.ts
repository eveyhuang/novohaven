import OpenAI from 'openai';
import {
  ProviderPlugin, PluginManifest, ModelInfo,
  CompletionRequest, StreamEvent
} from '../../types';

class OpenAIProvider implements ProviderPlugin {
  manifest: PluginManifest;
  private client: OpenAI | null = null;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.warn('[provider-openai] No API key configured, plugin will not be functional');
      return;
    }
    this.client = new OpenAI({ apiKey });
  }

  async shutdown(): Promise<void> {
    this.client = null;
  }

  listModels(): ModelInfo[] {
    return [
      {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        provider: 'openai',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 128000,
      },
      {
        id: 'gpt-5',
        name: 'GPT-5',
        provider: 'openai',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 8192,
      },
    ];
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    if (!this.client) {
      yield { type: 'error', error: 'OpenAI client not initialized (missing API key)' };
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

    try {
      const requestBody: any = {
        model: request.model,
        messages,
        ...this.buildTokenParams(request.model, request.maxTokens ?? 4096),
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        stream: true,
      };
      const stream: any = await this.client.chat.completions.create(requestBody as any);

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
                yield { type: 'error', error: `OpenAI returned invalid JSON arguments for tool "${tc.name || tc.id}"` };
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
      yield { type: 'error', error: err.message || 'OpenAI streaming failed' };
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.client) {
      throw new Error('OpenAI client not initialized (missing API key)');
    }

    const response = await this.client.embeddings.create({
      model: 'text-embedding-3-small',
      input: texts,
    });

    return response.data.map(d => d.embedding);
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

  private buildTokenParams(model: string, maxTokens: number): Record<string, number> {
    // GPT-5 class models reject max_tokens and require max_completion_tokens.
    if (this.requiresMaxCompletionTokens(model)) {
      return { max_completion_tokens: maxTokens };
    }
    return { max_tokens: maxTokens };
  }

  private requiresMaxCompletionTokens(model: string): boolean {
    return /^gpt-5(?:$|[.-])/i.test(String(model || '').trim());
  }
}

export default OpenAIProvider;

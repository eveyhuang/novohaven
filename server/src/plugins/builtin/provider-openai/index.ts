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
        id: 'gpt-4o',
        name: 'GPT-4o',
        provider: 'openai',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 128000,
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        provider: 'openai',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 128000,
      },
      {
        id: 'gpt-4',
        name: 'GPT-4',
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
      const stream = await this.client.chat.completions.create({
        model: request.model,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        stream: true,
      });

      // Track tool calls being assembled across deltas
      const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

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
        if (chunk.choices[0]?.finish_reason) {
          // Emit any accumulated tool calls
          for (const [, tc] of toolCallAccum) {
            let args: Record<string, any> = {};
            try { args = JSON.parse(tc.args); } catch {}
            yield {
              type: 'tool_call',
              toolCall: { id: tc.id, name: tc.name, args },
            };
          }
          yield { type: 'done' };
        }
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
}

export default OpenAIProvider;

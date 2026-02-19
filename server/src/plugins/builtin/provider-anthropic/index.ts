import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderPlugin, PluginManifest, ModelInfo,
  CompletionRequest, StreamEvent
} from '../../types';

class AnthropicProvider implements ProviderPlugin {
  manifest: PluginManifest;
  private client: Anthropic | null = null;

  constructor(manifest: PluginManifest) {
    this.manifest = manifest;
  }

  async initialize(config: Record<string, any>): Promise<void> {
    const apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('[provider-anthropic] No API key configured, plugin will not be functional');
      return;
    }
    this.client = new Anthropic({ apiKey });
  }

  async shutdown(): Promise<void> {
    this.client = null;
  }

  listModels(): ModelInfo[] {
    return [
      {
        id: 'claude-opus-4-6',
        name: 'Claude 4.6 Opus',
        provider: 'anthropic',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 200000,
      },
      {
        id: 'claude-sonnet-4-5-20250929',
        name: 'Claude Sonnet 4.5',
        provider: 'anthropic',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 200000,
      },
      {
        id: 'claude-haiku-4-5-20251001',
        name: 'Claude Haiku 4.5',
        provider: 'anthropic',
        supportsStreaming: true,
        supportsTools: true,
        contextWindow: 200000,
      },
    ];
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    if (!this.client) {
      yield { type: 'error', error: 'Anthropic client not initialized (missing API key)' };
      return;
    }

    // Build Anthropic messages (with optional image support)
    const messages: Anthropic.MessageParam[] = request.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => {
        if (m.role === 'user' && m.attachments?.length) {
          const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [
            { type: 'text', text: m.content },
            ...m.attachments.map(a => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: a.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: a.data,
              },
            })),
          ];
          return { role: 'user' as const, content };
        }
        return { role: m.role as 'user' | 'assistant', content: m.content };
      });

    // Build tools if provided
    const tools: Anthropic.Tool[] | undefined = request.tools?.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    try {
      const stream = this.client.messages.stream({
        model: request.model,
        max_tokens: request.maxTokens ?? 4096,
        ...(request.temperature != null ? { temperature: request.temperature } : {}),
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          const delta = event.delta as any;
          if (delta.type === 'text_delta') {
            yield { type: 'text', text: delta.text };
          } else if (delta.type === 'input_json_delta') {
            // Tool call arguments streaming — accumulate, will emit on content_block_stop
          }
        } else if (event.type === 'content_block_start') {
          const block = event.content_block as any;
          if (block.type === 'tool_use') {
            // We'll emit the full tool call when the block stops
          }
        } else if (event.type === 'content_block_stop') {
          // Check if the completed block was a tool_use
          const finalMessage = stream.currentMessage;
          if (finalMessage) {
            const block = finalMessage.content[event.index];
            if (block && block.type === 'tool_use') {
              yield {
                type: 'tool_call',
                toolCall: {
                  id: block.id,
                  name: block.name,
                  args: block.input as Record<string, any>,
                },
              };
            }
          }
        } else if (event.type === 'message_stop') {
          yield { type: 'done' };
        }
      }
    } catch (err: any) {
      yield { type: 'error', error: err.message || 'Anthropic streaming failed' };
    }
  }

  // Anthropic doesn't offer embeddings
}

export default AnthropicProvider;

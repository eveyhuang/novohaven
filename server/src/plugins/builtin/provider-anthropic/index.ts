import Anthropic from '@anthropic-ai/sdk';
import {
  ProviderPlugin, PluginManifest, ModelInfo,
  CompletionRequest, StreamEvent
} from '../../types';

class AnthropicProvider implements ProviderPlugin {
  manifest: PluginManifest;
  private client: Anthropic | null = null;
  private static readonly MAX_IMAGE_BYTES = 5 * 1024 * 1024; // Anthropic image block limit

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

    const toolLoopError = this.validateToolLoop(request);
    if (toolLoopError) {
      yield { type: 'error', error: toolLoopError };
      return;
    }

    // Build Anthropic messages.
    // Anthropic does not support a "tool" role directly; tool results must be sent
    // as user content blocks of type "tool_result".
    const messages: Anthropic.MessageParam[] = [];
    let pendingToolResults: any[] = [];

    const flushToolResults = () => {
      if (pendingToolResults.length === 0) return;
      messages.push({
        role: 'user',
        content: pendingToolResults,
      } as Anthropic.MessageParam);
      pendingToolResults = [];
    };

    for (const m of request.messages) {
      if (m.role === 'tool') {
        const toolUseId = m.toolCallId;
        if (!toolUseId) {
          yield { type: 'error', error: 'Invalid tool message: toolCallId is required for Anthropic tool results.' };
          return;
        }
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: m.content || '',
          is_error: /^tool error:/i.test(m.content || ''),
        });
        continue;
      }

      flushToolResults();

      if (m.role === 'user') {
        if (m.attachments?.length) {
          for (let i = 0; i < m.attachments.length; i++) {
            const attachment = m.attachments[i];
            const imageBytes = this.estimateImageBytes(attachment.data);
            if (imageBytes > AnthropicProvider.MAX_IMAGE_BYTES) {
              yield {
                type: 'error',
                error: `Image #${i + 1} is too large for Anthropic (${imageBytes} bytes). Please upload an image smaller than 5 MB.`,
              };
              return;
            }
          }
          const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [
            { type: 'text', text: m.content || 'Analyze this image.' },
            ...m.attachments.map(a => ({
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: a.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: a.data,
              },
            })),
          ];
          messages.push({ role: 'user', content });
        } else {
          messages.push({ role: 'user', content: m.content });
        }
      } else if (m.role === 'assistant') {
        if (m.toolCalls?.length) {
          const contentBlocks: any[] = [];
          if (m.content) {
            contentBlocks.push({ type: 'text', text: m.content });
          }
          for (const tc of m.toolCalls) {
            contentBlocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.args || {},
            });
          }
          messages.push({ role: 'assistant', content: contentBlocks } as Anthropic.MessageParam);
        } else {
          messages.push({ role: 'assistant', content: m.content });
        }
      }
    }

    flushToolResults();

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

  private estimateImageBytes(raw: string): number {
    const value = String(raw || '');
    const payload = value.startsWith('data:image/')
      ? value.slice(value.indexOf(',') + 1)
      : value;
    try {
      return Buffer.byteLength(payload, 'base64');
    } catch {
      return 0;
    }
  }

  // Anthropic doesn't offer embeddings
}

export default AnthropicProvider;

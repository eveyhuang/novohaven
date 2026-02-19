import AnthropicProvider from '../../plugins/builtin/provider-anthropic';
import { CompletionRequest, StreamEvent } from '../../plugins/types';

function makeAsyncStream(events: any[], extra: Record<string, any> = {}): any {
  return {
    ...extra,
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

async function collect(provider: AnthropicProvider, request: CompletionRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of provider.stream(request)) {
    out.push(event);
  }
  return out;
}

describe('Anthropic Provider Conformance', () => {
  const manifest: any = {
    name: 'provider-anthropic',
    version: '1.0.0',
    type: 'provider',
    displayName: 'Anthropic',
    description: 'test',
    entry: './index.ts',
  };

  test('maps assistant tool_use + tool_result history and emits tool_call from stream', async () => {
    const provider = new AnthropicProvider(manifest);
    const streamFn = jest.fn();

    const currentMessage = {
      content: [
        {
          type: 'tool_use',
          id: 'tc-next',
          name: 'skill_execute',
          input: { skillId: 3 },
        },
      ],
    };

    streamFn.mockReturnValue(
      makeAsyncStream(
        [
          { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking...' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_stop' },
        ],
        { currentMessage }
      )
    );

    (provider as any).client = {
      messages: {
        stream: streamFn,
      },
    };

    const request: CompletionRequest = {
      model: 'claude-sonnet-4-5-20250929',
      systemPrompt: 'You are an assistant',
      tools: [
        {
          name: 'skill_execute',
          description: 'Run a skill',
          parameters: { type: 'object', properties: { skillId: { type: 'number' } } },
        },
      ],
      messages: [
        { role: 'user', content: 'Run my analyzer' },
        {
          role: 'assistant',
          content: 'Looking up candidates',
          toolCalls: [{ id: 'tc-prev', name: 'skill_search', args: { query: 'analyzer' } }],
        },
        { role: 'tool', content: 'Found skill #3', toolCallId: 'tc-prev' },
      ],
    };

    const events = await collect(provider, request);

    expect(events).toEqual([
      { type: 'text', text: 'Checking...' },
      { type: 'tool_call', toolCall: { id: 'tc-next', name: 'skill_execute', args: { skillId: 3 } } },
      { type: 'done' },
    ]);

    expect(streamFn).toHaveBeenCalledTimes(1);
    const payload = streamFn.mock.calls[0][0];
    expect(payload.system).toBe('You are an assistant');
    expect(payload.messages).toHaveLength(3);
    expect(payload.messages[0]).toEqual({ role: 'user', content: 'Run my analyzer' });
    expect(payload.messages[1].role).toBe('assistant');
    expect(payload.messages[1].content[0]).toEqual({ type: 'text', text: 'Looking up candidates' });
    expect(payload.messages[1].content[1]).toEqual({
      type: 'tool_use',
      id: 'tc-prev',
      name: 'skill_search',
      input: { query: 'analyzer' },
    });
    expect(payload.messages[2].role).toBe('user');
    expect(payload.messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tc-prev',
      content: 'Found skill #3',
      is_error: false,
    });
    expect(payload.tools[0].name).toBe('skill_execute');
  });

  test('returns conformance error when tool message lacks toolCallId', async () => {
    const provider = new AnthropicProvider(manifest);
    const streamFn = jest.fn();
    (provider as any).client = { messages: { stream: streamFn } };

    const request: CompletionRequest = {
      model: 'claude-sonnet-4-5-20250929',
      messages: [
        { role: 'assistant', content: 'Calling tool', toolCalls: [{ id: 'tc1', name: 'skill_search', args: {} }] },
        { role: 'tool', content: 'tool output' },
      ],
    };

    const events = await collect(provider, request);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error).toMatch(/toolCallId is required/i);
    expect(streamFn).not.toHaveBeenCalled();
  });
});

import KimiProvider from '../../plugins/builtin/provider-kimi';
import { CompletionRequest, StreamEvent } from '../../plugins/types';

function makeAsyncStream(events: any[]): any {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

async function collect(provider: KimiProvider, request: CompletionRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of provider.stream(request)) {
    out.push(event);
  }
  return out;
}

describe('Kimi Provider Conformance', () => {
  const manifest: any = {
    name: 'provider-kimi',
    version: '1.0.0',
    type: 'provider',
    displayName: 'Kimi',
    description: 'test',
    entry: './index.ts',
  };

  test('serializes tool loop messages and clamps temperature', async () => {
    const provider = new KimiProvider(manifest);
    const createFn = jest.fn();

    createFn.mockResolvedValue(
      makeAsyncStream([
        { choices: [{ delta: { content: 'Planning...' }, finish_reason: null }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'tc-next', function: { name: 'skill_execute', arguments: '{"skillId":7}' } }],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ finish_reason: 'tool_calls' }] },
      ])
    );

    (provider as any).client = {
      chat: { completions: { create: createFn } },
    };

    const request: CompletionRequest = {
      model: 'kimi-k2-0711-chat',
      temperature: 1.8,
      tools: [
        {
          name: 'skill_execute',
          description: 'Run skill',
          parameters: { type: 'object', properties: { skillId: { type: 'number' } } },
        },
      ],
      messages: [
        {
          role: 'assistant',
          content: 'Looking up',
          toolCalls: [{ id: 'tc-prev', name: 'skill_search', args: { query: 'style analyzer' } }],
        },
        { role: 'tool', content: 'Found skill #7', toolCallId: 'tc-prev' },
        { role: 'user', content: 'Proceed' },
      ],
    };

    const events = await collect(provider, request);
    expect(events).toEqual([
      { type: 'text', text: 'Planning...' },
      { type: 'tool_call', toolCall: { id: 'tc-next', name: 'skill_execute', args: { skillId: 7 } } },
      { type: 'done' },
    ]);

    const payload = createFn.mock.calls[0][0];
    expect(payload.temperature).toBe(1);
    expect(payload.messages[0]).toEqual({
      role: 'assistant',
      content: 'Looking up',
      tool_calls: [
        {
          id: 'tc-prev',
          type: 'function',
          function: { name: 'skill_search', arguments: '{"query":"style analyzer"}' },
        },
      ],
    });
    expect(payload.messages[1]).toEqual({ role: 'tool', content: 'Found skill #7', tool_call_id: 'tc-prev' });
  });

  test('returns conformance error when tool message does not match prior assistant call', async () => {
    const provider = new KimiProvider(manifest);
    const createFn = jest.fn();
    (provider as any).client = { chat: { completions: { create: createFn } } };

    const request: CompletionRequest = {
      model: 'kimi-k2-0711-chat',
      messages: [
        { role: 'assistant', content: 'call', toolCalls: [{ id: 'tc-good', name: 'skill_search', args: {} }] },
        { role: 'tool', content: 'bad reference', toolCallId: 'tc-missing' },
      ],
    };

    const events = await collect(provider, request);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error).toMatch(/was not declared/i);
    expect(createFn).not.toHaveBeenCalled();
  });
});

import OpenAIProvider from '../../plugins/builtin/provider-openai';
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

async function collect(provider: OpenAIProvider, request: CompletionRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of provider.stream(request)) {
    out.push(event);
  }
  return out;
}

describe('OpenAI Provider Conformance', () => {
  const manifest: any = {
    name: 'provider-openai',
    version: '1.0.0',
    type: 'provider',
    displayName: 'OpenAI',
    description: 'test',
    entry: './index.ts',
  };

  test('serializes prior assistant tool calls/results and parses streamed tool calls', async () => {
    const provider = new OpenAIProvider(manifest);
    const createFn = jest.fn();

    createFn.mockResolvedValue(
      makeAsyncStream([
        { choices: [{ delta: { content: 'Working...' }, finish_reason: null }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'tc-next', function: { name: 'skill_execute', arguments: '{"skillId":1' } }],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: ',"inputs":{"review_data":"file.csv"}}' } }],
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
      model: 'gpt-4o',
      systemPrompt: 'System',
      tools: [
        {
          name: 'skill_execute',
          description: 'Run skill',
          parameters: { type: 'object', properties: { skillId: { type: 'number' } } },
        },
      ],
      messages: [
        {
          role: 'user',
          content: 'Run Product Review Analyzer',
          attachments: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }],
        },
        {
          role: 'assistant',
          content: 'Searching skill',
          toolCalls: [{ id: 'tc-prev', name: 'skill_search', args: { query: 'product review' } }],
        },
        { role: 'tool', content: 'Found skill #3', toolCallId: 'tc-prev' },
      ],
    };

    const events = await collect(provider, request);
    expect(events).toEqual([
      { type: 'text', text: 'Working...' },
      {
        type: 'tool_call',
        toolCall: {
          id: 'tc-next',
          name: 'skill_execute',
          args: { skillId: 1, inputs: { review_data: 'file.csv' } },
        },
      },
      { type: 'done' },
    ]);

    expect(createFn).toHaveBeenCalledTimes(1);
    const payload = createFn.mock.calls[0][0];
    expect(payload.model).toBe('gpt-4o');
    expect(payload.messages[0]).toEqual({ role: 'system', content: 'System' });
    expect(payload.messages[1].role).toBe('user');
    expect(payload.messages[1].content[0]).toEqual({ type: 'text', text: 'Run Product Review Analyzer' });
    expect(payload.messages[1].content[1].type).toBe('image_url');
    expect(payload.messages[2]).toEqual({
      role: 'assistant',
      content: 'Searching skill',
      tool_calls: [
        {
          id: 'tc-prev',
          type: 'function',
          function: { name: 'skill_search', arguments: '{"query":"product review"}' },
        },
      ],
    });
    expect(payload.messages[3]).toEqual({ role: 'tool', content: 'Found skill #3', tool_call_id: 'tc-prev' });
  });

  test('returns conformance error when tool message lacks toolCallId', async () => {
    const provider = new OpenAIProvider(manifest);
    const createFn = jest.fn();
    (provider as any).client = { chat: { completions: { create: createFn } } };

    const request: CompletionRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'assistant', content: 'calling', toolCalls: [{ id: 'tc1', name: 'skill_search', args: {} }] },
        { role: 'tool', content: 'result' },
      ],
    };

    const events = await collect(provider, request);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error).toMatch(/toolCallId is required/i);
    expect(createFn).not.toHaveBeenCalled();
  });
});

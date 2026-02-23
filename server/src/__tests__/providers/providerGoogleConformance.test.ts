import GoogleProvider from '../../plugins/builtin/provider-google';
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

async function collect(provider: GoogleProvider, request: CompletionRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of provider.stream(request)) {
    out.push(event);
  }
  return out;
}

describe('Google Provider Conformance', () => {
  const manifest: any = {
    name: 'provider-google',
    version: '1.0.0',
    type: 'provider',
    displayName: 'Google',
    description: 'test',
    entry: './index.ts',
  };

  test('converts assistant tool calls/results to Gemini functionCall/functionResponse parts', async () => {
    const provider = new GoogleProvider(manifest);
    const generateContentStreamFn = jest.fn();
    const getGenerativeModelFn = jest.fn().mockReturnValue({
      generateContentStream: generateContentStreamFn,
    });

    generateContentStreamFn.mockResolvedValue({
      stream: makeAsyncStream([
        {
          text: () => 'Analyzing...',
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'skill_execute',
                      args: { skillId: 9 },
                    },
                  },
                ],
              },
            },
          ],
        },
      ]),
      response: Promise.resolve({
        functionCalls: () => [],
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'skill_execute',
                    args: { skillId: 9 },
                  },
                },
              ],
            },
          },
        ],
      }),
    });

    (provider as any).client = {
      getGenerativeModel: getGenerativeModelFn,
    };

    const request: CompletionRequest = {
      model: 'gemini-2.5-pro',
      systemPrompt: 'System prompt',
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
          content: 'Analyze this image',
          attachments: [{ type: 'image', mimeType: 'image/png', data: 'AAA' }],
        },
        {
          role: 'assistant',
          content: 'I will search first',
          toolCalls: [{ id: 'tc-prev', name: 'skill_search', args: { query: 'image style' } }],
        },
        { role: 'tool', content: '{"hits":[{"id":9}]}', toolCallId: 'tc-prev' },
      ],
    };

    const events = await collect(provider, request);
    expect(events[0]).toEqual({ type: 'text', text: 'Analyzing...' });
    expect(events[1]).toEqual({
      type: 'tool_call',
      toolCall: expect.objectContaining({
        id: 'google-fc-1',
        name: 'skill_execute',
        args: { skillId: 9 },
      }),
    });
    expect(events[2]).toEqual({ type: 'done' });

    expect(getGenerativeModelFn).toHaveBeenCalledTimes(1);
    const modelOptions = getGenerativeModelFn.mock.calls[0][0];
    expect(modelOptions.systemInstruction.parts[0].text).toBe('System prompt');
    expect(modelOptions.tools[0].functionDeclarations[0].name).toBe('skill_execute');

    const callPayload = generateContentStreamFn.mock.calls[0][0];
    expect(callPayload.contents).toHaveLength(3);
    expect(callPayload.contents[0].role).toBe('user');
    expect(callPayload.contents[0].parts[0]).toEqual({ text: 'Analyze this image' });
    expect(callPayload.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAA' } });
    expect(callPayload.contents[1].role).toBe('model');
    expect(callPayload.contents[1].parts[1]).toEqual({
      functionCall: { id: 'tc-prev', name: 'skill_search', args: { query: 'image style' } },
    });
    expect(callPayload.contents[2].role).toBe('user');
    expect(callPayload.contents[2].parts[0].functionResponse.name).toBe('skill_search');
  });

  test('returns conformance error for tool result missing toolCallId', async () => {
    const provider = new GoogleProvider(manifest);
    const getGenerativeModelFn = jest.fn();
    (provider as any).client = { getGenerativeModel: getGenerativeModelFn };

    const request: CompletionRequest = {
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'assistant', content: 'call', toolCalls: [{ id: 'tc1', name: 'skill_search', args: {} }] },
        { role: 'tool', content: 'result' },
      ],
    };

    const events = await collect(provider, request);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error).toMatch(/toolCallId is required/i);
    expect(getGenerativeModelFn).not.toHaveBeenCalled();
  });
});

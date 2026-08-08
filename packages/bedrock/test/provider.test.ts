import { describe, expect, it } from 'vitest';

import { AiClient, reduceModelStream, type CallOptions } from '@maduser/ai-ts';

import { BedrockProvider, createBedrockProvider } from '../src/provider.js';
import type {
  BedrockConverseRequest,
  BedrockConverseResponse,
  BedrockRuntimeTransport,
  BedrockStreamEvent,
} from '../src/types.js';
import { completedResponse, request, streamEvents } from './fixtures.js';

class FixtureTransport implements BedrockRuntimeTransport {
  public closed = false;
  public readonly converseOptions: CallOptions[] = [];
  public readonly converseRequests: BedrockConverseRequest[] = [];
  public readonly streamOptions: CallOptions[] = [];
  public readonly streamRequests: BedrockConverseRequest[] = [];
  readonly #events: readonly BedrockStreamEvent[];
  readonly #response: BedrockConverseResponse;

  public constructor(
    response: BedrockConverseResponse = completedResponse,
    events: readonly BedrockStreamEvent[] = streamEvents,
  ) {
    this.#events = events;
    this.#response = response;
  }

  public close(): void {
    this.closed = true;
  }

  public converse(
    value: BedrockConverseRequest,
    options: CallOptions,
  ): Promise<BedrockConverseResponse> {
    this.converseRequests.push(value);
    this.converseOptions.push(options);
    return Promise.resolve(this.#response);
  }

  public converseStream(
    value: BedrockConverseRequest,
    options: CallOptions,
  ): Promise<AsyncIterable<BedrockStreamEvent>> {
    this.streamRequests.push(value);
    this.streamOptions.push(options);
    return Promise.resolve(iterate(this.#events));
  }
}

describe('BedrockProvider', () => {
  it('generates through Converse and forwards cancellation and timeout options', async () => {
    const transport = new FixtureTransport();
    const client = new AiClient(fixtureProvider(transport));
    const signal = new AbortController().signal;

    await expect(client.generate(request, { signal, timeoutMs: 2_000 })).resolves.toMatchObject({
      finishReason: 'tool_calls',
      id: 'id-2',
      message: { id: 'id-1' },
    });
    expect(transport.converseRequests[0]?.modelId).toBe('anthropic.claude-sonnet');
    expect(transport.converseOptions).toEqual([{ signal, timeoutMs: 2_000 }]);
  });

  it('assembles text, tools, usage, and the terminal response from ConverseStream', async () => {
    const transport = new FixtureTransport();
    const client = new AiClient(fixtureProvider(transport));

    await expect(reduceModelStream(client.stream(request))).resolves.toMatchObject({
      response: {
        finishReason: 'tool_calls',
        message: {
          content: [
            { text: 'Sunny', type: 'text' },
            { arguments: { place: 'Berlin' }, callId: 'call-1', type: 'tool_call' },
          ],
        },
        usage: {
          cachedInputTokens: 5,
          inputTokens: 17,
          outputTokens: 11,
          providerUnits: { cacheWriteInputTokens: 2 },
        },
      },
      text: 'Sunny',
    });
    expect(transport.streamRequests).toHaveLength(1);
  });

  it('exposes model-overridable capabilities, a public factory, and explicit shutdown', async () => {
    const transport = new FixtureTransport();
    const provider = fixtureProvider(transport);

    expect(createBedrockProvider({ region: 'eu-central-1' }).id).toBe('bedrock');
    await expect(provider.capabilities(request.model)).resolves.toMatchObject({
      input: { audio: false, documents: true, images: true, text: true },
      output: { structured: true, text: true },
      streaming: true,
      tools: { calls: true, strictSchemas: true },
    });
    provider.close();
    expect(transport.closed).toBe(true);
  });

  it('rejects unsupported idempotency keys before transport I/O', async () => {
    const transport = new FixtureTransport();
    const client = new AiClient(fixtureProvider(transport));

    await expect(client.generate(request, { idempotencyKey: 'idem-1' })).rejects.toMatchObject({
      code: 'bedrock_idempotency_key_unsupported',
    });
    await expect(
      reduceModelStream(client.stream(request, { idempotencyKey: 'idem-1' })),
    ).rejects.toMatchObject({ code: 'bedrock_idempotency_key_unsupported' });
    expect(transport.converseRequests).toHaveLength(0);
    expect(transport.streamRequests).toHaveLength(0);
  });

  it.each([
    [
      [{ code: 'ThrottlingException', message: 'Slow down.', retryable: true, type: 'error' }],
      'bedrock_throttling_exception',
    ],
    [
      [{ contentBlockIndex: 0, input: '{}', type: 'tool_delta' }],
      'bedrock_stream_tool_not_started',
    ],
    [
      [
        { contentBlockIndex: 0, name: 'get_weather', toolUseId: 'call-1', type: 'tool_start' },
        { contentBlockIndex: 0, input: '{', type: 'tool_delta' },
        { contentBlockIndex: 0, type: 'content_stop' },
      ],
      'bedrock_stream_tool_input_invalid_json',
    ],
    [
      [
        { contentBlockIndex: 0, name: 'get_weather', toolUseId: 'call-1', type: 'tool_start' },
        { contentBlockIndex: 0, input: '[]', type: 'tool_delta' },
        { contentBlockIndex: 0, type: 'content_stop' },
      ],
      'bedrock_stream_tool_input_not_object',
    ],
    [
      [
        { contentBlockIndex: 0, text: 'text', type: 'text_delta' },
        { contentBlockIndex: 0, name: 'get_weather', toolUseId: 'call-1', type: 'tool_start' },
      ],
      'bedrock_stream_block_conflict',
    ],
    [
      [
        { contentBlockIndex: 0, name: 'get_weather', toolUseId: 'call-1', type: 'tool_start' },
        { contentBlockIndex: 0, input: '{}', type: 'tool_delta' },
        { stopReason: 'tool_use', type: 'message_stop' },
      ],
      'bedrock_stream_tool_incomplete',
    ],
    [
      [
        { contentBlockIndex: 0, name: 'get_weather', toolUseId: 'call-1', type: 'tool_start' },
        { contentBlockIndex: 0, input: '{}', type: 'tool_delta' },
        { contentBlockIndex: 0, type: 'content_stop' },
        { contentBlockIndex: 0, input: '{}', type: 'tool_delta' },
      ],
      'bedrock_stream_tool_already_completed',
    ],
    [
      [{ contentBlockIndex: 0, text: 'unfinished', type: 'text_delta' }],
      'bedrock_stream_stop_missing',
    ],
  ] satisfies readonly [readonly BedrockStreamEvent[], string][])(
    'normalizes stream failure %#',
    async (events, code) => {
      const client = new AiClient(fixtureProvider(new FixtureTransport(completedResponse, events)));
      await expect(reduceModelStream(client.stream(request))).rejects.toMatchObject({ code });
    },
  );
});

function fixtureProvider(transport: BedrockRuntimeTransport): BedrockProvider {
  let id = 0;
  return new BedrockProvider(
    {},
    {
      createId: (): string => {
        id += 1;
        return `id-${String(id)}`;
      },
      now: (): Date => new Date('2026-08-08T12:00:00.000Z'),
      transport,
    },
  );
}

async function* iterate(
  events: readonly BedrockStreamEvent[],
): AsyncGenerator<BedrockStreamEvent, void, void> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

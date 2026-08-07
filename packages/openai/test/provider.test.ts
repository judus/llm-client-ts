import { describe, expect, it } from 'vitest';

import { AiClient, reduceModelStream } from '@maduser/ai-ts';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

import { OpenAIProvider } from '../src/provider.js';
import { createOpenAIProvider } from '../src/index.js';
import type { OpenAIResponsesTransport, OpenAITransportCallOptions } from '../src/transport.js';
import { completedResponse, request, streamEvents } from './fixtures.js';

class FixtureTransport implements OpenAIResponsesTransport {
  public readonly createRequests: ResponseCreateParamsNonStreaming[] = [];
  public readonly createOptions: OpenAITransportCallOptions[] = [];
  public readonly streamOptions: OpenAITransportCallOptions[] = [];
  public readonly streamRequests: ResponseCreateParamsStreaming[] = [];
  readonly #response: Response;
  readonly #streamEvents: readonly ResponseStreamEvent[];

  public constructor(response: Response, events: readonly ResponseStreamEvent[]) {
    this.#response = response;
    this.#streamEvents = events;
  }

  public create(
    value: ResponseCreateParamsNonStreaming,
    options: OpenAITransportCallOptions,
  ): Promise<Response> {
    this.createRequests.push(value);
    this.createOptions.push(options);
    return Promise.resolve(this.#response);
  }

  public stream(
    value: ResponseCreateParamsStreaming,
    options: OpenAITransportCallOptions,
  ): Promise<AsyncIterable<ResponseStreamEvent>> {
    this.streamRequests.push(value);
    this.streamOptions.push(options);
    return Promise.resolve(iterate(this.#streamEvents));
  }
}

describe('OpenAIProvider', () => {
  it('generates through the Responses API without exposing SDK values', async () => {
    const transport = new FixtureTransport(completedResponse, []);
    const provider = fixtureProvider(transport);
    const client = new AiClient(provider);

    const signal = new AbortController().signal;
    await expect(
      client.generate(request, { idempotencyKey: 'idem-1', signal, timeoutMs: 2_000 }),
    ).resolves.toMatchObject({
      finishReason: 'tool_calls',
      id: 'id-2',
      message: { id: 'id-1' },
    });
    expect(transport.createRequests).toHaveLength(1);
    expect(transport.createOptions).toEqual([
      { idempotencyKey: 'idem-1', signal, timeoutMs: 2_000 },
    ]);
  });

  it('translates provider deltas and terminal output into the canonical stream', async () => {
    const transport = new FixtureTransport(completedResponse, streamEvents);
    const client = new AiClient(fixtureProvider(transport));

    await expect(reduceModelStream(client.stream(request))).resolves.toMatchObject({
      response: { finishReason: 'tool_calls' },
      text: 'Sunny',
    });
    expect(transport.streamRequests[0]).toMatchObject({ stream: true });
  });

  it('exposes conservative capabilities and the public factory', async () => {
    const provider = createOpenAIProvider({ apiKey: 'test-key' });

    expect(provider.id).toBe('openai');
    await expect(provider.capabilities(request.model)).resolves.toMatchObject({
      input: { audio: false, documents: false, images: false, text: true },
      output: { structured: true, text: true },
      streaming: true,
      tools: { calls: true },
    });
  });

  it('normalizes transport errors for generation and streaming', async () => {
    const error = new Error('network down');
    const client = new AiClient(fixtureProvider(new RejectingTransport(error)));

    await expect(client.generate(request)).rejects.toMatchObject({
      category: 'transport',
      code: 'openai_unknown_error',
    });
    await expect(reduceModelStream(client.stream(request))).rejects.toMatchObject({
      category: 'transport',
      code: 'openai_unknown_error',
    });
  });

  it('turns a provider error event into a canonical failed terminal event', async () => {
    const events: readonly ResponseStreamEvent[] = [
      {
        code: 'overloaded',
        message: 'Try later.',
        param: null,
        sequence_number: 1,
        type: 'error',
      },
    ];
    const client = new AiClient(fixtureProvider(new FixtureTransport(completedResponse, events)));

    await expect(reduceModelStream(client.stream(request))).rejects.toMatchObject({
      category: 'provider_unavailable',
      code: 'overloaded',
    });
  });

  it('lets the core reject a provider stream without a terminal event', async () => {
    const client = new AiClient(fixtureProvider(new FixtureTransport(completedResponse, [])));

    await expect(reduceModelStream(client.stream(request))).rejects.toMatchObject({
      category: 'malformed_response',
      code: 'invalid_event_sequence',
    });
  });
});

class RejectingTransport implements OpenAIResponsesTransport {
  readonly #error: Error;

  public constructor(error: Error) {
    this.#error = error;
  }

  public create(): Promise<Response> {
    return Promise.reject(this.#error);
  }

  public stream(): Promise<AsyncIterable<ResponseStreamEvent>> {
    return Promise.reject(this.#error);
  }
}

function fixtureProvider(transport: OpenAIResponsesTransport): OpenAIProvider {
  let id = 0;
  return new OpenAIProvider(
    {},
    {
      createId: (): string => {
        id += 1;
        return `id-${String(id)}`;
      },
      now: (): Date => new Date('2026-08-07T12:00:00.000Z'),
      transport,
    },
  );
}

async function* iterate(
  events: readonly ResponseStreamEvent[],
): AsyncGenerator<ResponseStreamEvent, void, void> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

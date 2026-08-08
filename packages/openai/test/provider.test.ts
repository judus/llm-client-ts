import { describe, expect, it } from 'vitest';

import { ModelClient, reduceModelStream } from '@maduser/ai-ts';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

import { OpenAIProvider } from '../src/provider.js';
import { createOpenAIProvider, openAI } from '../src/index.js';
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
    const client = new ModelClient(provider);

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
    const client = new ModelClient(fixtureProvider(transport));

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
      input: { audio: false, documents: true, images: true, text: true },
      output: { structured: true, text: true },
      streaming: true,
      tools: { calls: true },
    });
  });

  it('creates a model-bound provider for the fluent client', () => {
    const provider = openAI({
      apiKey: 'test-key',
      model: 'gpt-5.4',
      speechSynthesis: { voice: 'nova' },
      transcription: { model: 'gpt-transcribe', stream: false },
    });

    expect(provider.id).toBe('openai');
    expect(provider.model).toBe('gpt-5.4');
    expect(provider.speechSynthesis).toBeDefined();
    expect(provider.transcription).toBeDefined();
  });

  it('supports complete fluent-provider configuration and explicit media opt-out', async () => {
    const provider = openAI({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/v1',
      maxRetries: 1,
      model: 'gpt-5.4',
      organization: 'org-test',
      project: 'project-test',
      speechSynthesis: false,
      timeoutMs: 2_000,
      transcription: false,
    });

    expect(provider.speechSynthesis).toBeUndefined();
    expect(provider.transcription).toBeUndefined();
    await expect(
      provider.capabilities({ model: provider.model, provider: provider.id }),
    ).resolves.toMatchObject({ input: { documents: true }, tools: { calls: true } });
    expect(() => openAI({ apiKey: 'test-key', model: ' ' })).toThrow(
      expect.objectContaining({ code: 'openai_model_empty' }),
    );
  });

  it('normalizes transport errors for generation and streaming', async () => {
    const error = new Error('network down');
    const client = new ModelClient(fixtureProvider(new RejectingTransport(error)));

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
    const client = new ModelClient(
      fixtureProvider(new FixtureTransport(completedResponse, events)),
    );

    await expect(reduceModelStream(client.stream(request))).rejects.toMatchObject({
      category: 'provider_unavailable',
      code: 'overloaded',
    });
  });

  it('lets the core reject a provider stream without a terminal event', async () => {
    const client = new ModelClient(fixtureProvider(new FixtureTransport(completedResponse, [])));

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

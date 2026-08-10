import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ResponseCompletedEvent,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

import { OpenAISdkResponsesTransport } from '../../../src/providers/openai/transport.js';
import { completedResponse } from './fixtures.js';

const mocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  create: vi.fn<(request: unknown, options: unknown) => Promise<unknown>>(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    public readonly responses = { create: mocks.create };

    public constructor(options: unknown) {
      mocks.clientOptions.push(options);
    }
  },
}));

describe('OpenAISdkResponsesTransport', () => {
  beforeEach(() => {
    mocks.clientOptions.length = 0;
    mocks.create.mockReset();
  });

  it('maps suite configuration and call options into the SDK boundary', async () => {
    mocks.create.mockResolvedValue(completedResponse);
    const transport = new OpenAISdkResponsesTransport({
      apiKey: 'test-key',
      baseUrl: 'https://openai.example.test/v1',
      maxRetries: 1,
      organization: 'org-test',
      project: 'project-test',
      timeoutMs: 5_000,
    });
    const signal = new AbortController().signal;

    await expect(
      transport.create(
        { input: 'hello', model: 'gpt-5.4', stream: false },
        { idempotencyKey: 'idem-1', signal, timeoutMs: 2_000 },
      ),
    ).resolves.toBe(completedResponse);
    expect(mocks.clientOptions).toEqual([
      {
        apiKey: 'test-key',
        baseURL: 'https://openai.example.test/v1',
        maxRetries: 1,
        organization: 'org-test',
        project: 'project-test',
        timeout: 5_000,
      },
    ]);
    expect(mocks.create).toHaveBeenCalledWith(
      { input: 'hello', model: 'gpt-5.4', stream: false },
      {
        headers: { 'Idempotency-Key': 'idem-1' },
        signal,
        timeout: 2_000,
      },
    );
  });

  it('supports SDK defaults and streaming without optional call settings', async () => {
    const stream = iterate([]);
    mocks.create.mockResolvedValue(stream);
    const transport = new OpenAISdkResponsesTransport({});

    await expect(
      transport.stream({ input: 'hello', model: 'gpt-5.4', stream: true }, {}),
    ).resolves.toBe(stream);
    expect(mocks.clientOptions).toEqual([{}]);
    expect(mocks.create).toHaveBeenCalledWith(
      { input: 'hello', model: 'gpt-5.4', stream: true },
      {},
    );
  });

  it('logs the exact request, response, and stream events when wire diagnostics are enabled', async () => {
    const events: unknown[] = [];
    const streamEvent = {
      type: 'response.completed',
      response: completedResponse,
      sequence_number: 0,
    } satisfies ResponseCompletedEvent;
    mocks.create.mockResolvedValue(iterate([streamEvent]));
    const transport = new OpenAISdkResponsesTransport({
      wireLogger: (event) => events.push(event),
    });

    const stream = await transport.stream(
      { input: 'trace me', model: 'gpt-5.4', stream: true },
      {},
    );
    await expect(collect(stream)).resolves.toEqual([streamEvent]);

    expect(events).toEqual([
      expect.objectContaining({
        operation: 'stream',
        phase: 'request',
        payload: { input: 'trace me', model: 'gpt-5.4', stream: true },
      }),
      expect.objectContaining({
        operation: 'stream',
        phase: 'response',
        payload: { type: 'stream_opened' },
      }),
      expect.objectContaining({ operation: 'stream', phase: 'stream_event', payload: streamEvent }),
    ]);
  });

  it('logs transport failures without replacing the original error', async () => {
    const events: unknown[] = [];
    const failure = new Error('connection lost');
    mocks.create.mockRejectedValue(failure);
    const transport = new OpenAISdkResponsesTransport({
      wireLogger: (event) => events.push(event),
    });

    await expect(
      transport.create({ input: 'trace failure', model: 'gpt-5.4', stream: false }, {}),
    ).rejects.toBe(failure);
    expect(events).toEqual([
      expect.objectContaining({ operation: 'create', phase: 'request' }),
      expect.objectContaining({ operation: 'create', phase: 'error', payload: failure }),
    ]);
  });

  it('logs completed non-streaming responses', async () => {
    const events: unknown[] = [];
    mocks.create.mockResolvedValue(completedResponse);
    const transport = new OpenAISdkResponsesTransport({
      wireLogger: (event) => events.push(event),
    });

    await expect(
      transport.create({ input: 'trace response', model: 'gpt-5.4', stream: false }, {}),
    ).resolves.toBe(completedResponse);
    expect(events).toEqual([
      expect.objectContaining({ operation: 'create', phase: 'request' }),
      expect.objectContaining({
        operation: 'create',
        payload: completedResponse,
        phase: 'response',
      }),
    ]);
  });

  it('never lets a diagnostics callback break a provider request', async () => {
    mocks.create.mockResolvedValue(completedResponse);
    const transport = new OpenAISdkResponsesTransport({
      wireLogger: () => {
        throw new Error('logger failed');
      },
    });

    await expect(
      transport.create({ input: 'still works', model: 'gpt-5.4', stream: false }, {}),
    ).resolves.toBe(completedResponse);
  });
});

async function* iterate(
  events: readonly ResponseStreamEvent[],
): AsyncGenerator<ResponseStreamEvent, void, void> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of iterable) result.push(value);
  return result;
}

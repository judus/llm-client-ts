import { describe, expect, it, vi } from 'vitest';

import {
  ModelClient,
  AiError,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from '../src/index.js';
import { capabilities, response, userMessage } from './fixtures.js';

const request: ModelRequest = {
  messages: [userMessage],
  model: { model: 'test-model', provider: 'test' },
};

class StubProvider implements ModelProvider {
  public readonly id = 'test';
  public readonly generateMock = vi.fn<(value: ModelRequest) => Promise<ModelResponse>>();
  readonly #events: readonly ModelStreamEvent[];

  public constructor(events: readonly ModelStreamEvent[] = []) {
    this.#events = events;
    this.generateMock.mockResolvedValue(response);
  }

  public capabilities(): Promise<ModelCapabilities> {
    return Promise.resolve(capabilities);
  }

  public generate(value: ModelRequest): Promise<ModelResponse> {
    return this.generateMock(value);
  }

  public async *stream(): AsyncGenerator<ModelStreamEvent, void, void> {
    for (const event of this.#events) {
      await Promise.resolve();
      yield event;
    }
  }
}

describe('ModelClient', () => {
  it('returns provider capabilities', async () => {
    const client = new ModelClient(new StubProvider());

    await expect(client.capabilities(request)).resolves.toBe(capabilities);
  });

  it('validates and delegates a complete response', async () => {
    const provider = new StubProvider();
    const client = new ModelClient(provider);

    await expect(client.generate(request)).resolves.toBe(response);
    expect(provider.generateMock).toHaveBeenCalledExactlyOnceWith(request);
  });

  it('rejects a provider mismatch before generation', async () => {
    const provider = new StubProvider();
    const client = new ModelClient(provider);
    const mismatched: ModelRequest = {
      ...request,
      model: { model: 'test-model', provider: 'different' },
    };

    await expect(client.generate(mismatched)).rejects.toMatchObject({
      category: 'invalid_request',
      code: 'provider_mismatch',
    });
    expect(provider.generateMock).not.toHaveBeenCalled();
  });

  it('normalizes an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort('stop');
    const client = new ModelClient(new StubProvider());

    await expect(client.generate(request, { signal: controller.signal })).rejects.toMatchObject({
      category: 'cancelled',
      code: 'request_cancelled',
    });
  });

  it('accepts an ordered stream with one terminal event', async () => {
    const provider = new StubProvider([
      event(0, { type: 'model.request.started' }),
      event(1, { delta: 'Hello', outputIndex: 0, type: 'model.text.delta' }),
      event(2, { response, type: 'model.response.completed' }),
    ]);
    const client = new ModelClient(provider);

    const events: ModelStreamEvent[] = [];
    for await (const value of client.stream(request)) {
      events.push(value);
    }

    expect(events).toHaveLength(3);
  });

  it('rejects a sequence gap', async () => {
    const provider = new StubProvider([
      event(0, { type: 'model.request.started' }),
      event(2, { response, type: 'model.response.completed' }),
    ]);
    const client = new ModelClient(provider);

    await expect(collect(client.stream(request))).rejects.toMatchObject({
      category: 'malformed_response',
      code: 'invalid_event_sequence',
    });
  });

  it('rejects a stream without a terminal event', async () => {
    const provider = new StubProvider([event(0, { type: 'model.request.started' })]);
    const client = new ModelClient(provider);

    await expect(collect(client.stream(request))).rejects.toBeInstanceOf(AiError);
  });

  it('rejects a stream that does not start with a request event', async () => {
    const client = new ModelClient(
      new StubProvider([event(0, { delta: 'Hello', outputIndex: 0, type: 'model.text.delta' })]),
    );

    await expect(collect(client.stream(request))).rejects.toMatchObject({
      code: 'invalid_event_sequence',
    });
  });

  it('rejects duplicate starts and events after a terminal event', async () => {
    const duplicateStart = new ModelClient(
      new StubProvider([
        event(0, { type: 'model.request.started' }),
        event(1, { type: 'model.request.started' }),
      ]),
    );
    await expect(collect(duplicateStart.stream(request))).rejects.toMatchObject({
      code: 'invalid_event_sequence',
    });

    const eventAfterTerminal = new ModelClient(
      new StubProvider([
        event(0, { type: 'model.request.started' }),
        event(1, { response, type: 'model.response.completed' }),
        event(2, { delta: 'late', outputIndex: 0, type: 'model.text.delta' }),
      ]),
    );
    await expect(collect(eventAfterTerminal.stream(request))).rejects.toMatchObject({
      code: 'invalid_event_sequence',
    });
  });
});

type EventPayload =
  | { readonly type: 'model.request.started' }
  | { readonly delta: string; readonly outputIndex: number; readonly type: 'model.text.delta' }
  | { readonly response: ModelResponse; readonly type: 'model.response.completed' };

function event(sequence: number, payload: EventPayload): ModelStreamEvent {
  return {
    eventId: `event-${String(sequence)}`,
    occurredAt: '2026-08-07T12:00:00.000Z',
    requestId: 'request-1',
    sequence,
    ...payload,
  };
}

async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const result: ModelStreamEvent[] = [];
  for await (const eventValue of events) {
    result.push(eventValue);
  }
  return result;
}

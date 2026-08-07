import { describe, expect, it } from 'vitest';

import {
  AiError,
  reduceModelStream,
  type ModelStreamEvent,
  type SerializedAiError,
} from '../src/index.js';
import { response } from './fixtures.js';

describe('reduceModelStream', () => {
  it('collects text and returns the canonical response', async () => {
    const events: ModelStreamEvent[] = [
      event(0, { type: 'model.request.started' }),
      event(1, { delta: 'Hello ', outputIndex: 0, type: 'model.text.delta' }),
      event(2, { delta: 'back', outputIndex: 0, type: 'model.text.delta' }),
      event(3, { response, type: 'model.response.completed' }),
    ];

    await expect(reduceModelStream(iterate(events))).resolves.toEqual({
      response,
      text: 'Hello back',
    });
  });

  it('recreates a safe normalized failure', async () => {
    const error: SerializedAiError = {
      category: 'rate_limit',
      code: 'provider_rate_limit',
      message: 'Try later.',
      retryable: true,
    };
    const events: ModelStreamEvent[] = [
      event(0, { type: 'model.request.started' }),
      event(1, { error, type: 'model.response.failed' }),
    ];

    await expect(reduceModelStream(iterate(events))).rejects.toMatchObject({
      category: 'rate_limit',
      code: 'provider_rate_limit',
      retryable: true,
    });
  });

  it('rejects a stream without a completed response', async () => {
    await expect(
      reduceModelStream(iterate([event(0, { type: 'model.request.started' })])),
    ).rejects.toBeInstanceOf(AiError);
  });
});

type EventPayload =
  | { readonly type: 'model.request.started' }
  | { readonly delta: string; readonly outputIndex: number; readonly type: 'model.text.delta' }
  | { readonly error: SerializedAiError; readonly type: 'model.response.failed' }
  | { readonly response: typeof response; readonly type: 'model.response.completed' };

function event(sequence: number, payload: EventPayload): ModelStreamEvent {
  return {
    eventId: `event-${String(sequence)}`,
    occurredAt: '2026-08-07T12:00:00.000Z',
    requestId: 'request-1',
    sequence,
    ...payload,
  };
}

async function* iterate(
  events: readonly ModelStreamEvent[],
): AsyncGenerator<ModelStreamEvent, void, void> {
  for (const eventValue of events) {
    await Promise.resolve();
    yield eventValue;
  }
}

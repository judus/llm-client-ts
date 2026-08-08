import {
  ModelClient,
  AiError,
  type ConversationMessage,
  type ModelRequest,
  type ModelResponse,
} from '../../src/index.js';
import { describe, expect, it } from 'vitest';

import { ScriptedProvider } from '../../src/testing/index.js';

const userMessage: ConversationMessage = {
  content: [{ text: 'Hello', type: 'text' }],
  conversationId: 'conversation-1',
  createdAt: '2026-08-07T12:00:00.000Z',
  id: 'user-1',
  role: 'user',
};

const assistantMessage: ConversationMessage = {
  content: [{ text: 'Hello back', type: 'text' }],
  conversationId: 'conversation-1',
  createdAt: '2026-08-07T12:00:01.000Z',
  id: 'assistant-1',
  role: 'assistant',
};

const request: ModelRequest = {
  messages: [userMessage],
  model: { model: 'fixture', provider: 'scripted' },
};

const response: ModelResponse = {
  finishReason: 'stop',
  id: 'response-1',
  message: assistantMessage,
  model: request.model,
  usage: {},
};

describe('ScriptedProvider', () => {
  it('drives a deterministic complete response and records requests', async () => {
    const provider = new ScriptedProvider([{ response, type: 'generate' }]);
    const client = new ModelClient(provider);

    await expect(client.generate(request)).resolves.toBe(response);
    expect(provider.requests).toEqual([request]);
    expect(provider.remainingSteps).toBe(0);
  });

  it('fails when the script is exhausted', async () => {
    const provider = new ScriptedProvider([]);
    const client = new ModelClient(provider);

    await expect(client.generate(request)).rejects.toMatchObject({ code: 'script_exhausted' });
  });

  it('can script a provider error', async () => {
    const error = new AiError('rate_limit', 'Slow down.', {
      code: 'rate_limit',
      retryable: true,
    });
    const provider = new ScriptedProvider([{ error, type: 'throw' }]);
    const client = new ModelClient(provider);

    await expect(client.generate(request)).rejects.toBe(error);
  });

  it('rejects an unexpected operation and can script stream failures', async () => {
    const wrongOperation = new ScriptedProvider([{ events: [], type: 'stream' }]);
    await expect(new ModelClient(wrongOperation).generate(request)).rejects.toMatchObject({
      code: 'unexpected_script_step',
    });

    const error = new AiError('provider_unavailable', 'Unavailable.', {
      code: 'unavailable',
    });
    const failedStream = new ScriptedProvider([{ error, type: 'throw' }]);
    await expect(collect(new ModelClient(failedStream).stream(request))).rejects.toBe(error);
  });

  it('rejects cancellation between scripted stream events', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      {
        events: [event(0, 'model.request.started'), event(1, 'model.request.started')],
        type: 'stream',
      },
    ]);
    const events = provider.stream(request, { signal: controller.signal });
    await events.next();
    controller.abort();

    await expect(events.next()).rejects.toThrow();
  });
});

function event(
  sequence: number,
  type: 'model.request.started',
): {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly sequence: number;
  readonly type: 'model.request.started';
} {
  return {
    eventId: `event-${String(sequence)}`,
    occurredAt: '2026-08-07T12:00:00.000Z',
    requestId: 'request-1',
    sequence,
    type,
  };
}

async function collect(events: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = [];
  for await (const value of events) {
    result.push(value);
  }
  return result;
}

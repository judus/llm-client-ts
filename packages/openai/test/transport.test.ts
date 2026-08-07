import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResponseStreamEvent } from 'openai/resources/responses/responses';

import { OpenAISdkResponsesTransport } from '../src/transport.js';
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
});

async function* iterate(
  events: readonly ResponseStreamEvent[],
): AsyncGenerator<ResponseStreamEvent, void, void> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

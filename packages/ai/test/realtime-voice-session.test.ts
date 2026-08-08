import { describe, expect, it, vi } from 'vitest';

import {
  GuardedRealtimeVoiceSession,
  validateRealtimeVoiceConfig,
  type RealtimeAudioChunk,
  type RealtimeVoiceCapabilities,
  type RealtimeVoiceEvent,
  type RealtimeVoiceSession,
  type RealtimeVoiceSessionConfig,
  type RealtimeVoiceSessionState,
  type ToolResultPart,
} from '../src/index.js';

const config: RealtimeVoiceSessionConfig = {
  inputAudio: {
    channels: 1,
    encoding: 'pcm16',
    mimeType: 'audio/pcm',
    sampleRateHz: 24_000,
  },
  instructions: 'Be concise.',
  model: { model: 'realtime-model', provider: 'test' },
  outputAudio: {
    channels: 1,
    encoding: 'pcm16',
    mimeType: 'audio/pcm',
    sampleRateHz: 24_000,
  },
  turnDetection: { type: 'manual' },
  voice: 'coral',
};

const capabilities: RealtimeVoiceCapabilities = {
  clientSecrets: true,
  inputAudioEncodings: ['pcm16'],
  interruption: true,
  manualCommit: true,
  maxAudioChunkBytes: 4,
  outputAudioEncodings: ['pcm16'],
  serverVad: true,
  textInput: true,
  toolCalls: true,
};

class FakeSession implements RealtimeVoiceSession {
  public readonly close = vi.fn(() => Promise.resolve());
  public readonly commitInput = vi.fn(() => Promise.resolve());
  public readonly id = 'session-1';
  public readonly interrupt = vi.fn(() => Promise.resolve());
  public readonly sendAudio = vi.fn<(chunk: RealtimeAudioChunk) => Promise<void>>(() =>
    Promise.resolve(),
  );
  public readonly sendText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
  public readonly sendToolResult = vi.fn<(result: ToolResultPart) => Promise<void>>(() =>
    Promise.resolve(),
  );
  public state: RealtimeVoiceSessionState = 'open';
  readonly #events: readonly RealtimeVoiceEvent[];
  readonly #failure: Error | undefined;

  public constructor(events: readonly RealtimeVoiceEvent[], failure?: Error) {
    this.#events = events;
    this.#failure = failure;
  }

  public async *events(): AsyncGenerator<RealtimeVoiceEvent> {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    for (const event of this.#events) {
      await Promise.resolve();
      yield event;
    }
  }
}

function event(
  sequence: number,
  value:
    | { readonly config: RealtimeVoiceSessionConfig; readonly type: 'realtime.session.started' }
    | {
        readonly reason: 'client_closed';
        readonly type: 'realtime.session.closed';
      }
    | {
        readonly responseId: string;
        readonly type: 'realtime.response.started';
      },
): RealtimeVoiceEvent {
  return {
    eventId: `event-${String(sequence)}`,
    occurredAt: '2026-08-08T12:00:00.000Z',
    sequence,
    sessionId: 'session-1',
    ...value,
  };
}

async function collect(events: AsyncIterable<RealtimeVoiceEvent>): Promise<RealtimeVoiceEvent[]> {
  const result: RealtimeVoiceEvent[] = [];
  for await (const value of events) {
    result.push(value);
  }
  return result;
}

describe('GuardedRealtimeVoiceSession', () => {
  it('delegates supported operations and validates one terminal event stream', async () => {
    const raw = new FakeSession([
      event(0, { config, type: 'realtime.session.started' }),
      event(1, { responseId: 'response-1', type: 'realtime.response.started' }),
      event(2, { reason: 'client_closed', type: 'realtime.session.closed' }),
    ]);
    const session = new GuardedRealtimeVoiceSession({ capabilities, config, session: raw });
    const chunk = { bytes: new Uint8Array([1, 2]), durationMs: 20 };
    const result: ToolResultPart = {
      callId: 'call-1',
      content: [{ text: 'done', type: 'text' }],
      status: 'success',
      type: 'tool_result',
    };

    await session.sendAudio(chunk);
    await session.sendText('Hello');
    await session.commitInput();
    await session.interrupt();
    await session.sendToolResult(result);
    const events = await collect(session.events());

    expect(raw.sendAudio).toHaveBeenCalledWith(chunk);
    expect(raw.sendText).toHaveBeenCalledWith('Hello');
    expect(raw.commitInput).toHaveBeenCalledOnce();
    expect(raw.interrupt).toHaveBeenCalledOnce();
    expect(raw.sendToolResult).toHaveBeenCalledWith(result);
    expect(events).toHaveLength(3);
    expect(session.state).toBe('closed');
    await session.close();
    expect(raw.close).not.toHaveBeenCalled();
  });

  it('closes once and blocks subsequent operations', async () => {
    const raw = new FakeSession([]);
    const session = new GuardedRealtimeVoiceSession({ capabilities, config, session: raw });

    const first = session.close();
    const second = session.close();
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(raw.close).toHaveBeenCalledOnce();
    expect(session.state).toBe('closed');
    expect(() => session.sendAudio({ bytes: new Uint8Array([1]) })).toThrow(
      expect.objectContaining({ code: 'realtime_operation_invalid' }),
    );
  });

  it('normalizes close and event transport failures', async () => {
    const closeFailure = new FakeSession([]);
    closeFailure.close.mockRejectedValueOnce(new Error('socket close failed'));
    const closing = new GuardedRealtimeVoiceSession({
      capabilities,
      config,
      session: closeFailure,
    });
    await expect(closing.close()).rejects.toMatchObject({
      category: 'transport',
      code: 'realtime_session_transport_failed',
    });
    expect(closing.state).toBe('failed');

    const eventsFailure = new GuardedRealtimeVoiceSession({
      capabilities,
      config,
      session: new FakeSession([], new Error('socket failed')),
    });
    await expect(collect(eventsFailure.events())).rejects.toMatchObject({
      category: 'transport',
      code: 'realtime_session_transport_failed',
    });
    expect(eventsFailure.state).toBe('failed');
  });

  it.each([
    {
      events: [event(0, { config, type: 'realtime.session.started' })],
      name: 'missing terminal',
    },
    {
      events: [event(0, { responseId: 'response-1', type: 'realtime.response.started' })],
      name: 'missing start',
    },
    {
      events: [
        event(0, { config, type: 'realtime.session.started' }),
        event(0, { reason: 'client_closed', type: 'realtime.session.closed' }),
      ],
      name: 'non-contiguous sequence',
    },
    {
      events: [
        event(0, { config, type: 'realtime.session.started' }),
        event(1, { config, type: 'realtime.session.started' }),
      ],
      name: 'duplicate start',
    },
    {
      events: [
        event(0, { config, type: 'realtime.session.started' }),
        event(1, { reason: 'client_closed', type: 'realtime.session.closed' }),
        event(2, { responseId: 'late', type: 'realtime.response.started' }),
      ],
      name: 'event after terminal',
    },
  ])('rejects $name event protocols', async ({ events }) => {
    const session = new GuardedRealtimeVoiceSession({
      capabilities,
      config,
      session: new FakeSession(events),
    });

    await expect(collect(session.events())).rejects.toMatchObject({
      category: 'malformed_response',
      code: 'realtime_event_protocol_invalid',
    });
    expect(session.state).toBe('failed');
  });

  it('rejects events for another session and multiple consumers', async () => {
    const wrongSession = {
      ...event(0, { config, type: 'realtime.session.started' }),
      sessionId: 'session-2',
    };
    const session = new GuardedRealtimeVoiceSession({
      capabilities,
      config,
      session: new FakeSession([wrongSession]),
    });
    const events = session.events();
    expect(() => session.events()).toThrow(
      expect.objectContaining({ code: 'realtime_operation_invalid' }),
    );
    await expect(collect(events)).rejects.toMatchObject({
      code: 'realtime_event_protocol_invalid',
    });
  });

  it.each([
    { operation: 'text', supported: { textInput: false } },
    { operation: 'commit', supported: { manualCommit: false } },
    { operation: 'interrupt', supported: { interruption: false } },
    { operation: 'tool', supported: { toolCalls: false } },
  ])('rejects unsupported $operation operations', async ({ operation, supported }) => {
    const raw = new FakeSession([]);
    const session = new GuardedRealtimeVoiceSession({
      capabilities: { ...capabilities, ...supported },
      config:
        operation === 'commit' ? { ...config, turnDetection: { type: 'server_vad' } } : config,
      session: raw,
    });
    const action =
      operation === 'text'
        ? session.sendText('Hello')
        : operation === 'commit'
          ? session.commitInput()
          : operation === 'interrupt'
            ? session.interrupt()
            : session.sendToolResult({
                callId: 'call-1',
                content: [],
                status: 'success',
                type: 'tool_result',
              });

    await expect(action).rejects.toMatchObject({ code: 'realtime_capability_unsupported' });
  });

  it.each([
    { chunk: { bytes: new Uint8Array() }, name: 'empty bytes' },
    { chunk: { bytes: new Uint8Array([1, 2, 3, 4, 5]) }, name: 'oversize bytes' },
    { chunk: { bytes: new Uint8Array([1]), durationMs: -1 }, name: 'negative duration' },
  ])('rejects $name audio chunks before delegation', ({ chunk }) => {
    const raw = new FakeSession([]);
    const session = new GuardedRealtimeVoiceSession({ capabilities, config, session: raw });

    expect(() => session.sendAudio(chunk)).toThrow(
      expect.objectContaining({ code: 'realtime_operation_invalid' }),
    );
    expect(raw.sendAudio).not.toHaveBeenCalled();
  });

  it('rejects empty text before delegation', async () => {
    const raw = new FakeSession([]);
    const session = new GuardedRealtimeVoiceSession({ capabilities, config, session: raw });

    await expect(session.sendText(' ')).rejects.toMatchObject({
      code: 'realtime_operation_invalid',
    });
    expect(raw.sendText).not.toHaveBeenCalled();
  });
});

describe('validateRealtimeVoiceConfig', () => {
  it('accepts bounded server VAD', () => {
    expect(() => {
      validateRealtimeVoiceConfig(
        {
          ...config,
          turnDetection: {
            createResponse: true,
            interruptResponse: true,
            prefixPaddingMs: 300,
            silenceDurationMs: 500,
            threshold: 0.5,
            type: 'server_vad',
          },
        },
        capabilities,
      );
    }).not.toThrow();
  });

  it.each([
    { capabilities: { manualCommit: false }, config, name: 'manual mode' },
    {
      capabilities: { serverVad: false },
      config: { ...config, turnDetection: { type: 'server_vad' as const } },
      name: 'server VAD',
    },
    {
      capabilities: {},
      config: { ...config, inputAudio: { ...config.inputAudio, encoding: 'opus' as const } },
      name: 'input encoding',
    },
    {
      capabilities: {},
      config: { ...config, turnDetection: { threshold: 1.1, type: 'server_vad' as const } },
      name: 'VAD threshold',
    },
  ])('rejects unsupported or invalid $name configuration', (fixture) => {
    expect(() => {
      validateRealtimeVoiceConfig(fixture.config, {
        ...capabilities,
        ...fixture.capabilities,
      });
    }).toThrow();
  });
});

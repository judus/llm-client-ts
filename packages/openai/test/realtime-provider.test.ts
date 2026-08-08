import { describe, expect, it, vi } from 'vitest';

import {
  AiError,
  type JsonObject,
  type RealtimeVoiceEvent,
  type RealtimeVoiceSessionConfig,
} from '@maduser/ai-ts';

import {
  createOpenAIRealtimeVoiceProvider,
  OpenAIRealtimeVoiceProvider,
  type OpenAIRealtimeTransport,
  type OpenAIRealtimeTransportConnection,
  type OpenAIRealtimeTransportEvent,
} from '../src/index.js';

const config: RealtimeVoiceSessionConfig = {
  conversationId: 'conversation-1',
  inputAudio: {
    channels: 1,
    encoding: 'pcm16',
    mimeType: 'audio/pcm',
    sampleRateHz: 24_000,
  },
  inputTranscription: { language: 'en' },
  instructions: 'Be concise.',
  model: { model: 'gpt-realtime', provider: 'openai' },
  outputAudio: { channels: 1, encoding: 'g711_ulaw', mimeType: 'audio/pcmu' },
  turnDetection: { type: 'manual' },
  voice: 'coral',
};

class ScriptedConnection implements OpenAIRealtimeTransportConnection {
  public readonly close = vi.fn();
  public readonly sent: JsonObject[] = [];
  readonly #events: readonly OpenAIRealtimeTransportEvent[];

  public constructor(messages: readonly JsonObject[], terminal?: OpenAIRealtimeTransportEvent) {
    this.#events = [
      ...messages.map((message): OpenAIRealtimeTransportEvent => ({ message, type: 'message' })),
      ...(terminal === undefined ? [] : [terminal]),
    ];
  }

  public send(event: JsonObject): void {
    this.sent.push(event);
  }

  public events(): AsyncIterable<OpenAIRealtimeTransportEvent> {
    const iterator = this.#events[Symbol.iterator]();
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve(iterator.next()),
      }),
    };
  }
}

function provider(connection: ScriptedConnection): OpenAIRealtimeVoiceProvider {
  let id = 0;
  const transport: OpenAIRealtimeTransport = {
    connect: vi.fn().mockResolvedValue(connection),
  };
  return new OpenAIRealtimeVoiceProvider({
    idGenerator: () => `event-${String(id++)}`,
    now: () => new Date('2026-08-08T12:00:00.000Z'),
    transport,
  });
}

async function collect(events: AsyncIterable<RealtimeVoiceEvent>): Promise<RealtimeVoiceEvent[]> {
  const result: RealtimeVoiceEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

describe('OpenAIRealtimeVoiceProvider', () => {
  it('handshakes, maps configuration, and implements client operations', async () => {
    const connection = new ScriptedConnection(
      [
        { session: { id: 'session-1' }, type: 'session.created' },
        { session: { id: 'session-1' }, type: 'session.updated' },
      ],
      { code: 1_000, type: 'closed' },
    );
    const session = await provider(connection).connect(config);

    expect(connection.sent[0]).toEqual({
      session: {
        audio: {
          input: {
            format: { rate: 24_000, type: 'audio/pcm' },
            transcription: { language: 'en', model: 'gpt-4o-mini-transcribe' },
            turn_detection: null,
          },
          output: { format: { type: 'audio/pcmu' }, voice: 'coral' },
        },
        instructions: 'Be concise.',
        model: 'gpt-realtime',
        output_modalities: ['audio'],
        type: 'realtime',
      },
      type: 'session.update',
    });

    await session.sendAudio({ bytes: new Uint8Array([1, 2, 3]) });
    await session.sendText('Hello');
    await session.commitInput();
    await session.interrupt();
    await session.sendToolResult({
      callId: 'call-1',
      content: [{ text: 'ok', type: 'text' }],
      status: 'success',
      type: 'tool_result',
    });

    expect(connection.sent.slice(1)).toEqual([
      { audio: 'AQID', type: 'input_audio_buffer.append' },
      {
        item: {
          content: [{ text: 'Hello', type: 'input_text' }],
          role: 'user',
          type: 'message',
        },
        type: 'conversation.item.create',
      },
      { type: 'response.create' },
      { type: 'input_audio_buffer.commit' },
      { type: 'response.create' },
      { type: 'response.cancel' },
      {
        item: {
          call_id: 'call-1',
          output:
            '{"callId":"call-1","content":[{"text":"ok","type":"text"}],"status":"success","type":"tool_result"}',
          type: 'function_call_output',
        },
        type: 'conversation.item.create',
      },
      { type: 'response.create' },
    ]);

    const events = await collect(session.events());
    expect(events.map((event) => event.type)).toEqual([
      'realtime.session.started',
      'realtime.session.closed',
    ]);
  });

  it('normalizes audio, transcripts, messages, tools, usage, and recoverable errors', async () => {
    const connection = new ScriptedConnection(
      [
        { session: { id: 'session-1' }, type: 'session.created' },
        { session: { id: 'session-1' }, type: 'session.updated' },
        {
          audio_start_ms: 100,
          item_id: 'user-1',
          type: 'input_audio_buffer.speech_started',
        },
        {
          audio_end_ms: 450,
          item_id: 'user-1',
          type: 'input_audio_buffer.speech_stopped',
        },
        {
          delta: 'Hel',
          item_id: 'user-1',
          type: 'conversation.item.input_audio_transcription.delta',
        },
        {
          item_id: 'user-1',
          transcript: 'Hello',
          type: 'conversation.item.input_audio_transcription.completed',
        },
        { response: { id: 'response-1' }, type: 'response.created' },
        { delta: 'AQID', response_id: 'response-1', type: 'response.output_audio.delta' },
        { response_id: 'response-1', type: 'response.output_audio.done' },
        {
          delta: 'Hi',
          response_id: 'response-1',
          type: 'response.output_audio_transcript.delta',
        },
        {
          item_id: 'assistant-1',
          response_id: 'response-1',
          transcript: 'Hi there',
          type: 'response.output_audio_transcript.done',
        },
        {
          arguments: '{"system":"Sol"}',
          call_id: 'call-1',
          name: 'lookup',
          response_id: 'response-1',
          type: 'response.function_call_arguments.done',
        },
        {
          response: {
            id: 'response-1',
            status: 'completed',
            usage: {
              input_token_details: { audio_tokens: 3 },
              input_tokens: 10,
              output_token_details: { audio_tokens: 4 },
              output_tokens: 5,
            },
          },
          type: 'response.done',
        },
        {
          error: {
            code: 'bad_event',
            event_id: 'client-event-1',
            message: 'Bad event.',
            type: 'invalid_request_error',
          },
          type: 'error',
        },
      ],
      { code: 1_001, reason: 'away', type: 'closed' },
    );

    const events = await collect((await provider(connection).connect(config)).events());

    expect(events.map((event) => event.type)).toEqual([
      'realtime.session.started',
      'realtime.input_audio.started',
      'realtime.input_audio.stopped',
      'realtime.input_transcript.delta',
      'realtime.input_transcript.completed',
      'realtime.conversation.message_committed',
      'realtime.response.started',
      'realtime.output_audio.delta',
      'realtime.output_audio.completed',
      'realtime.output_transcript.delta',
      'realtime.output_transcript.completed',
      'realtime.conversation.message_committed',
      'realtime.tool_call.proposed',
      'realtime.usage.updated',
      'realtime.operation.failed',
      'realtime.session.closed',
    ]);
    expect(events[2]).toMatchObject({ audioDurationMs: 350 });
    expect(events[7]).toMatchObject({ chunk: { bytes: new Uint8Array([1, 2, 3]) } });
    expect(events[12]).toMatchObject({
      call: { arguments: { system: 'Sol' }, id: 'call-1', name: 'lookup' },
    });
    expect(events[13]).toMatchObject({
      usage: { audioInputTokens: 3, audioOutputTokens: 4, inputTokens: 10, outputTokens: 5 },
    });
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
  });

  it('turns response outcomes and malformed event payloads into explicit events', async () => {
    const connection = new ScriptedConnection([
      { session: { id: 'session-1' }, type: 'session.created' },
      { session: { id: 'session-1' }, type: 'session.updated' },
      { response: { id: 'response-1' }, type: 'response.created' },
      { response: { id: 'response-1', status: 'cancelled' }, type: 'response.done' },
      { response: { id: 'response-2', status: 'failed' }, type: 'response.done' },
      { delta: 'not base64!', response_id: 'response-3', type: 'response.output_audio.delta' },
    ]);

    const events = await collect((await provider(connection).connect(config)).events());
    expect(events.map((event) => event.type)).toEqual([
      'realtime.session.started',
      'realtime.response.started',
      'realtime.response.interrupted',
      'realtime.response.failed',
      'realtime.session.failed',
    ]);
    expect(events.at(-1)).toMatchObject({
      error: { code: 'openai_realtime_audio_base64_invalid' },
      recoverable: false,
    });
  });

  it('rejects provider mismatches and malformed handshakes', async () => {
    const service = provider(
      new ScriptedConnection([{ session: { id: 'session-1' }, type: 'not-session-created' }]),
    );
    await expect(
      service.connect({ ...config, model: { model: 'x', provider: 'other' } }),
    ).rejects.toMatchObject({ code: 'openai_realtime_provider_mismatch' });
    await expect(service.connect(config)).rejects.toMatchObject({
      code: 'openai_realtime_handshake_malformed',
    });
  });

  it('maps optional configuration, text output, and response edge cases', async () => {
    const connection = new ScriptedConnection(
      [
        { session: { id: 'session-2' }, type: 'session.created' },
        { note: 'buffered', type: 'provider.notice' },
        { session: { id: 'session-2' }, type: 'session.updated' },
        { audio_end_ms: 50, item_id: 'user-2', type: 'input_audio_buffer.speech_stopped' },
        {
          delta: '',
          item_id: 'user-2',
          type: 'conversation.item.input_audio_transcription.delta',
        },
        { delta: 'Text', response_id: 'response-2', type: 'response.output_text.delta' },
        {
          item_id: 'assistant-2',
          response_id: 'response-2',
          text: 'Text only',
          type: 'response.output_text.done',
        },
        {
          response: { id: 'response-2', status: 'incomplete', usage: {} },
          type: 'response.done',
        },
        { error: { message: 'Try later.', type: 'server_error' }, type: 'error' },
      ],
      { code: 1_000, type: 'closed' },
    );
    const service = createOpenAIRealtimeVoiceProvider({
      idGenerator: () => 'event',
      now: () => new Date('2026-08-08T12:00:00.000Z'),
      transcriptionModel: 'gpt-transcribe',
      transport: { connect: () => Promise.resolve(connection) },
    });
    const edgeConfig: RealtimeVoiceSessionConfig = {
      inputAudio: { encoding: 'g711_alaw', mimeType: 'audio/pcma' },
      inputTranscription: false,
      model: config.model,
      outputAudio: { encoding: 'pcm16', mimeType: 'audio/pcm' },
      turnDetection: {
        createResponse: false,
        interruptResponse: false,
        prefixPaddingMs: 0,
        silenceDurationMs: 250,
        threshold: 0,
        type: 'server_vad',
      },
    };

    expect(await service.capabilities(config.model)).toMatchObject({ clientSecrets: true });
    const events = await collect((await service.connect(edgeConfig)).events());
    expect(connection.sent[0]).toMatchObject({
      session: {
        audio: {
          input: {
            format: { type: 'audio/pcma' },
            turn_detection: {
              create_response: false,
              interrupt_response: false,
              prefix_padding_ms: 0,
              silence_duration_ms: 250,
              threshold: 0,
              type: 'server_vad',
            },
          },
          output: { format: { rate: 24_000, type: 'audio/pcm' } },
        },
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      'realtime.session.started',
      'realtime.input_audio.stopped',
      'realtime.output_transcript.delta',
      'realtime.output_transcript.completed',
      'realtime.conversation.message_committed',
      'realtime.response.failed',
      'realtime.operation.failed',
      'realtime.session.closed',
    ]);
    expect(events[1]).not.toHaveProperty('audioDurationMs');
    expect(events[6]).toMatchObject({ error: { retryable: true } });
  });

  it('maps transport termination and client closure', async () => {
    const failedConnection = new ScriptedConnection(
      [
        { session: { id: 'session-3' }, type: 'session.created' },
        { session: { id: 'session-3' }, type: 'session.updated' },
      ],
      {
        error: new AiError('transport', 'socket failed', {
          code: 'socket_failed',
          retryable: true,
        }),
        type: 'error',
      },
    );
    const failed = await collect((await provider(failedConnection).connect(config)).events());
    expect(failed.at(-1)).toMatchObject({
      error: { code: 'socket_failed' },
      type: 'realtime.session.failed',
    });

    const closedConnection = new ScriptedConnection(
      [
        { session: { id: 'session-4' }, type: 'session.created' },
        { session: { id: 'session-4' }, type: 'session.updated' },
      ],
      { code: 1_000, type: 'closed' },
    );
    const session = await provider(closedConnection).connect(config);
    await session.close();
    await session.close();
    const closed = await collect(session.events());
    expect(closed.at(-1)).toMatchObject({
      reason: 'client_closed',
      type: 'realtime.session.closed',
    });
    expect(closedConnection.close).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid construction, capability queries, and handshake closure', async () => {
    expect(
      () =>
        new OpenAIRealtimeVoiceProvider({
          handshakeTimeoutMs: 0,
          transport: { connect: vi.fn() },
        }),
    ).toThrow(expect.objectContaining({ code: 'openai_realtime_handshake_timeout_invalid' }));

    const service = provider(new ScriptedConnection([]));
    expect(() => service.capabilities({ model: 'x', provider: 'other' })).toThrow(
      expect.objectContaining({ code: 'openai_realtime_provider_mismatch' }),
    );

    const closed = new ScriptedConnection(
      [{ session: { id: 'session-5' }, type: 'session.created' }],
      { code: 1_006, type: 'closed' },
    );
    await expect(provider(closed).connect(config)).rejects.toMatchObject({
      code: 'openai_realtime_handshake_malformed',
    });
    expect(closed.close).toHaveBeenCalledWith(1_011, 'handshake failed');
  });
});

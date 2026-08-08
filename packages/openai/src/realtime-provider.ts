import {
  AiError,
  GuardedRealtimeVoiceSession,
  serializeAiError,
  type CallOptions,
  type JsonObject,
  type JsonValue,
  type RealtimeAudioChunk,
  type RealtimeVoiceCapabilities,
  type RealtimeVoiceEvent,
  type RealtimeVoiceProvider,
  type RealtimeVoiceSession,
  type RealtimeVoiceSessionConfig,
  type RealtimeVoiceSessionState,
  type ToolResultPart,
  type Usage,
  validateRealtimeVoiceConfig,
} from '@maduser/ai-ts';

import {
  mapAudioFormat,
  mapTranscription,
  mapTurnDetection,
  sdkAudioFormat,
} from './realtime-client-secret.js';
import type {
  OpenAIRealtimeTransport,
  OpenAIRealtimeTransportConnection,
  OpenAIRealtimeTransportEvent,
} from './realtime-transport.js';

const capabilities: RealtimeVoiceCapabilities = {
  clientSecrets: true,
  inputAudioEncodings: ['pcm16', 'g711_alaw', 'g711_ulaw'],
  interruption: true,
  manualCommit: true,
  maxAudioChunkBytes: 15 * 1_024 * 1_024,
  outputAudioEncodings: ['pcm16', 'g711_alaw', 'g711_ulaw'],
  serverVad: true,
  textInput: true,
  toolCalls: true,
};

type RealtimeEventInput<T = RealtimeVoiceEvent> = T extends RealtimeVoiceEvent
  ? Omit<T, 'eventId' | 'occurredAt' | 'sequence' | 'sessionId'>
  : never;

export interface OpenAIRealtimeVoiceProviderOptions {
  readonly handshakeTimeoutMs?: number;
  readonly idGenerator?: () => string;
  readonly now?: () => Date;
  readonly transcriptionModel?: string;
  readonly transport: OpenAIRealtimeTransport;
}

export class OpenAIRealtimeVoiceProvider implements RealtimeVoiceProvider {
  readonly #handshakeTimeoutMs: number;
  readonly #idGenerator: () => string;
  readonly #now: () => Date;
  readonly #transcriptionModel: string;
  readonly #transport: OpenAIRealtimeTransport;

  public constructor(options: OpenAIRealtimeVoiceProviderOptions) {
    this.#transport = options.transport;
    this.#handshakeTimeoutMs = positiveTimeout(options.handshakeTimeoutMs ?? 10_000);
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#now = options.now ?? (() => new Date());
    this.#transcriptionModel = options.transcriptionModel ?? 'gpt-4o-mini-transcribe';
  }

  public capabilities(
    model: RealtimeVoiceSessionConfig['model'],
  ): Promise<RealtimeVoiceCapabilities> {
    assertOpenAIModel(model.provider);
    return Promise.resolve(capabilities);
  }

  public async connect(
    config: RealtimeVoiceSessionConfig,
    options: CallOptions = {},
  ): Promise<RealtimeVoiceSession> {
    assertOpenAIModel(config.model.provider);
    validateRealtimeVoiceConfig(config, capabilities);
    const connection = await this.#transport.connect({ model: config.model.model }, options);
    const iterator = connection.events()[Symbol.asyncIterator]();
    try {
      const deadline =
        Date.now() + Math.min(this.#handshakeTimeoutMs, options.timeoutMs ?? Infinity);
      const created = await nextHandshakeMessage(iterator, deadline, options.signal);
      if (created['type'] !== 'session.created') {
        throw malformedHandshake('OpenAI realtime did not start with session.created.');
      }
      const sessionId = nestedString(created, 'session', 'id');
      connection.send(sessionUpdate(config, this.#transcriptionModel));
      const pending: OpenAIRealtimeTransportEvent[] = [];
      for (;;) {
        const event = await nextHandshakeEvent(iterator, deadline, options.signal);
        if (event.type === 'message' && event.message['type'] === 'session.updated') {
          break;
        }
        if (event.type !== 'message') {
          throw handshakeTransportError(event);
        }
        pending.push(event);
      }
      const raw = new OpenAIRealtimeSession({
        config,
        connection,
        idGenerator: this.#idGenerator,
        iterator,
        now: this.#now,
        pending,
        sessionId,
      });
      return new GuardedRealtimeVoiceSession({ capabilities, config, session: raw });
    } catch (error) {
      connection.close(1_011, 'handshake failed');
      throw error;
    }
  }
}

export function createOpenAIRealtimeVoiceProvider(
  options: OpenAIRealtimeVoiceProviderOptions,
): RealtimeVoiceProvider {
  return new OpenAIRealtimeVoiceProvider(options);
}

interface SessionOptions {
  readonly config: RealtimeVoiceSessionConfig;
  readonly connection: OpenAIRealtimeTransportConnection;
  readonly idGenerator: () => string;
  readonly iterator: AsyncIterator<OpenAIRealtimeTransportEvent>;
  readonly now: () => Date;
  readonly pending: readonly OpenAIRealtimeTransportEvent[];
  readonly sessionId: string;
}

class OpenAIRealtimeSession implements RealtimeVoiceSession {
  readonly #config: RealtimeVoiceSessionConfig;
  readonly #connection: OpenAIRealtimeTransportConnection;
  readonly #idGenerator: () => string;
  readonly #iterator: AsyncIterator<OpenAIRealtimeTransportEvent>;
  readonly #now: () => Date;
  readonly #pending: readonly OpenAIRealtimeTransportEvent[];
  readonly #speechStarts = new Map<string, number>();
  #activeResponseId: string | undefined;
  #closeRequested = false;
  #eventsClaimed = false;
  #sequence = 0;
  #state: RealtimeVoiceSessionState = 'open';

  public readonly id: string;

  public constructor(options: SessionOptions) {
    this.id = options.sessionId;
    this.#config = options.config;
    this.#connection = options.connection;
    this.#idGenerator = options.idGenerator;
    this.#iterator = options.iterator;
    this.#now = options.now;
    this.#pending = options.pending;
  }

  public get state(): RealtimeVoiceSessionState {
    return this.#state;
  }

  public sendAudio(chunk: RealtimeAudioChunk): Promise<void> {
    this.#connection.send({
      audio: Buffer.from(chunk.bytes).toString('base64'),
      type: 'input_audio_buffer.append',
    });
    return Promise.resolve();
  }

  public sendText(text: string): Promise<void> {
    this.#connection.send({
      item: { content: [{ text, type: 'input_text' }], role: 'user', type: 'message' },
      type: 'conversation.item.create',
    });
    this.#connection.send({ type: 'response.create' });
    return Promise.resolve();
  }

  public commitInput(): Promise<void> {
    this.#connection.send({ type: 'input_audio_buffer.commit' });
    this.#connection.send({ type: 'response.create' });
    return Promise.resolve();
  }

  public interrupt(): Promise<void> {
    this.#connection.send({
      ...(this.#activeResponseId === undefined ? {} : { response_id: this.#activeResponseId }),
      type: 'response.cancel',
    });
    return Promise.resolve();
  }

  public sendToolResult(result: ToolResultPart): Promise<void> {
    this.#connection.send({
      item: {
        call_id: result.callId,
        output: JSON.stringify(result),
        type: 'function_call_output',
      },
      type: 'conversation.item.create',
    });
    this.#connection.send({ type: 'response.create' });
    return Promise.resolve();
  }

  public close(): Promise<void> {
    if (!this.#closeRequested) {
      this.#closeRequested = true;
      this.#state = 'closing';
      this.#connection.close();
    }
    return Promise.resolve();
  }

  public events(): AsyncIterable<RealtimeVoiceEvent> {
    if (this.#eventsClaimed) {
      throw new AiError('invalid_request', 'OpenAI realtime session events are already claimed.', {
        code: 'openai_realtime_session_events_claimed',
      });
    }
    this.#eventsClaimed = true;
    return this.#events();
  }

  async *#events(): AsyncGenerator<RealtimeVoiceEvent> {
    yield this.#event({ config: this.#config, type: 'realtime.session.started' });
    for (const event of this.#pending) {
      yield* this.#mapTransportEvent(event);
      if (this.#state === 'closed' || this.#state === 'failed') return;
    }
    for (;;) {
      const next = await this.#iterator.next();
      if (next.done) {
        this.#state = 'failed';
        yield this.#event({
          error: serializeAiError(malformedHandshake('OpenAI realtime transport ended silently.')),
          recoverable: true,
          type: 'realtime.session.failed',
        });
        return;
      }
      yield* this.#mapTransportEvent(next.value);
      if (this.#state === 'closed' || this.#state === 'failed') return;
    }
  }

  *#mapTransportEvent(event: OpenAIRealtimeTransportEvent): Generator<RealtimeVoiceEvent> {
    if (event.type === 'error') {
      this.#state = 'failed';
      yield this.#event({
        error: serializeAiError(event.error),
        recoverable: true,
        type: 'realtime.session.failed',
      });
      return;
    }
    if (event.type === 'closed') {
      this.#state = 'closed';
      yield this.#event({
        reason: this.#closeRequested ? 'client_closed' : 'provider_closed',
        type: 'realtime.session.closed',
      });
      return;
    }
    try {
      yield* this.#mapMessage(event.message);
    } catch (error) {
      this.#state = 'failed';
      const normalized =
        error instanceof AiError
          ? error
          : new AiError('malformed_response', 'OpenAI realtime event mapping failed.', {
              cause: error,
              code: 'openai_realtime_event_mapping_failed',
            });
      yield this.#event({
        error: serializeAiError(normalized),
        recoverable: false,
        type: 'realtime.session.failed',
      });
    }
  }

  *#mapMessage(message: JsonObject): Generator<RealtimeVoiceEvent> {
    const type = optionalString(message['type']);
    if (type === 'input_audio_buffer.speech_started') {
      const itemId = requiredString(message, 'item_id');
      const start = requiredNumber(message, 'audio_start_ms');
      this.#speechStarts.set(itemId, start);
      yield this.#event({ itemId, type: 'realtime.input_audio.started' });
    } else if (type === 'input_audio_buffer.speech_stopped') {
      const itemId = requiredString(message, 'item_id');
      const end = requiredNumber(message, 'audio_end_ms');
      const start = this.#speechStarts.get(itemId);
      yield this.#event({
        ...(start === undefined ? {} : { audioDurationMs: Math.max(0, end - start) }),
        itemId,
        type: 'realtime.input_audio.stopped',
      });
    } else if (type === 'conversation.item.input_audio_transcription.delta') {
      const delta = optionalString(message['delta']);
      if (delta !== undefined && delta.length > 0) {
        yield this.#event({
          delta,
          itemId: requiredString(message, 'item_id'),
          type: 'realtime.input_transcript.delta',
        });
      }
    } else if (type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = requiredString(message, 'item_id');
      const transcript = requiredString(message, 'transcript');
      yield this.#event({ itemId, transcript, type: 'realtime.input_transcript.completed' });
      yield this.#messageEvent(itemId, 'user', transcript, 'transcribed');
    } else if (type === 'response.created') {
      const responseId = nestedString(message, 'response', 'id');
      this.#activeResponseId = responseId;
      yield this.#event({ responseId, type: 'realtime.response.started' });
    } else if (type === 'response.output_audio.delta') {
      yield this.#event({
        chunk: { bytes: decodeBase64(requiredString(message, 'delta')) },
        responseId: requiredString(message, 'response_id'),
        type: 'realtime.output_audio.delta',
      });
    } else if (type === 'response.output_audio.done') {
      yield this.#event({
        responseId: requiredString(message, 'response_id'),
        type: 'realtime.output_audio.completed',
      });
    } else if (
      type === 'response.output_audio_transcript.delta' ||
      type === 'response.output_text.delta'
    ) {
      yield this.#event({
        delta: requiredString(message, 'delta'),
        responseId: requiredString(message, 'response_id'),
        type: 'realtime.output_transcript.delta',
      });
    } else if (
      type === 'response.output_audio_transcript.done' ||
      type === 'response.output_text.done'
    ) {
      const responseId = requiredString(message, 'response_id');
      const transcript = requiredString(
        message,
        type === 'response.output_text.done' ? 'text' : 'transcript',
      );
      const itemId = requiredString(message, 'item_id');
      yield this.#event({ responseId, transcript, type: 'realtime.output_transcript.completed' });
      yield this.#messageEvent(itemId, 'assistant', transcript, 'generated', responseId);
    } else if (type === 'response.function_call_arguments.done') {
      const responseId = requiredString(message, 'response_id');
      yield this.#event({
        call: {
          arguments: parseJsonObject(requiredString(message, 'arguments')),
          id: requiredString(message, 'call_id'),
          name: requiredString(message, 'name'),
        },
        responseId,
        type: 'realtime.tool_call.proposed',
      });
    } else if (type === 'response.done') {
      yield* this.#responseDone(message);
    } else if (type === 'error') {
      const operationId = nestedOptionalString(message, 'error', 'event_id');
      yield this.#event({
        error: serializeAiError(providerError(message)),
        ...(operationId === undefined ? {} : { operationId }),
        recoverable: true,
        type: 'realtime.operation.failed',
      });
    }
  }

  *#responseDone(message: JsonObject): Generator<RealtimeVoiceEvent> {
    const response = requiredObject(message, 'response');
    const responseId = requiredString(response, 'id');
    const usage = mapUsage(response['usage']);
    if (usage !== undefined) {
      yield this.#event({ type: 'realtime.usage.updated', usage });
    }
    const status = optionalString(response['status']);
    if (status === 'cancelled') {
      yield this.#event({ responseId, type: 'realtime.response.interrupted' });
    } else if (status === 'failed' || status === 'incomplete') {
      yield this.#event({
        error: serializeAiError(responseError(status)),
        recoverable: true,
        responseId,
        type: 'realtime.response.failed',
      });
    }
    if (this.#activeResponseId === responseId) this.#activeResponseId = undefined;
  }

  #messageEvent(
    id: string,
    role: 'assistant' | 'user',
    text: string,
    source: 'generated' | 'transcribed',
    responseId?: string,
  ): RealtimeVoiceEvent {
    return this.#event({
      message: {
        content: [{ source, text, type: 'text' }],
        conversationId: this.#config.conversationId ?? this.id,
        createdAt: this.#now().toISOString(),
        id,
        ...(responseId === undefined ? {} : { metadata: { responseId } }),
        role,
      },
      type: 'realtime.conversation.message_committed',
    });
  }

  #event(event: RealtimeEventInput): RealtimeVoiceEvent {
    return {
      ...event,
      eventId: this.#idGenerator(),
      occurredAt: this.#now().toISOString(),
      sequence: this.#sequence++,
      sessionId: this.id,
    };
  }
}

function sessionUpdate(
  config: RealtimeVoiceSessionConfig,
  defaultTranscription: string,
): JsonObject {
  const transcription = mapTranscription(config, defaultTranscription);
  return jsonObject({
    session: {
      audio: {
        input: {
          format: sdkAudioFormat(
            mapAudioFormat(
              config.inputAudio.channels,
              config.inputAudio.encoding,
              config.inputAudio.sampleRateHz,
            ),
          ),
          ...(transcription === undefined || transcription === false ? {} : { transcription }),
          turn_detection: mapTurnDetection(config.turnDetection),
        },
        output: {
          format: sdkAudioFormat(
            mapAudioFormat(
              config.outputAudio.channels,
              config.outputAudio.encoding,
              config.outputAudio.sampleRateHz,
            ),
          ),
          ...(config.voice === undefined ? {} : { voice: config.voice }),
        },
      },
      ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
      model: config.model.model,
      output_modalities: ['audio'],
      type: 'realtime',
    },
    type: 'session.update',
  });
}

async function nextHandshakeMessage(
  iterator: AsyncIterator<OpenAIRealtimeTransportEvent>,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<JsonObject> {
  const event = await nextHandshakeEvent(iterator, deadline, signal);
  if (event.type !== 'message') throw handshakeTransportError(event);
  return event.message;
}

async function nextHandshakeEvent(
  iterator: AsyncIterator<OpenAIRealtimeTransportEvent>,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<OpenAIRealtimeTransportEvent> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw handshakeTimeout();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        error instanceof Error
          ? error
          : new AiError('transport', 'OpenAI realtime handshake failed.', {
              cause: error,
              code: 'openai_realtime_handshake_failed',
            }),
      );
    };
    const succeed = (event: OpenAIRealtimeTransportEvent): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(event);
    };
    const abort = (): void => {
      fail(
        new AiError('cancelled', 'Realtime handshake cancelled.', {
          code: 'openai_realtime_handshake_cancelled',
        }),
      );
    };
    const timer = setTimeout(() => {
      fail(handshakeTimeout());
    }, remaining);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted === true) {
      abort();
      return;
    }
    void iterator.next().then((result) => {
      if (result.done) fail(malformedHandshake('Realtime transport ended during handshake.'));
      else succeed(result.value);
    }, fail);
  });
}

function handshakeTransportError(
  event: Exclude<OpenAIRealtimeTransportEvent, { type: 'message' }>,
): AiError {
  return event.type === 'error'
    ? event.error
    : malformedHandshake(
        `Realtime transport closed during handshake (${String(event.code ?? 0)}).`,
      );
}

function handshakeTimeout(): AiError {
  return new AiError('timeout', 'OpenAI realtime handshake timed out.', {
    code: 'openai_realtime_handshake_timeout',
    retryable: true,
  });
}

function malformedHandshake(message: string): AiError {
  return new AiError('malformed_response', message, {
    code: 'openai_realtime_handshake_malformed',
  });
}

function providerError(message: JsonObject): AiError {
  const error = requiredObject(message, 'error');
  const type = optionalString(error['type']);
  return new AiError(
    type === 'server_error' ? 'provider_unavailable' : 'invalid_request',
    optionalString(error['message']) ?? 'OpenAI realtime operation failed.',
    {
      code: optionalString(error['code']) ?? 'openai_realtime_operation_failed',
      retryable: type === 'server_error',
    },
  );
}

function responseError(status: string): AiError {
  return new AiError('provider_unavailable', `OpenAI realtime response ${status}.`, {
    code: `openai_realtime_response_${status}`,
    retryable: true,
  });
}

function mapUsage(value: JsonValue | undefined): Usage | undefined {
  if (!isObject(value)) return undefined;
  const inputTokens = optionalNumber(value['input_tokens']);
  const outputTokens = optionalNumber(value['output_tokens']);
  const inputDetails = isObject(value['input_token_details'])
    ? value['input_token_details']
    : undefined;
  const outputDetails = isObject(value['output_token_details'])
    ? value['output_token_details']
    : undefined;
  const audioInputTokens = optionalNumber(inputDetails?.['audio_tokens']);
  const audioOutputTokens = optionalNumber(outputDetails?.['audio_tokens']);
  const usage: Usage = {
    ...(audioInputTokens === undefined ? {} : { audioInputTokens }),
    ...(audioOutputTokens === undefined ? {} : { audioOutputTokens }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function decodeBase64(value: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) {
    throw new AiError('malformed_response', 'OpenAI realtime audio delta is invalid Base64.', {
      code: 'openai_realtime_audio_base64_invalid',
    });
  }
  return new Uint8Array(bytes);
}

function parseJsonObject(value: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new AiError('malformed_response', 'OpenAI realtime tool arguments are invalid JSON.', {
      cause,
      code: 'openai_realtime_tool_arguments_invalid',
    });
  }
  if (!isObject(parsed) || !Object.values(parsed).every(isJsonValue)) {
    throw new AiError(
      'malformed_response',
      'OpenAI realtime tool arguments must be a JSON object.',
      { code: 'openai_realtime_tool_arguments_invalid' },
    );
  }
  return parsed;
}

function isJsonValue(value: unknown): value is JsonValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) && value.every(isJsonValue)) ||
    (isObject(value) && Object.values(value).every(isJsonValue))
  );
}

function jsonObject(value: unknown): JsonObject {
  if (!isObject(value) || !Object.values(value).every(isJsonValue)) {
    throw new AiError('invalid_request', 'OpenAI realtime session mapping is not JSON safe.', {
      code: 'openai_realtime_session_mapping_invalid',
    });
  }
  return value;
}

function nestedString(value: JsonObject, objectKey: string, key: string): string {
  return requiredString(requiredObject(value, objectKey), key);
}
function nestedOptionalString(
  value: JsonObject,
  objectKey: string,
  key: string,
): string | undefined {
  const nested = value[objectKey];
  return isObject(nested) ? optionalString(nested[key]) : undefined;
}
function requiredObject(value: JsonObject, key: string): JsonObject {
  const item = value[key];
  if (!isObject(item)) throw malformedHandshake(`OpenAI realtime field ${key} is missing.`);
  return item;
}
function requiredString(value: JsonObject, key: string): string {
  const item = optionalString(value[key]);
  if (item === undefined || item.length === 0)
    throw malformedHandshake(`OpenAI realtime field ${key} is missing.`);
  return item;
}
function requiredNumber(value: JsonObject, key: string): number {
  const item = optionalNumber(value[key]);
  if (item === undefined) throw malformedHandshake(`OpenAI realtime field ${key} is missing.`);
  return item;
}
function optionalString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function optionalNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function assertOpenAIModel(provider: string): void {
  if (provider !== 'openai')
    throw new AiError('invalid_request', 'Realtime model is not owned by OpenAI.', {
      code: 'openai_realtime_provider_mismatch',
      details: { provider },
    });
}
function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new AiError('invalid_request', 'OpenAI realtime handshake timeout is invalid.', {
      code: 'openai_realtime_handshake_timeout_invalid',
    });
  return value;
}

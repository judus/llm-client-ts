import { AiError } from './error.js';
import type {
  RealtimeAudioChunk,
  RealtimeVoiceCapabilities,
  RealtimeVoiceEvent,
  RealtimeVoiceSession,
  RealtimeVoiceSessionConfig,
  RealtimeVoiceSessionState,
} from './realtime-voice-types.js';
import type { ToolResultPart } from './content.js';

export interface GuardedRealtimeVoiceSessionOptions {
  readonly capabilities: RealtimeVoiceCapabilities;
  readonly config: RealtimeVoiceSessionConfig;
  readonly session: RealtimeVoiceSession;
}

/** Enforces portable realtime lifecycle and capability invariants around a provider session. */
export class GuardedRealtimeVoiceSession implements RealtimeVoiceSession {
  readonly #capabilities: RealtimeVoiceCapabilities;
  readonly #session: RealtimeVoiceSession;
  #closePromise: Promise<void> | undefined;
  #eventsClaimed = false;
  #state: RealtimeVoiceSessionState = 'open';

  public constructor(options: GuardedRealtimeVoiceSessionOptions) {
    validateRealtimeVoiceConfig(options.config, options.capabilities);
    this.#capabilities = options.capabilities;
    this.#session = options.session;
    if (options.session.id.trim().length === 0) {
      throw new AiError('invalid_request', 'Realtime provider session ID cannot be empty.', {
        code: 'realtime_session_id_invalid',
      });
    }
    if (options.session.state !== 'open') {
      throw new AiError('invalid_request', 'Realtime provider session must initially be open.', {
        code: 'realtime_session_not_open',
      });
    }
  }

  public get id(): string {
    return this.#session.id;
  }

  public get state(): RealtimeVoiceSessionState {
    return this.#state;
  }

  public sendAudio(chunk: RealtimeAudioChunk): Promise<void> {
    this.#assertOpen();
    validateAudioChunk(chunk, this.#capabilities.maxAudioChunkBytes);
    return this.#session.sendAudio(chunk);
  }

  public sendText(text: string): Promise<void> {
    this.#assertOpen();
    if (!this.#capabilities.textInput) {
      return Promise.reject(unsupported('text input'));
    }
    if (text.trim().length === 0) {
      return Promise.reject(invalidOperation('Realtime text input cannot be empty.'));
    }
    return this.#session.sendText(text);
  }

  public commitInput(): Promise<void> {
    this.#assertOpen();
    if (!this.#capabilities.manualCommit) {
      return Promise.reject(unsupported('manual input commit'));
    }
    return this.#session.commitInput();
  }

  public interrupt(): Promise<void> {
    this.#assertOpen();
    if (!this.#capabilities.interruption) {
      return Promise.reject(unsupported('response interruption'));
    }
    return this.#session.interrupt();
  }

  public sendToolResult(result: ToolResultPart): Promise<void> {
    this.#assertOpen();
    if (!this.#capabilities.toolCalls) {
      return Promise.reject(unsupported('tool results'));
    }
    return this.#session.sendToolResult(result);
  }

  public events(): AsyncIterable<RealtimeVoiceEvent> {
    if (this.#eventsClaimed) {
      throw invalidOperation('Realtime events can only be consumed once.');
    }
    this.#eventsClaimed = true;
    return this.#validatedEvents();
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    if (this.#state === 'closed') {
      return Promise.resolve();
    }
    this.#state = 'closing';
    this.#closePromise = Promise.resolve()
      .then(() => this.#session.close())
      .then(
        () => {
          this.#state = 'closed';
        },
        (error: unknown) => {
          this.#state = 'failed';
          throw normalizeSessionError(error, 'close');
        },
      );
    return this.#closePromise;
  }

  async *#validatedEvents(): AsyncGenerator<RealtimeVoiceEvent> {
    let expectedSequence = 0;
    let started = false;
    let terminal = false;
    try {
      for await (const event of this.#session.events()) {
        if (terminal) {
          throw malformedEvents('Realtime provider emitted an event after termination.');
        }
        if (event.sessionId !== this.id) {
          throw malformedEvents('Realtime event belongs to another session.');
        }
        if (event.sequence !== expectedSequence) {
          throw malformedEvents('Realtime event sequence is not contiguous.');
        }
        if (!started) {
          if (event.type !== 'realtime.session.started') {
            throw malformedEvents('Realtime event stream did not start with session.started.');
          }
          started = true;
        } else if (event.type === 'realtime.session.started') {
          throw malformedEvents('Realtime provider emitted session.started twice.');
        }
        expectedSequence += 1;
        if (event.type === 'realtime.session.closed' || event.type === 'realtime.session.failed') {
          terminal = true;
          this.#state = event.type === 'realtime.session.closed' ? 'closed' : 'failed';
        }
        yield event;
      }
      if (!terminal) {
        throw malformedEvents('Realtime event stream ended without a terminal event.');
      }
    } catch (error) {
      this.#state = 'failed';
      throw normalizeSessionError(error, 'events');
    }
  }

  #assertOpen(): void {
    if (this.#state !== 'open') {
      throw invalidOperation(`Realtime session is ${this.#state}.`);
    }
  }
}

export function validateRealtimeVoiceConfig(
  config: RealtimeVoiceSessionConfig,
  capabilities: RealtimeVoiceCapabilities,
): void {
  if (
    capabilities.maxAudioChunkBytes !== undefined &&
    (!Number.isSafeInteger(capabilities.maxAudioChunkBytes) || capabilities.maxAudioChunkBytes <= 0)
  ) {
    throw invalidOperation('Realtime maximum audio chunk size is invalid.');
  }
  if (config.model.provider.trim().length === 0 || config.model.model.trim().length === 0) {
    throw invalidOperation('Realtime model selector cannot be empty.');
  }
  validateAudioFormat(config.inputAudio, capabilities.inputAudioEncodings, 'input');
  validateAudioFormat(config.outputAudio, capabilities.outputAudioEncodings, 'output');
  if (config.turnDetection.type === 'manual' && !capabilities.manualCommit) {
    throw unsupported('manual turn detection');
  }
  if (config.turnDetection.type === 'server_vad') {
    if (!capabilities.serverVad) {
      throw unsupported('server VAD');
    }
    validateVad(config.turnDetection);
  }
  if (config.instructions?.trim().length === 0) {
    throw invalidOperation('Realtime instructions cannot be empty.');
  }
  if (config.voice?.trim().length === 0) {
    throw invalidOperation('Realtime voice cannot be empty.');
  }
}

function validateAudioFormat(
  format: RealtimeVoiceSessionConfig['inputAudio'],
  supported: readonly RealtimeVoiceSessionConfig['inputAudio']['encoding'][],
  direction: string,
): void {
  if (!supported.includes(format.encoding)) {
    throw unsupported(`${direction} audio encoding ${format.encoding}`);
  }
  if (format.mimeType.trim().length === 0) {
    throw invalidOperation(`Realtime ${direction} audio MIME type cannot be empty.`);
  }
  if (
    format.channels !== undefined &&
    (!Number.isSafeInteger(format.channels) || format.channels <= 0)
  ) {
    throw invalidOperation(`Realtime ${direction} audio channels are invalid.`);
  }
  if (
    format.sampleRateHz !== undefined &&
    (!Number.isSafeInteger(format.sampleRateHz) || format.sampleRateHz <= 0)
  ) {
    throw invalidOperation(`Realtime ${direction} audio sample rate is invalid.`);
  }
}

function validateVad(
  vad: Extract<RealtimeVoiceSessionConfig['turnDetection'], { type: 'server_vad' }>,
): void {
  if (
    vad.threshold !== undefined &&
    (!Number.isFinite(vad.threshold) || vad.threshold < 0 || vad.threshold > 1)
  ) {
    throw invalidOperation('Realtime VAD threshold must be between 0 and 1.');
  }
  for (const [name, value] of [
    ['prefixPaddingMs', vad.prefixPaddingMs],
    ['silenceDurationMs', vad.silenceDurationMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw invalidOperation(`Realtime VAD ${name} is invalid.`);
    }
  }
}

function validateAudioChunk(chunk: RealtimeAudioChunk, maxBytes: number | undefined): void {
  if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength === 0) {
    throw invalidOperation('Realtime audio chunk must contain bytes.');
  }
  if (maxBytes !== undefined && chunk.bytes.byteLength > maxBytes) {
    throw invalidOperation('Realtime audio chunk exceeds the provider limit.');
  }
  if (
    chunk.durationMs !== undefined &&
    (!Number.isFinite(chunk.durationMs) || chunk.durationMs < 0)
  ) {
    throw invalidOperation('Realtime audio chunk duration is invalid.');
  }
}

function unsupported(feature: string): AiError {
  return new AiError('unsupported_capability', `Realtime provider does not support ${feature}.`, {
    code: 'realtime_capability_unsupported',
    details: { feature },
  });
}

function invalidOperation(message: string): AiError {
  return new AiError('invalid_request', message, { code: 'realtime_operation_invalid' });
}

function malformedEvents(message: string): AiError {
  return new AiError('malformed_response', message, { code: 'realtime_event_protocol_invalid' });
}

function normalizeSessionError(error: unknown, operation: string): AiError {
  return error instanceof AiError
    ? error
    : new AiError('transport', `Realtime session ${operation} failed.`, {
        cause: error,
        code: 'realtime_session_transport_failed',
        details: { operation },
      });
}

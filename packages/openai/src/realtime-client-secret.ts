import {
  AiError,
  type CallOptions,
  type RealtimeAudioEncoding,
  type RealtimeClientSecret,
  type RealtimeClientSecretIssuer,
  type RealtimeTurnDetection,
  type RealtimeVoiceCapabilities,
  type RealtimeVoiceSessionConfig,
  validateRealtimeVoiceConfig,
} from '@maduser/ai-ts';
import OpenAI from 'openai';
import type { ClientSecretCreateParams } from 'openai/resources/realtime/client-secrets';
import type {
  RealtimeAudioFormats,
  RealtimeAudioInputTurnDetection,
} from 'openai/resources/realtime/realtime';

import type { OpenAIConnectionOptions } from './configuration.js';
import { mapOpenAIError } from './error-mapper.js';

const openAIRealtimeCapabilities: RealtimeVoiceCapabilities = {
  clientSecrets: true,
  inputAudioEncodings: ['pcm16', 'g711_alaw', 'g711_ulaw'],
  interruption: true,
  manualCommit: true,
  outputAudioEncodings: ['pcm16', 'g711_alaw', 'g711_ulaw'],
  serverVad: true,
  textInput: true,
  toolCalls: true,
};

export interface OpenAIRealtimeClientSecretOptions extends OpenAIConnectionOptions {
  /** Secret lifetime in seconds, from 10 through 7200. Defaults to 600. */
  readonly expiresAfterSeconds?: number;
  /** Default input-transcription model when transcription is enabled. */
  readonly transcriptionModel?: string;
}

export interface OpenAIRealtimeClientSecretTransportRequest {
  readonly expiresAfterSeconds: number;
  readonly inputAudioFormat: OpenAIRealtimeAudioFormat;
  readonly inputTranscription?: false | OpenAIRealtimeTranscriptionConfig;
  readonly instructions?: string;
  readonly model: string;
  readonly outputAudioFormat: OpenAIRealtimeAudioFormat;
  readonly turnDetection: RealtimeTurnDetection;
  readonly voice?: string;
}

export type OpenAIRealtimeAudioFormat = 'audio/pcma' | 'audio/pcm' | 'audio/pcmu';

export interface OpenAIRealtimeTranscriptionConfig {
  readonly language?: string;
  readonly model: string;
  readonly prompt?: string;
}

export interface OpenAIRealtimeClientSecretTransportResult {
  readonly expiresAtEpochSeconds: number;
  readonly sessionId: string;
  readonly value: string;
}

export interface OpenAIRealtimeClientSecretTransport {
  issue(
    request: OpenAIRealtimeClientSecretTransportRequest,
    options: CallOptions,
  ): Promise<OpenAIRealtimeClientSecretTransportResult>;
}

export interface OpenAIRealtimeClientSecretDependencies {
  readonly now: () => Date;
  readonly transport: OpenAIRealtimeClientSecretTransport;
}

/** Issues bounded OpenAI client secrets without exposing the server API key. */
export class OpenAIRealtimeClientSecretIssuer implements RealtimeClientSecretIssuer {
  readonly #expiresAfterSeconds: number;
  readonly #now: () => Date;
  readonly #transcriptionModel: string;
  readonly #transport: OpenAIRealtimeClientSecretTransport;

  public constructor(
    options: OpenAIRealtimeClientSecretOptions = {},
    dependencies: OpenAIRealtimeClientSecretDependencies = {
      now: () => new Date(),
      transport: new OpenAISdkRealtimeClientSecretTransport(options),
    },
  ) {
    this.#expiresAfterSeconds = expirySeconds(options.expiresAfterSeconds ?? 600);
    this.#now = dependencies.now;
    this.#transcriptionModel = nonEmptyTranscriptionModel(
      options.transcriptionModel ?? 'gpt-4o-mini-transcribe',
    );
    this.#transport = dependencies.transport;
  }

  public async issue(
    config: RealtimeVoiceSessionConfig,
    options: CallOptions = {},
  ): Promise<RealtimeClientSecret> {
    try {
      if (config.model.provider !== 'openai') {
        throw new AiError('invalid_request', 'Realtime model is not owned by OpenAI.', {
          code: 'openai_realtime_provider_mismatch',
          details: { provider: config.model.provider },
        });
      }
      validateRealtimeVoiceConfig(config, openAIRealtimeCapabilities);
      const inputTranscription = mapTranscription(config, this.#transcriptionModel);
      const result = await this.#transport.issue(
        {
          expiresAfterSeconds: this.#expiresAfterSeconds,
          inputAudioFormat: mapAudioFormat(
            config.inputAudio.channels,
            config.inputAudio.encoding,
            config.inputAudio.sampleRateHz,
          ),
          ...(inputTranscription === undefined ? {} : { inputTranscription }),
          ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
          model: config.model.model,
          outputAudioFormat: mapAudioFormat(
            config.outputAudio.channels,
            config.outputAudio.encoding,
            config.outputAudio.sampleRateHz,
          ),
          turnDetection: config.turnDetection,
          ...(config.voice === undefined ? {} : { voice: config.voice }),
        },
        options,
      );
      return normalizeSecret(result, this.#now());
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }
}

export class OpenAISdkRealtimeClientSecretTransport implements OpenAIRealtimeClientSecretTransport {
  readonly #client: OpenAI;

  public constructor(options: OpenAIConnectionOptions) {
    this.#client = new OpenAI({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.organization === undefined ? {} : { organization: options.organization }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
  }

  public async issue(
    request: OpenAIRealtimeClientSecretTransportRequest,
    options: CallOptions,
  ): Promise<OpenAIRealtimeClientSecretTransportResult> {
    const parameters: ClientSecretCreateParams = {
      expires_after: { anchor: 'created_at', seconds: request.expiresAfterSeconds },
      session: {
        audio: {
          input: {
            format: sdkAudioFormat(request.inputAudioFormat),
            ...(request.inputTranscription === undefined || request.inputTranscription === false
              ? {}
              : {
                  transcription: {
                    ...(request.inputTranscription.language === undefined
                      ? {}
                      : { language: request.inputTranscription.language }),
                    model: request.inputTranscription.model,
                    ...(request.inputTranscription.prompt === undefined
                      ? {}
                      : { prompt: request.inputTranscription.prompt }),
                  },
                }),
            turn_detection: mapTurnDetection(request.turnDetection),
          },
          output: {
            format: sdkAudioFormat(request.outputAudioFormat),
            ...(request.voice === undefined ? {} : { voice: request.voice }),
          },
        },
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
        model: request.model,
        output_modalities: ['audio'],
        type: 'realtime',
      },
    };
    const result = await this.#client.realtime.clientSecrets.create(parameters, {
      ...(options.idempotencyKey === undefined
        ? {}
        : { headers: { 'Idempotency-Key': options.idempotencyKey } }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    return {
      expiresAtEpochSeconds: result.expires_at,
      sessionId: result.session.id,
      value: result.value,
    };
  }
}

export function createOpenAIRealtimeClientSecretIssuer(
  options: OpenAIRealtimeClientSecretOptions = {},
): RealtimeClientSecretIssuer {
  return new OpenAIRealtimeClientSecretIssuer(options);
}

export function mapTranscription(
  config: RealtimeVoiceSessionConfig,
  defaultModel: string,
): false | OpenAIRealtimeTranscriptionConfig | undefined {
  if (config.inputTranscription === undefined || config.inputTranscription === false) {
    return config.inputTranscription;
  }
  const selector = config.inputTranscription.model;
  if (selector !== undefined && selector.provider !== 'openai') {
    throw new AiError('invalid_request', 'Realtime transcription model is not owned by OpenAI.', {
      code: 'openai_realtime_transcription_provider_mismatch',
      details: { provider: selector.provider },
    });
  }
  return {
    ...(config.inputTranscription.language === undefined
      ? {}
      : { language: config.inputTranscription.language }),
    model: selector?.model ?? defaultModel,
    ...(config.inputTranscription.prompt === undefined
      ? {}
      : { prompt: config.inputTranscription.prompt }),
  };
}

export function mapAudioFormat(
  channels: number | undefined,
  encoding: RealtimeAudioEncoding,
  sampleRateHz: number | undefined,
): OpenAIRealtimeAudioFormat {
  if (channels !== undefined && channels !== 1) {
    throw new AiError('unsupported_capability', 'OpenAI realtime requires mono audio.', {
      code: 'openai_realtime_channels_unsupported',
      details: { channels },
    });
  }
  if (encoding === 'pcm16') {
    if (sampleRateHz !== undefined && sampleRateHz !== 24_000) {
      throw new AiError('unsupported_capability', 'OpenAI realtime PCM requires 24 kHz audio.', {
        code: 'openai_realtime_sample_rate_unsupported',
        details: { sampleRateHz },
      });
    }
    return 'audio/pcm';
  }
  if (encoding === 'g711_alaw') {
    return 'audio/pcma';
  }
  if (encoding === 'g711_ulaw') {
    return 'audio/pcmu';
  }
  throw new AiError('unsupported_capability', `OpenAI realtime does not support ${encoding}.`, {
    code: 'openai_realtime_audio_encoding_unsupported',
    details: { encoding },
  });
}

export function sdkAudioFormat(type: OpenAIRealtimeAudioFormat): RealtimeAudioFormats {
  return type === 'audio/pcm' ? { rate: 24_000, type } : { type };
}

export function mapTurnDetection(
  turn: RealtimeTurnDetection,
): RealtimeAudioInputTurnDetection | null {
  return turn.type === 'manual'
    ? null
    : {
        ...(turn.createResponse === undefined ? {} : { create_response: turn.createResponse }),
        ...(turn.interruptResponse === undefined
          ? {}
          : { interrupt_response: turn.interruptResponse }),
        ...(turn.prefixPaddingMs === undefined ? {} : { prefix_padding_ms: turn.prefixPaddingMs }),
        ...(turn.silenceDurationMs === undefined
          ? {}
          : { silence_duration_ms: turn.silenceDurationMs }),
        ...(turn.threshold === undefined ? {} : { threshold: turn.threshold }),
        type: 'server_vad',
      };
}

function normalizeSecret(
  result: OpenAIRealtimeClientSecretTransportResult,
  now: Date,
): RealtimeClientSecret {
  const expiresAtMs = result.expiresAtEpochSeconds * 1_000;
  if (
    !Number.isFinite(now.getTime()) ||
    result.value.trim().length === 0 ||
    result.sessionId.trim().length === 0 ||
    !Number.isSafeInteger(result.expiresAtEpochSeconds) ||
    expiresAtMs <= now.getTime()
  ) {
    throw new AiError('malformed_response', 'OpenAI returned an invalid realtime client secret.', {
      code: 'openai_realtime_client_secret_malformed',
    });
  }
  return {
    expiresAt: new Date(expiresAtMs).toISOString(),
    provider: 'openai',
    sessionId: result.sessionId,
    value: result.value,
  };
}

function expirySeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 10 || value > 7_200) {
    throw new AiError(
      'invalid_request',
      'OpenAI realtime secret lifetime must be 10-7200 seconds.',
      {
        code: 'openai_realtime_client_secret_ttl_invalid',
        details: { expiresAfterSeconds: value },
      },
    );
  }
  return value;
}

function nonEmptyTranscriptionModel(value: string): string {
  if (value.trim().length === 0) {
    throw new AiError('invalid_request', 'OpenAI realtime transcription model cannot be empty.', {
      code: 'openai_realtime_value_empty',
      details: { name: 'transcription model' },
    });
  }
  return value;
}

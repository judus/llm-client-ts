import {
  AiError,
  type AudioPart,
  type SpeechSynthesis,
  type SpeechSynthesisProvider,
  type SpeechSynthesisRequest,
  type Transcription,
  type TranscriptionEvent,
  type TranscriptionProvider,
  type TranscriptionRequest,
  type Usage,
  type VoiceOperationOptions,
} from '../../index.js';

import type { OpenAIConnectionOptions } from './configuration.js';
import { mapOpenAIError } from './error-mapper.js';
import {
  OpenAISdkAudioTransport,
  type OpenAISpeechFormat,
  type OpenAISpeechTransport,
  type OpenAITranscriptionTransport,
  type OpenAITranscriptionTransportUsage,
} from './audio-transport.js';

const openAIMaxTranscriptionBytes = 25 * 1_024 * 1_024;
const openAIMaxSpeechCharacters = 4_096;

export interface OpenAITranscriptionProviderOptions extends OpenAIConnectionOptions {
  /** Maximum accepted audio bytes, capped at OpenAI's 25 MB request limit. */
  readonly maxInputBytes?: number;
  /** Transcription model. Defaults to gpt-transcribe. */
  readonly model?: string;
  /** Stream partial file-transcription events. Defaults to true. */
  readonly stream?: boolean;
}

export interface OpenAITranscriptionProviderDependencies {
  readonly transport: OpenAITranscriptionTransport;
}

/** Bounded file-transcription adapter for the composed voice runtime. */
export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly #maxInputBytes: number;
  readonly #model: string;
  readonly #stream: boolean;
  readonly #transport: OpenAITranscriptionTransport;

  public constructor(
    options: OpenAITranscriptionProviderOptions = {},
    dependencies: OpenAITranscriptionProviderDependencies = {
      transport: new OpenAISdkAudioTransport(options),
    },
  ) {
    this.#maxInputBytes = transcriptionByteLimit(options.maxInputBytes);
    this.#model = nonEmpty(options.model ?? 'gpt-transcribe', 'transcription model');
    this.#stream = options.stream ?? true;
    if (this.#stream && this.#model === 'whisper-1') {
      throw new AiError('invalid_request', 'whisper-1 does not support streamed transcription.', {
        code: 'openai_transcription_stream_unsupported',
        details: { model: this.#model },
      });
    }
    this.#transport = dependencies.transport;
  }

  public async *transcribe(
    request: TranscriptionRequest,
    options: VoiceOperationOptions = {},
  ): AsyncGenerator<TranscriptionEvent> {
    try {
      const audio = materializedAudio(request.audio, this.#maxInputBytes);
      const extension = transcriptionExtension(request.audio.mimeType);
      const language = normalizeLanguage(request.language);
      validateOptionalText(request.prompt, 'transcription prompt');
      const response = await this.#transport.transcribe(
        {
          audio,
          filename: `audio.${extension}`,
          ...(language === undefined ? {} : { language }),
          mimeType: request.audio.mimeType,
          model: this.#model,
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          stream: this.#stream,
        },
        options.signal === undefined ? {} : { signal: options.signal },
      );
      let completed = false;
      for await (const event of response.events) {
        if (completed) {
          throw malformedAudioResponse(
            'OpenAI transcription emitted an event after the final transcript.',
            'openai_transcription_event_after_completion',
          );
        }
        if (event.type === 'text_delta') {
          if (event.delta.length === 0) {
            throw malformedAudioResponse(
              'OpenAI transcription emitted an empty delta.',
              'openai_transcription_delta_empty',
            );
          }
          yield { delta: event.delta, type: 'transcription.text.delta' };
          continue;
        }
        const transcription = normalizeTranscription(
          event.text,
          event.languages,
          event.usage,
          language,
          request.audio.durationMs,
          this.#model,
          response.requestId,
        );
        completed = true;
        yield { transcription, type: 'transcription.completed' };
      }
      if (!completed) {
        throw malformedAudioResponse(
          'OpenAI transcription ended without a final transcript.',
          'openai_transcription_completion_missing',
        );
      }
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }
}

export interface OpenAISpeechSynthesisProviderOptions extends OpenAIConnectionOptions {
  /** Default style instructions; a request may override them. */
  readonly instructions?: string;
  /** Speech model. Defaults to gpt-4o-mini-tts. */
  readonly model?: string;
  /** Default output MIME type. Defaults to audio/mpeg. */
  readonly outputMimeType?: string;
  /** Default speech speed. */
  readonly speed?: number;
  /** Default voice. Defaults to alloy. */
  readonly voice?: string;
}

export interface OpenAISpeechSynthesisProviderDependencies {
  readonly transport: OpenAISpeechTransport;
}

/** Request-oriented OpenAI speech-generation adapter. */
export class OpenAISpeechSynthesisProvider implements SpeechSynthesisProvider {
  readonly #instructions: string | undefined;
  readonly #model: string;
  readonly #outputMimeType: string;
  readonly #speed: number | undefined;
  readonly #transport: OpenAISpeechTransport;
  readonly #voice: string;

  public constructor(
    options: OpenAISpeechSynthesisProviderOptions = {},
    dependencies: OpenAISpeechSynthesisProviderDependencies = {
      transport: new OpenAISdkAudioTransport(options),
    },
  ) {
    validateOptionalText(options.instructions, 'speech instructions');
    validateSpeed(options.speed);
    this.#instructions = options.instructions;
    this.#model = nonEmpty(options.model ?? 'gpt-4o-mini-tts', 'speech model');
    this.#outputMimeType = normalizeSpeechMimeType(options.outputMimeType ?? 'audio/mpeg');
    this.#speed = options.speed;
    this.#transport = dependencies.transport;
    this.#voice = nonEmpty(options.voice ?? 'alloy', 'speech voice');
  }

  public async synthesize(
    request: SpeechSynthesisRequest,
    options: VoiceOperationOptions = {},
  ): Promise<SpeechSynthesis> {
    try {
      const text = nonEmpty(request.text, 'speech input');
      const characters = countCharacters(text);
      if (characters > openAIMaxSpeechCharacters) {
        throw new AiError('invalid_request', 'OpenAI speech input exceeds 4096 characters.', {
          code: 'openai_speech_input_too_long',
          details: { characters, maxCharacters: openAIMaxSpeechCharacters },
        });
      }
      validateOptionalText(request.instructions, 'speech instructions');
      validateSpeed(request.speed);
      const mimeType = normalizeSpeechMimeType(request.outputMimeType ?? this.#outputMimeType);
      const format = speechFormat(mimeType);
      const instructions = request.instructions ?? this.#instructions;
      const speed = request.speed ?? this.#speed;
      const voice = nonEmpty(request.voice ?? this.#voice, 'speech voice');
      const response = await this.#transport.synthesize(
        {
          format,
          ...(instructions === undefined ? {} : { instructions }),
          model: this.#model,
          ...(speed === undefined ? {} : { speed }),
          text,
          voice,
        },
        options.signal === undefined ? {} : { signal: options.signal },
      );
      if (!(response.audio instanceof Uint8Array)) {
        throw malformedAudioResponse(
          'OpenAI speech generation returned non-binary audio.',
          'openai_speech_audio_invalid',
        );
      }
      if (response.audio.byteLength === 0) {
        throw malformedAudioResponse(
          'OpenAI speech generation returned empty audio.',
          'openai_speech_audio_empty',
        );
      }
      return {
        audio: {
          mimeType,
          source: { bytes: response.audio, type: 'bytes' },
          type: 'audio',
        },
        providerMetadata: {
          format,
          model: this.#model,
          ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
          voice,
        },
        usage: { characters },
      };
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }
}

/** Creates an OpenAI bounded transcription provider. */
export function createOpenAITranscriptionProvider(
  options: OpenAITranscriptionProviderOptions = {},
): TranscriptionProvider {
  return new OpenAITranscriptionProvider(options);
}

/** Creates an OpenAI speech-synthesis provider. */
export function createOpenAISpeechSynthesisProvider(
  options: OpenAISpeechSynthesisProviderOptions = {},
): SpeechSynthesisProvider {
  return new OpenAISpeechSynthesisProvider(options);
}

function normalizeTranscription(
  text: string,
  detectedLanguages: readonly string[] | undefined,
  providerUsage: OpenAITranscriptionTransportUsage | undefined,
  requestLanguage: string | undefined,
  requestDurationMs: number | undefined,
  model: string,
  requestId: string | undefined,
): Transcription {
  const normalizedText = nonEmpty(text, 'transcription text');
  const languages = validateDetectedLanguages(detectedLanguages);
  const usage = transcriptionUsage(providerUsage);
  const language = languages?.[0] ?? requestLanguage;
  const durationMs = providerUsage?.durationMs ?? requestDurationMs;
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(language === undefined ? {} : { language }),
    providerMetadata: {
      ...(languages === undefined ? {} : { detectedLanguages: languages }),
      model,
      ...(requestId === undefined ? {} : { requestId }),
    },
    text: normalizedText,
    usage,
  };
}

function transcriptionUsage(value: OpenAITranscriptionTransportUsage | undefined): Usage {
  if (value === undefined) {
    return {};
  }
  validateUsageValue(value.audioInputTokens, 'audioInputTokens', true);
  validateUsageValue(value.durationMs, 'durationMs', false);
  validateUsageValue(value.inputTokens, 'inputTokens', true);
  validateUsageValue(value.outputTokens, 'outputTokens', true);
  return {
    ...(value.audioInputTokens === undefined ? {} : { audioInputTokens: value.audioInputTokens }),
    ...(value.durationMs === undefined ? {} : { audioInputMs: value.durationMs }),
    ...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
    ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
  };
}

function materializedAudio(audio: AudioPart, maxBytes: number): Uint8Array {
  if (
    audio.durationMs !== undefined &&
    (!Number.isFinite(audio.durationMs) || audio.durationMs < 0)
  ) {
    throw new AiError('invalid_request', 'OpenAI transcription audio duration is invalid.', {
      code: 'openai_transcription_duration_invalid',
      details: { durationMs: audio.durationMs },
    });
  }
  if (audio.source.type !== 'bytes') {
    throw new AiError(
      'invalid_request',
      'OpenAI transcription audio must be materialized as bytes.',
      {
        code: 'openai_transcription_audio_not_materialized',
        details: { sourceType: audio.source.type },
      },
    );
  }
  if (audio.source.bytes.byteLength === 0) {
    throw new AiError('invalid_request', 'OpenAI transcription audio is empty.', {
      code: 'openai_transcription_audio_empty',
    });
  }
  if (audio.source.bytes.byteLength > maxBytes) {
    throw new AiError('invalid_request', 'OpenAI transcription audio exceeds the byte limit.', {
      code: 'openai_transcription_audio_too_large',
      details: { byteLength: audio.source.bytes.byteLength, maxBytes },
    });
  }
  return audio.source.bytes;
}

function transcriptionByteLimit(value: number | undefined): number {
  const resolved = value ?? openAIMaxTranscriptionBytes;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > openAIMaxTranscriptionBytes) {
    throw new AiError(
      'invalid_request',
      'OpenAI transcription maxInputBytes must be a positive integer no greater than 25 MB.',
      {
        code: 'openai_transcription_byte_limit_invalid',
        details: { maxInputBytes: resolved, providerLimit: openAIMaxTranscriptionBytes },
      },
    );
  }
  return resolved;
}

const transcriptionExtensions: Readonly<Record<string, string>> = {
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mpga': 'mpga',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
  'audio/x-wav': 'wav',
};

function transcriptionExtension(mimeType: string): string {
  const extension = transcriptionExtensions[mimeType.toLowerCase()];
  if (extension === undefined) {
    throw new AiError('unsupported_capability', `Unsupported OpenAI audio type: ${mimeType}.`, {
      code: 'openai_transcription_mime_type_unsupported',
      details: { mimeType },
    });
  }
  return extension;
}

const speechFormats: Readonly<Record<string, OpenAISpeechFormat>> = {
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'opus',
  'audio/opus': 'opus',
  'audio/pcm': 'pcm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

function normalizeSpeechMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  speechFormat(normalized);
  return normalized;
}

function speechFormat(mimeType: string): OpenAISpeechFormat {
  const format = speechFormats[mimeType];
  if (format === undefined) {
    throw new AiError('unsupported_capability', `Unsupported OpenAI speech type: ${mimeType}.`, {
      code: 'openai_speech_mime_type_unsupported',
      details: { mimeType },
    });
  }
  return format;
}

function normalizeLanguage(language: string | undefined): string | undefined {
  if (language !== undefined && !/^[A-Za-z]{2}$/u.test(language)) {
    throw new AiError('invalid_request', 'OpenAI transcription language must be ISO-639-1.', {
      code: 'openai_transcription_language_invalid',
      details: { language },
    });
  }
  return language?.toLowerCase();
}

function validateDetectedLanguages(value: readonly string[] | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.map((language) => {
    if (!/^[A-Za-z]{2}$/u.test(language)) {
      throw malformedAudioResponse(
        'OpenAI transcription returned an invalid language code.',
        'openai_transcription_language_malformed',
      );
    }
    return language.toLowerCase();
  });
}

function validateUsageValue(value: number | undefined, name: string, integer: boolean): void {
  if (
    value !== undefined &&
    (!Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value)))
  ) {
    throw malformedAudioResponse(
      `OpenAI transcription returned invalid ${name}.`,
      'openai_transcription_usage_malformed',
    );
  }
}

function validateOptionalText(value: string | undefined, name: string): void {
  if (value !== undefined) {
    nonEmpty(value, name);
  }
}

function validateSpeed(speed: number | undefined): void {
  if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.25 || speed > 4)) {
    throw new AiError('invalid_request', 'OpenAI speech speed must be between 0.25 and 4.', {
      code: 'openai_speech_speed_invalid',
      details: { speed },
    });
  }
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) {
    throw new AiError('invalid_request', `${name} cannot be empty.`, {
      code: 'openai_audio_text_empty',
      details: { name },
    });
  }
  return value;
}

function countCharacters(value: string): number {
  return value.length;
}

function malformedAudioResponse(message: string, code: string): AiError {
  return new AiError('malformed_response', message, { code });
}

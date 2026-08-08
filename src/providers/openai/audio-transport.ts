import OpenAI, { toFile } from 'openai';
import type {
  Transcription,
  TranscriptionStreamEvent,
} from 'openai/resources/audio/transcriptions';
import type { SpeechCreateParams } from 'openai/resources/audio/speech';

import type { OpenAIConnectionOptions } from './configuration.js';
import type { OpenAITransportCallOptions } from './transport.js';

export interface OpenAITranscriptionTransportRequest {
  readonly audio: Uint8Array;
  readonly filename: string;
  readonly language?: string;
  readonly mimeType: string;
  readonly model: string;
  readonly prompt?: string;
  readonly stream: boolean;
}

export type OpenAITranscriptionTransportEvent =
  | { readonly delta: string; readonly type: 'text_delta' }
  | {
      readonly languages?: readonly string[];
      readonly text: string;
      readonly type: 'completed';
      readonly usage?: OpenAITranscriptionTransportUsage;
    };

export interface OpenAITranscriptionTransportUsage {
  readonly audioInputTokens?: number;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface OpenAITranscriptionTransportResult {
  readonly events: AsyncIterable<OpenAITranscriptionTransportEvent>;
  readonly requestId?: string;
}

export interface OpenAITranscriptionTransport {
  transcribe(
    request: OpenAITranscriptionTransportRequest,
    options: OpenAITransportCallOptions,
  ): Promise<OpenAITranscriptionTransportResult>;
}

export type OpenAISpeechFormat = 'aac' | 'flac' | 'mp3' | 'opus' | 'pcm' | 'wav';

export interface OpenAISpeechTransportRequest {
  readonly format: OpenAISpeechFormat;
  readonly instructions?: string;
  readonly model: string;
  readonly speed?: number;
  readonly text: string;
  readonly voice: string;
}

export interface OpenAISpeechTransportResult {
  readonly audio: Uint8Array;
  readonly requestId?: string;
}

export interface OpenAISpeechTransport {
  synthesize(
    request: OpenAISpeechTransportRequest,
    options: OpenAITransportCallOptions,
  ): Promise<OpenAISpeechTransportResult>;
}

/** OpenAI SDK boundary for bounded transcription and speech generation. */
export class OpenAISdkAudioTransport
  implements OpenAISpeechTransport, OpenAITranscriptionTransport
{
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

  public async transcribe(
    request: OpenAITranscriptionTransportRequest,
    options: OpenAITransportCallOptions,
  ): Promise<OpenAITranscriptionTransportResult> {
    const file = await toFile(request.audio, request.filename, { type: request.mimeType });
    const common = {
      file,
      ...(request.language === undefined ? {} : { language: request.language }),
      model: request.model,
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    };
    if (request.stream) {
      const response = await this.#client.audio.transcriptions
        .create({ ...common, response_format: 'json', stream: true }, sdkAudioCallOptions(options))
        .withResponse();
      return {
        events: mapStream(response.data),
        ...(response.request_id === null ? {} : { requestId: response.request_id }),
      };
    }

    const response = await this.#client.audio.transcriptions
      .create({ ...common, response_format: 'json', stream: false }, sdkAudioCallOptions(options))
      .withResponse();
    return {
      events: singleTranscription(response.data),
      ...(response.request_id === null ? {} : { requestId: response.request_id }),
    };
  }

  public async synthesize(
    request: OpenAISpeechTransportRequest,
    options: OpenAITransportCallOptions,
  ): Promise<OpenAISpeechTransportResult> {
    const parameters: SpeechCreateParams = {
      input: request.text,
      ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
      model: request.model,
      response_format: request.format,
      ...(request.speed === undefined ? {} : { speed: request.speed }),
      voice: request.voice,
    };
    const response = await this.#client.audio.speech
      .create(parameters, sdkAudioCallOptions(options))
      .withResponse();
    return {
      audio: new Uint8Array(await response.data.arrayBuffer()),
      ...(response.request_id === null ? {} : { requestId: response.request_id }),
    };
  }
}

async function* mapStream(
  stream: AsyncIterable<TranscriptionStreamEvent>,
): AsyncGenerator<OpenAITranscriptionTransportEvent> {
  for await (const event of stream) {
    if (event.type === 'transcript.text.delta') {
      yield { delta: event.delta, type: 'text_delta' };
    } else if (event.type === 'transcript.text.done') {
      yield {
        ...(event.languages === undefined
          ? {}
          : { languages: event.languages.map(({ code }) => code) }),
        text: event.text,
        type: 'completed',
        ...(event.usage === undefined ? {} : { usage: mapTokenUsage(event.usage) }),
      };
    }
  }
}

async function* singleTranscription(
  transcription: Transcription,
): AsyncGenerator<OpenAITranscriptionTransportEvent> {
  await Promise.resolve();
  yield {
    ...(transcription.languages === undefined
      ? {}
      : { languages: transcription.languages.map(({ code }) => code) }),
    text: transcription.text,
    type: 'completed',
    ...(transcription.usage === undefined ? {} : { usage: mapUsage(transcription.usage) }),
  };
}

function mapUsage(usage: NonNullable<Transcription['usage']>): OpenAITranscriptionTransportUsage {
  return usage.type === 'duration'
    ? { durationMs: secondsToMilliseconds(usage.seconds) }
    : mapTokenUsage(usage);
}

function mapTokenUsage(usage: {
  readonly input_token_details?: { readonly audio_tokens?: number };
  readonly input_tokens: number;
  readonly output_tokens: number;
}): OpenAITranscriptionTransportUsage {
  return {
    ...(usage.input_token_details?.audio_tokens === undefined
      ? {}
      : { audioInputTokens: usage.input_token_details.audio_tokens }),
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
}

function secondsToMilliseconds(seconds: number): number {
  return Math.round(seconds * 1_000);
}

function sdkAudioCallOptions(options: OpenAITransportCallOptions): {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeout?: number;
} {
  return {
    ...(options.idempotencyKey === undefined
      ? {}
      : { headers: { 'Idempotency-Key': options.idempotencyKey } }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  };
}

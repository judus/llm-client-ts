import type { AudioPart } from './content.js';
import type { JsonObject } from './json.js';
import type { Usage } from './usage.js';

export interface TranscriptionRequest {
  readonly audio: AudioPart;
  readonly language?: string;
  readonly prompt?: string;
}

export type TranscriptionEvent =
  | { readonly delta: string; readonly type: 'transcription.text.delta' }
  | { readonly transcription: Transcription; readonly type: 'transcription.completed' };

export interface Transcription {
  readonly durationMs?: number;
  readonly language?: string;
  readonly providerMetadata?: JsonObject;
  readonly text: string;
  readonly usage: Usage;
}

export interface TranscriptionProvider {
  transcribe(
    request: TranscriptionRequest,
    options?: VoiceOperationOptions,
  ): AsyncIterable<TranscriptionEvent>;
}

export interface SpeechSynthesisOptions {
  readonly instructions?: string;
  readonly outputMimeType?: string;
  readonly speed?: number;
  readonly voice?: string;
}

export interface SpeechSynthesisRequest extends SpeechSynthesisOptions {
  readonly text: string;
}

export interface SpeechSynthesis {
  readonly audio: AudioPart;
  readonly providerMetadata?: JsonObject;
  readonly usage: Usage;
}

export interface SpeechSynthesisProvider {
  synthesize(
    request: SpeechSynthesisRequest,
    options?: VoiceOperationOptions,
  ): Promise<SpeechSynthesis>;
}

export interface VoiceOperationOptions {
  readonly signal?: AbortSignal;
}

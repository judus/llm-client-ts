import type { JsonObject, JsonValue } from './json.js';

/** A source for binary content. Exactly one source is selected by its discriminator. */
export type BinarySource =
  | { readonly bytes: Uint8Array; readonly type: 'bytes' }
  | { readonly artifactId: string; readonly type: 'artifact' }
  | { readonly type: 'url'; readonly url: string }
  | {
      readonly fileId: string;
      readonly provider: string;
      readonly type: 'provider_file';
    };

export interface TextPart {
  readonly source?: 'generated' | 'summarized' | 'transcribed' | 'typed';
  readonly text: string;
  readonly type: 'text';
}

/** A provider refusal kept distinct from ordinary generated text. */
export interface RefusalPart {
  readonly reason: string;
  readonly type: 'refusal';
}

export interface ImagePart {
  readonly detail?: 'auto' | 'high' | 'low';
  readonly mimeType: string;
  readonly source: BinarySource;
  readonly type: 'image';
}

export interface DocumentPart {
  readonly filename?: string;
  readonly mimeType: string;
  readonly source: BinarySource;
  readonly title?: string;
  readonly type: 'document';
}

export interface AudioPart {
  readonly channels?: number;
  readonly durationMs?: number;
  readonly mimeType: string;
  readonly sampleRateHz?: number;
  readonly source: BinarySource;
  readonly type: 'audio';
}

export interface ToolCallPart {
  readonly arguments: JsonObject;
  readonly callId: string;
  readonly name: string;
  readonly type: 'tool_call';
}

export type ToolResultContentPart = AudioPart | DocumentPart | ImagePart | TextPart;

export interface ToolResultError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ToolResultPart {
  readonly callId: string;
  readonly content: readonly ToolResultContentPart[];
  readonly error?: ToolResultError;
  readonly status: 'cancelled' | 'denied' | 'error' | 'success';
  readonly structuredContent?: JsonValue;
  readonly type: 'tool_result';
}

export type ContentPart =
  AudioPart | DocumentPart | ImagePart | RefusalPart | TextPart | ToolCallPart | ToolResultPart;

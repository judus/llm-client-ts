import type { ModelCapabilities } from '../../index.js';

/** A raw OpenAI Responses API exchange, emitted only when diagnostics are enabled. */
export interface OpenAIWireEvent {
  readonly at: string;
  readonly attemptId: string;
  readonly operation: 'create' | 'stream';
  readonly phase: 'request' | 'response' | 'stream_event' | 'error';
  readonly payload: unknown;
}

/**
 * Receives raw Responses API payloads for local diagnostics. Implementations must not throw;
 * failures are deliberately ignored so observability cannot change a model request.
 */
export type OpenAIWireLogger = (event: OpenAIWireEvent) => void;

/** Connection configuration shared by the OpenAI adapters. */
export interface OpenAIConnectionOptions {
  /** API key. When omitted, the OpenAI SDK uses its standard environment lookup. */
  readonly apiKey?: string;
  /** Alternate OpenAI-compatible API base URL. */
  readonly baseUrl?: string;
  /** Maximum retries performed by the OpenAI SDK transport. */
  readonly maxRetries?: number;
  /** OpenAI organization identifier. */
  readonly organization?: string;
  /** OpenAI project identifier. */
  readonly project?: string;
  /** Default SDK request timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Configuration accepted without exposing OpenAI SDK objects to consumers. */
export interface OpenAIProviderOptions extends OpenAIConnectionOptions {
  /** Capability override for a specifically selected model or deployment. */
  readonly capabilities?: ModelCapabilities;
  /** Persist Responses API objects at OpenAI. Defaults to false. */
  readonly storeResponses?: boolean;
  /** Optional local diagnostics hook for raw Responses API request and response payloads. */
  readonly wireLogger?: OpenAIWireLogger;
}

/** Returns the conservative capability profile used until a model-specific profile is supplied. */
export function defaultOpenAIModelCapabilities(): ModelCapabilities {
  return {
    input: {
      audio: false,
      documents: true,
      images: true,
      text: true,
    },
    output: {
      audio: false,
      structured: true,
      text: true,
    },
    realtime: false,
    speechSynthesis: false,
    streaming: true,
    tools: {
      calls: true,
      parallelCalls: true,
      strictSchemas: true,
    },
    transcription: false,
  };
}

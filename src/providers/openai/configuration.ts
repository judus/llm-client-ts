import type { ModelCapabilities } from '../../index.js';

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

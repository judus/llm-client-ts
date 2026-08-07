import type { ModelCapabilities } from '@maduser/ai-ts';

/** Configuration accepted without exposing OpenAI SDK objects to consumers. */
export interface OpenAIProviderOptions {
  /** API key. When omitted, the OpenAI SDK uses its standard environment lookup. */
  readonly apiKey?: string;
  /** Alternate OpenAI-compatible API base URL. */
  readonly baseUrl?: string;
  /** Capability override for a specifically selected model or deployment. */
  readonly capabilities?: ModelCapabilities;
  /** Maximum retries performed by the OpenAI SDK transport. */
  readonly maxRetries?: number;
  /** OpenAI organization identifier. */
  readonly organization?: string;
  /** OpenAI project identifier. */
  readonly project?: string;
  /** Persist Responses API objects at OpenAI. Defaults to false. */
  readonly storeResponses?: boolean;
  /** Default SDK request timeout in milliseconds. */
  readonly timeoutMs?: number;
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

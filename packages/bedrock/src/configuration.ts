import type { ModelCapabilities } from '@maduser/ai-ts';

import type { BedrockCapabilityResolver } from './capability-registry.js';

export interface BedrockCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/** Configuration accepted without exposing AWS SDK objects. */
export interface BedrockProviderOptions {
  readonly capabilities?: ModelCapabilities;
  readonly capabilityResolver?: BedrockCapabilityResolver;
  readonly credentials?: BedrockCredentials;
  readonly endpoint?: string;
  readonly maxAttempts?: number;
  /** AWS region. When omitted, the standard AWS SDK region chain is used. */
  readonly region?: string;
}

export function defaultBedrockModelCapabilities(): ModelCapabilities {
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

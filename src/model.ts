import type { ConversationMessage } from './message.js';
import type { JsonObject, JsonSchema } from './json.js';
import type { ToolChoice, ToolDefinition } from './tool.js';
import type { Usage } from './usage.js';

export interface ModelSelector {
  readonly model: string;
  readonly provider: string;
}

export interface ResolvedModel extends ModelSelector {
  readonly revision?: string;
}

export interface ModelCapabilities {
  readonly input: {
    readonly audio: boolean;
    readonly documents: boolean;
    readonly images: boolean;
    readonly text: boolean;
  };
  readonly limits?: {
    readonly audioDurationMs?: number;
    readonly contextTokens?: number;
    readonly documentBytes?: number;
    readonly outputTokens?: number;
  };
  readonly output: {
    readonly audio: boolean;
    readonly structured: boolean;
    readonly text: boolean;
  };
  readonly realtime: boolean;
  readonly speechSynthesis: boolean;
  readonly streaming: boolean;
  readonly tools: {
    readonly calls: boolean;
    readonly parallelCalls: boolean;
    readonly strictSchemas: boolean;
  };
  readonly transcription: boolean;
}

export type ResponseFormat =
  | { readonly type: 'json' }
  | {
      readonly name: string;
      readonly schema: JsonSchema;
      readonly strict?: boolean;
      readonly type: 'json_schema';
    }
  | { readonly type: 'text' };

export interface SamplingOptions {
  readonly seed?: number;
  readonly temperature?: number;
  readonly topP?: number;
}

export interface RequestLimits {
  readonly maxOutputTokens?: number;
}

export interface ModelRequest {
  readonly limits?: RequestLimits;
  readonly messages: readonly ConversationMessage[];
  readonly metadata?: JsonObject;
  readonly model: ModelSelector;
  readonly responseFormat?: ResponseFormat;
  readonly sampling?: SamplingOptions;
  readonly toolChoice?: ToolChoice;
  readonly tools?: readonly ToolDefinition[];
}

export type FinishReason =
  'cancelled' | 'content_filter' | 'error' | 'length' | 'stop' | 'tool_calls' | 'unknown';

export interface ModelResponse {
  readonly finishReason: FinishReason;
  readonly id: string;
  readonly message: ConversationMessage;
  readonly model: ResolvedModel;
  readonly providerMetadata?: JsonObject;
  readonly usage: Usage;
}

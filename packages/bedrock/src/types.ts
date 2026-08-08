import type { CallOptions, JsonObject, JsonValue } from '@maduser/ai-ts';

export type BedrockDocumentFormat =
  'csv' | 'doc' | 'docx' | 'html' | 'md' | 'pdf' | 'txt' | 'xls' | 'xlsx';

export type BedrockImageFormat = 'gif' | 'jpeg' | 'png' | 'webp';

export interface BedrockImageBlock {
  readonly format: BedrockImageFormat;
  readonly source: { readonly bytes: Uint8Array };
}

export interface BedrockDocumentBlock {
  readonly format: BedrockDocumentFormat;
  readonly name: string;
  readonly source: { readonly bytes: Uint8Array };
}

export type BedrockToolResultContent =
  | { readonly document: BedrockDocumentBlock }
  | { readonly image: BedrockImageBlock }
  | { readonly json: JsonValue }
  | { readonly text: string };

export type BedrockContentBlock =
  | { readonly document: BedrockDocumentBlock }
  | { readonly image: BedrockImageBlock }
  | { readonly text: string }
  | {
      readonly toolResult: {
        readonly content: readonly BedrockToolResultContent[];
        readonly status?: 'error' | 'success';
        readonly toolUseId: string;
      };
    }
  | {
      readonly toolUse: {
        readonly input: JsonObject;
        readonly name: string;
        readonly toolUseId: string;
      };
    };

export interface BedrockMessage {
  readonly content: readonly BedrockContentBlock[];
  readonly role: 'assistant' | 'user';
}

export interface BedrockToolConfiguration {
  readonly toolChoice?:
    | { readonly any: Readonly<Record<string, never>> }
    | { readonly auto: Readonly<Record<string, never>> }
    | { readonly tool: { readonly name: string } };
  readonly tools: readonly {
    readonly toolSpec: {
      readonly description: string;
      readonly inputSchema: { readonly json: JsonObject };
      readonly name: string;
      readonly strict: true;
    };
  }[];
}

export interface BedrockConverseRequest {
  readonly inferenceConfig?: {
    readonly maxTokens?: number;
    readonly temperature?: number;
    readonly topP?: number;
  };
  readonly messages: readonly BedrockMessage[];
  readonly modelId: string;
  readonly outputConfig?: {
    readonly textFormat: {
      readonly structure: {
        readonly jsonSchema: {
          readonly name?: string;
          readonly schema: string;
        };
      };
      readonly type: 'json_schema';
    };
  };
  readonly system?: readonly { readonly text: string }[];
  readonly toolConfig?: BedrockToolConfiguration;
}

export type BedrockStopReason =
  | 'content_filtered'
  | 'end_turn'
  | 'guardrail_intervened'
  | 'malformed_model_output'
  | 'malformed_tool_use'
  | 'max_tokens'
  | 'model_context_window_exceeded'
  | 'stop_sequence'
  | 'tool_use';

export interface BedrockTokenUsage {
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface BedrockConverseResponse {
  readonly additionalModelResponseFields?: JsonValue;
  readonly latencyMs?: number;
  readonly message: BedrockMessage;
  readonly stopReason: BedrockStopReason;
  readonly usage?: BedrockTokenUsage;
}

export type BedrockStreamEvent =
  | {
      readonly contentBlockIndex: number;
      readonly name: string;
      readonly toolUseId: string;
      readonly type: 'tool_start';
    }
  | {
      readonly contentBlockIndex: number;
      readonly input: string;
      readonly type: 'tool_delta';
    }
  | {
      readonly contentBlockIndex: number;
      readonly text: string;
      readonly type: 'text_delta';
    }
  | {
      readonly contentBlockIndex: number;
      readonly type: 'content_stop';
    }
  | { readonly stopReason: BedrockStopReason; readonly type: 'message_stop' }
  | { readonly type: 'metadata'; readonly usage: BedrockTokenUsage }
  | {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly type: 'error';
    };

export interface BedrockRuntimeTransport {
  close(): void;
  converse(request: BedrockConverseRequest, options: CallOptions): Promise<BedrockConverseResponse>;
  converseStream(
    request: BedrockConverseRequest,
    options: CallOptions,
  ): Promise<AsyncIterable<BedrockStreamEvent>>;
}

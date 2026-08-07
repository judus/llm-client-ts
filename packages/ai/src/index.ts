export { AiClient } from './client.js';
export { AiError, UnsupportedCapabilityError, serializeAiError } from './error.js';
export { reduceModelStream } from './reduce-stream.js';
export { addUsage } from './usage.js';
export { validateModelRequest } from './validate-request.js';

export type { CallOptions } from './call-options.js';
export type {
  AudioPart,
  BinarySource,
  ContentPart,
  DocumentPart,
  ImagePart,
  RefusalPart,
  TextPart,
  ToolCallPart,
  ToolResultContentPart,
  ToolResultError,
  ToolResultPart,
} from './content.js';
export type { AiErrorCategory, AiErrorOptions, SerializedAiError } from './error.js';
export type {
  ModelEventBase,
  ModelRequestStartedEvent,
  ModelResponseCompletedEvent,
  ModelResponseFailedEvent,
  ModelStreamEvent,
  ModelTextDeltaEvent,
  ModelToolCallCompletedEvent,
  ModelUsageUpdatedEvent,
  TerminalModelEvent,
} from './event.js';
export type { JsonArray, JsonObject, JsonPrimitive, JsonSchema, JsonValue } from './json.js';
export type { ConversationMessage, MessageRole } from './message.js';
export type {
  FinishReason,
  ModelCapabilities,
  ModelRequest,
  ModelResponse,
  ModelSelector,
  RequestLimits,
  ResolvedModel,
  ResponseFormat,
  SamplingOptions,
} from './model.js';
export type { ModelProvider } from './provider.js';
export type { ReducedModelStream } from './reduce-stream.js';
export type { ToolAnnotations, ToolCall, ToolChoice, ToolDefinition } from './tool.js';
export type { Money, Usage } from './usage.js';

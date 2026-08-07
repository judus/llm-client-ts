import type { SerializedAiError } from './error.js';
import type { ModelResponse } from './model.js';
import type { ToolCall } from './tool.js';
import type { Usage } from './usage.js';

export interface ModelEventBase {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly requestId: string;
  readonly sequence: number;
}

export interface ModelRequestStartedEvent extends ModelEventBase {
  readonly type: 'model.request.started';
}

export interface ModelTextDeltaEvent extends ModelEventBase {
  readonly delta: string;
  readonly outputIndex: number;
  readonly type: 'model.text.delta';
}

export interface ModelToolCallCompletedEvent extends ModelEventBase {
  readonly toolCall: ToolCall;
  readonly type: 'model.tool_call.completed';
}

export interface ModelUsageUpdatedEvent extends ModelEventBase {
  readonly type: 'model.usage.updated';
  readonly usage: Usage;
}

export interface ModelResponseCompletedEvent extends ModelEventBase {
  readonly response: ModelResponse;
  readonly type: 'model.response.completed';
}

export interface ModelResponseFailedEvent extends ModelEventBase {
  readonly error: SerializedAiError;
  readonly type: 'model.response.failed';
}

export type ModelStreamEvent =
  | ModelRequestStartedEvent
  | ModelResponseCompletedEvent
  | ModelResponseFailedEvent
  | ModelTextDeltaEvent
  | ModelToolCallCompletedEvent
  | ModelUsageUpdatedEvent;

export type TerminalModelEvent = ModelResponseCompletedEvent | ModelResponseFailedEvent;

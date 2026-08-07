import type { AgentResult, RunBudgetSnapshot, RunLimits } from './agent-types.js';
import type { SerializedAiError } from './error.js';
import type { ModelRequest, ModelResponse } from './model.js';
import type { PolicyDecision } from './policy.js';
import type { ToolCall } from './tool.js';
import type { ToolResultPart } from './content.js';
import type { Usage } from './usage.js';

export interface RunEventBase {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly runId: string;
  readonly sequence: number;
}

export interface RunStartedEvent extends RunEventBase {
  readonly type: 'run.started';
}

export interface RunModelStartedEvent extends RunEventBase {
  readonly request: ModelRequest;
  readonly step: number;
  readonly type: 'run.model.started';
}

export interface RunModelCompletedEvent extends RunEventBase {
  readonly response: ModelResponse;
  readonly step: number;
  readonly type: 'run.model.completed';
}

export interface RunToolProposedEvent extends RunEventBase {
  readonly call: ToolCall;
  readonly type: 'run.tool.proposed';
}

export interface RunPolicyDecidedEvent extends RunEventBase {
  readonly call: ToolCall;
  readonly decision: PolicyDecision;
  readonly type: 'run.policy.decided';
}

export interface RunToolStartedEvent extends RunEventBase {
  readonly call: ToolCall;
  readonly type: 'run.tool.started';
}

export interface RunToolCompletedEvent extends RunEventBase {
  readonly call: ToolCall;
  readonly result: ToolResultPart;
  readonly type: 'run.tool.completed';
}

export interface RunUsageUpdatedEvent extends RunEventBase {
  readonly type: 'run.usage.updated';
  readonly usage: Usage;
}

export interface RunBudgetUpdatedEvent extends RunEventBase {
  readonly budget: RunBudgetSnapshot;
  readonly type: 'run.budget.updated';
}

export interface RunCompletedEvent extends RunEventBase {
  readonly result: AgentResult;
  readonly type: 'run.completed';
}

export interface RunFailedEvent extends RunEventBase {
  readonly error: SerializedAiError;
  readonly result: AgentResult;
  readonly type: 'run.failed';
}

export interface RunCancelledEvent extends RunEventBase {
  readonly error: SerializedAiError;
  readonly result: AgentResult;
  readonly type: 'run.cancelled';
}

export interface RunLimitExceededEvent extends RunEventBase {
  readonly error: SerializedAiError;
  readonly limit: keyof RunLimits;
  readonly result: AgentResult;
  readonly type: 'run.limit_exceeded';
}

export type RunEvent =
  | RunBudgetUpdatedEvent
  | RunCancelledEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunLimitExceededEvent
  | RunModelCompletedEvent
  | RunModelStartedEvent
  | RunPolicyDecidedEvent
  | RunStartedEvent
  | RunToolCompletedEvent
  | RunToolProposedEvent
  | RunToolStartedEvent
  | RunUsageUpdatedEvent;

export type TerminalRunEvent =
  RunCancelledEvent | RunCompletedEvent | RunFailedEvent | RunLimitExceededEvent;

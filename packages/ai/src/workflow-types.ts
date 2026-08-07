import type { ApprovalCoordinator, ApprovalRequest, ApprovalRequestInput } from './approval.js';
import type { SerializedAiError } from './error.js';
import type { JsonObject, JsonSchema, JsonValue } from './json.js';

export interface WorkflowRef {
  readonly name: string;
  readonly version: string;
}

export type WorkflowStageKind =
  | 'agent'
  | 'approval_wait'
  | 'branch'
  | 'deterministic'
  | 'model'
  | 'policy_gate'
  | 'structured_model'
  | 'summary'
  | 'tool';

export interface WorkflowRetryPolicy {
  /** Total attempts, including the initial attempt. */
  readonly maxAttempts: number;
}

export interface WorkflowStageDefinition {
  readonly executorId: string;
  readonly id: string;
  readonly inputSchema: JsonSchema;
  readonly kind: WorkflowStageKind;
  readonly metadata?: JsonObject;
  /** Allowed forward targets for a branch stage. Forbidden on other stage kinds. */
  readonly nextStageIds?: readonly string[];
  readonly outputSchema: JsonSchema;
  readonly retry?: WorkflowRetryPolicy;
  readonly timeoutMs: number;
}

export interface WorkflowDefinition extends WorkflowRef {
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly metadata?: JsonObject;
  readonly outputSchema: JsonSchema;
  readonly stages: readonly WorkflowStageDefinition[];
}

export type WorkflowExecutorEffect = 'external' | 'idempotent' | 'none';

export interface WorkflowExecutionContext extends WorkflowRef {
  readonly attempt: number;
  readonly deadline: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly stageId: string;
}

export type WorkflowStageOutcome =
  | {
      /** Required for branch stages and forbidden for every other stage kind. */
      readonly nextStageId?: string;
      readonly output: JsonValue;
      readonly status: 'completed';
    }
  | {
      readonly approval: ApprovalRequestInput;
      /** Output to checkpoint and release only after approval succeeds. */
      readonly output: JsonValue;
      readonly status: 'awaiting_approval';
    };

export type WorkflowExecutorHandler = (
  input: JsonValue,
  context: WorkflowExecutionContext,
) => Promise<WorkflowStageOutcome> | WorkflowStageOutcome;

export interface WorkflowExecutor {
  readonly effect: WorkflowExecutorEffect;
  readonly execute: WorkflowExecutorHandler;
  readonly id: string;
}

export interface WorkflowEventBase extends WorkflowRef {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly runId: string;
  readonly sequence: number;
}

export interface WorkflowStartedEvent extends WorkflowEventBase {
  readonly type: 'workflow.started';
}

export interface WorkflowResumedEvent extends WorkflowEventBase {
  readonly type: 'workflow.resumed';
}

export interface WorkflowStageStartedEvent extends WorkflowEventBase {
  readonly attempt: number;
  readonly kind: WorkflowStageKind;
  readonly stageId: string;
  readonly type: 'workflow.stage.started';
}

export interface WorkflowStageRetryingEvent extends WorkflowEventBase {
  readonly attempt: number;
  readonly error: SerializedAiError;
  readonly nextAttempt: number;
  readonly stageId: string;
  readonly type: 'workflow.stage.retrying';
}

export interface WorkflowStageCompletedEvent extends WorkflowEventBase {
  readonly attempt: number;
  readonly stageId: string;
  readonly type: 'workflow.stage.completed';
}

export interface WorkflowApprovalRequestedEvent extends WorkflowEventBase {
  readonly approval: ApprovalRequest;
  readonly stageId: string;
  readonly type: 'workflow.approval.requested';
}

export interface WorkflowAwaitingApprovalEvent extends WorkflowEventBase {
  readonly approvalRequestId: string;
  readonly stageId: string;
  readonly type: 'workflow.awaiting_approval';
}

export interface WorkflowCompletedEvent extends WorkflowEventBase {
  readonly type: 'workflow.completed';
}

export interface WorkflowFailedEvent extends WorkflowEventBase {
  readonly error: SerializedAiError;
  readonly type: 'workflow.failed';
}

export interface WorkflowCancelledEvent extends WorkflowEventBase {
  readonly error: SerializedAiError;
  readonly type: 'workflow.cancelled';
}

export type WorkflowEvent =
  | WorkflowApprovalRequestedEvent
  | WorkflowAwaitingApprovalEvent
  | WorkflowCancelledEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | WorkflowResumedEvent
  | WorkflowStageCompletedEvent
  | WorkflowStageRetryingEvent
  | WorkflowStageStartedEvent
  | WorkflowStartedEvent;

export interface WorkflowApprovalCheckpoint {
  readonly action: ApprovalRequestInput['action'];
  readonly output: JsonValue;
  readonly requestId: string;
  readonly stageId: string;
}

export type WorkflowRunStatus =
  'awaiting_approval' | 'cancelled' | 'completed' | 'executing' | 'failed' | 'ready';

/** Durable workflow state. Stores must compare and increment revision atomically. */
export interface WorkflowRunState extends WorkflowRef {
  readonly approval?: WorkflowApprovalCheckpoint;
  readonly createdAt: string;
  readonly currentValue: JsonValue;
  readonly error?: SerializedAiError;
  readonly events: readonly WorkflowEvent[];
  readonly input: JsonValue;
  readonly nextStageIndex: number;
  readonly output?: JsonValue;
  readonly revision: number;
  readonly runId: string;
  readonly status: WorkflowRunStatus;
  readonly updatedAt: string;
}

export interface SaveWorkflowRunOptions {
  /** `null` creates a run; a number replaces exactly that revision. */
  readonly expectedRevision: number | null;
}

export interface WorkflowRunStore {
  get(runId: string): Promise<WorkflowRunState | undefined>;
  put(state: WorkflowRunState, options: SaveWorkflowRunOptions): Promise<WorkflowRunState>;
}

export interface WorkflowRunResult extends WorkflowRef {
  readonly approval?: ApprovalRequest;
  readonly error?: SerializedAiError;
  readonly events: readonly WorkflowEvent[];
  readonly output?: JsonValue;
  readonly revision: number;
  readonly runId: string;
  readonly status: 'awaiting_approval' | 'cancelled' | 'completed' | 'failed';
}

export interface WorkflowRunOptions {
  readonly signal?: AbortSignal;
}

export interface WorkflowRunnerLimits {
  /** Active wall-clock time for one start or resume invocation. */
  readonly maxActiveDurationMs: number;
  readonly maxStageAttempts: number;
  readonly maxStages: number;
}

export interface WorkflowRunnerOptions {
  readonly approvals: ApprovalCoordinator;
  readonly clock?: () => Date;
  readonly definitions: readonly WorkflowDefinition[];
  readonly executors: readonly WorkflowExecutor[];
  readonly idGenerator?: () => string;
  readonly limits?: Partial<WorkflowRunnerLimits>;
  readonly store?: WorkflowRunStore;
}

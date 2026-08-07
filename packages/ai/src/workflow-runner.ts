import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { AiError, serializeAiError } from './error.js';
import { InMemoryWorkflowRunStore } from './workflow-store.js';
import type { ApprovalRequest } from './approval.js';
import type { JsonObject, JsonValue } from './json.js';
import type {
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowEventBase,
  WorkflowExecutor,
  WorkflowRef,
  WorkflowRunOptions,
  WorkflowRunnerLimits,
  WorkflowRunnerOptions,
  WorkflowRunResult,
  WorkflowRunState,
  WorkflowStageDefinition,
  WorkflowStageOutcome,
} from './workflow-types.js';

interface RegisteredStage {
  readonly definition: WorkflowStageDefinition;
  readonly executor: WorkflowExecutor;
  readonly validateInput: ValidateFunction;
  readonly validateOutput: ValidateFunction;
}

interface RegisteredWorkflow {
  readonly definition: WorkflowDefinition;
  readonly stages: readonly RegisteredStage[];
  readonly validateInput: ValidateFunction;
  readonly validateOutput: ValidateFunction;
}

type WorkflowEventPayload = WorkflowEvent extends infer Event
  ? Event extends WorkflowEvent
    ? Omit<Event, keyof WorkflowEventBase>
    : never
  : never;

const defaultWorkflowRunnerLimits: WorkflowRunnerLimits = {
  maxActiveDurationMs: 300_000,
  maxStageAttempts: 3,
  maxStages: 128,
};

/** Executes finite, versioned workflows and checkpoints every stage boundary. */
export class WorkflowRunner {
  readonly #ajv = new Ajv2020({ allErrors: true, strict: true });
  readonly #approvals: WorkflowRunnerOptions['approvals'];
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #limits: WorkflowRunnerLimits;
  readonly #store: NonNullable<WorkflowRunnerOptions['store']>;
  readonly #workflows = new Map<string, RegisteredWorkflow>();

  public constructor(options: WorkflowRunnerOptions) {
    this.#approvals = options.approvals;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#limits = mergeLimits(options.limits);
    this.#store = options.store ?? new InMemoryWorkflowRunStore();
    const executors = registerExecutors(options.executors);
    for (const definition of options.definitions) {
      this.#registerWorkflow(definition, executors);
    }
  }

  public async run(
    workflow: WorkflowRef,
    input: JsonValue,
    options: WorkflowRunOptions = {},
  ): Promise<WorkflowRunResult> {
    const registered = this.#requireWorkflow(workflow);
    validateBoundary(
      registered.validateInput,
      input,
      'workflow_input_validation_failed',
      'Workflow input failed validation.',
      workflow,
    );
    const now = this.#clock().toISOString();
    const runId = this.#idGenerator();
    const initial: WorkflowRunState = {
      createdAt: now,
      currentValue: clone(input),
      events: [],
      input: clone(input),
      name: workflow.name,
      nextStageIndex: 0,
      revision: 0,
      runId,
      status: 'ready',
      updatedAt: now,
      version: workflow.version,
    };
    const started = this.#withEvent(initial, { type: 'workflow.started' });
    const stored = await this.#put(started, null, false);
    return this.#continue(registered, stored, options);
  }

  public async resume(runId: string, options: WorkflowRunOptions = {}): Promise<WorkflowRunResult> {
    const state = await this.#get(runId);
    if (state === undefined) {
      throw new AiError('invalid_request', `Workflow run ${runId} was not found.`, {
        code: 'workflow_run_not_found',
        details: { runId },
      });
    }
    const registered = this.#requireWorkflow(state);
    if (isTerminalStatus(state.status)) {
      return workflowResult(state);
    }
    if (state.status === 'executing') {
      throw new AiError(
        'persistence_conflict',
        `Workflow run ${runId} stopped inside a stage and cannot be replayed safely.`,
        {
          code: 'workflow_recovery_unsafe',
          details: { runId, stageIndex: state.nextStageIndex },
        },
      );
    }
    if (state.status === 'ready') {
      return this.#continue(registered, state, options);
    }

    const checkpoint = state.approval;
    if (checkpoint === undefined) {
      throw new AiError('malformed_response', 'Approval checkpoint is missing.', {
        code: 'workflow_approval_checkpoint_missing',
        details: { runId },
      });
    }
    try {
      await this.#approvals.verify(checkpoint.requestId, checkpoint.action);
    } catch (error) {
      if (error instanceof AiError && error.code === 'approval_pending') {
        return workflowResult(state);
      }
      return this.#finishWithError(state, normalizeWorkflowError(error, options.signal));
    }

    const stage = registered.stages[state.nextStageIndex];
    if (stage?.definition.id !== checkpoint.stageId) {
      throw new AiError('malformed_response', 'Approval checkpoint does not match its stage.', {
        code: 'workflow_approval_checkpoint_mismatch',
        details: { runId, stageId: checkpoint.stageId },
      });
    }
    validateBoundary(
      stage.validateOutput,
      checkpoint.output,
      'workflow_stage_output_validation_failed',
      `Workflow stage ${stage.definition.id} output failed validation.`,
      { ...state, stageId: stage.definition.id },
    );
    const attempt = latestStageAttempt(state.events, stage.definition.id);
    let resumed = removeTransientFields(state, {
      currentValue: clone(checkpoint.output),
      nextStageIndex: state.nextStageIndex + 1,
      status: 'ready',
    });
    resumed = this.#withEvent(resumed, { type: 'workflow.resumed' });
    resumed = this.#withEvent(resumed, {
      attempt,
      stageId: stage.definition.id,
      type: 'workflow.stage.completed',
    });
    const stored = await this.#put(resumed, state.revision, false);
    return this.#continue(registered, stored, options);
  }

  async #continue(
    workflow: RegisteredWorkflow,
    initialState: WorkflowRunState,
    options: WorkflowRunOptions,
  ): Promise<WorkflowRunResult> {
    const activeController = new AbortController();
    const timeout = globalThis.setTimeout(() => {
      activeController.abort(
        new AiError('timeout', 'Workflow active execution time was exceeded.', {
          code: 'workflow_active_duration_exceeded',
        }),
      );
    }, this.#limits.maxActiveDurationMs);
    const signal =
      options.signal === undefined
        ? activeController.signal
        : AbortSignal.any([options.signal, activeController.signal]);
    let state = initialState;
    let executorInvoked = false;
    try {
      while (state.nextStageIndex < workflow.stages.length) {
        throwIfAborted(signal, options.signal);
        const stage = workflow.stages[state.nextStageIndex];
        if (stage === undefined) {
          throw new AiError('malformed_response', 'Workflow stage index is invalid.', {
            code: 'workflow_stage_index_invalid',
            details: { runId: state.runId, stageIndex: state.nextStageIndex },
          });
        }
        validateBoundary(
          stage.validateInput,
          state.currentValue,
          'workflow_stage_input_validation_failed',
          `Workflow stage ${stage.definition.id} input failed validation.`,
          { ...state, stageId: stage.definition.id },
        );
        const maxAttempts = stage.definition.retry?.maxAttempts ?? 1;
        let attempt = 1;
        state = this.#withEvent(
          { ...state, status: 'executing' },
          {
            attempt,
            kind: stage.definition.kind,
            stageId: stage.definition.id,
            type: 'workflow.stage.started',
          },
        );
        state = await this.#put(state, state.revision, false);

        let outcome: WorkflowStageOutcome | undefined;
        while (outcome === undefined) {
          try {
            executorInvoked = true;
            outcome = await executeStage(
              stage,
              state.currentValue,
              state,
              attempt,
              signal,
              this.#clock().getTime(),
            );
          } catch (error) {
            const normalized = normalizeStageError(
              error,
              stage.definition,
              stage.executor,
              signal,
              options.signal,
            );
            if (
              !normalized.retryable ||
              attempt >= maxAttempts ||
              stage.executor.effect === 'external'
            ) {
              return await this.#finishWithError(state, normalized, true);
            }
            const nextAttempt = attempt + 1;
            state = this.#withEvent(state, {
              attempt,
              error: serializeAiError(normalized),
              nextAttempt,
              stageId: stage.definition.id,
              type: 'workflow.stage.retrying',
            });
            state = this.#withEvent(state, {
              attempt: nextAttempt,
              kind: stage.definition.kind,
              stageId: stage.definition.id,
              type: 'workflow.stage.started',
            });
            state = await this.#put(state, state.revision, true);
            attempt = nextAttempt;
          }
        }

        assertOutcomeKind(stage.definition, outcome);
        validateBoundary(
          stage.validateOutput,
          outcome.output,
          'workflow_stage_output_validation_failed',
          `Workflow stage ${stage.definition.id} output failed validation.`,
          { ...state, stageId: stage.definition.id },
        );
        if (outcome.status === 'awaiting_approval') {
          const approval = await this.#approvals.request(outcome.approval);
          let awaiting: WorkflowRunState = {
            ...state,
            approval: {
              action: clone(approval.action),
              output: clone(outcome.output),
              requestId: approval.id,
              stageId: stage.definition.id,
            },
            status: 'awaiting_approval',
          };
          awaiting = this.#withEvent(awaiting, {
            approval,
            stageId: stage.definition.id,
            type: 'workflow.approval.requested',
          });
          awaiting = this.#withEvent(awaiting, {
            approvalRequestId: approval.id,
            stageId: stage.definition.id,
            type: 'workflow.awaiting_approval',
          });
          state = await this.#put(awaiting, state.revision, true);
          return workflowResult(state);
        }

        let completed = removeTransientFields(state, {
          currentValue: clone(outcome.output),
          nextStageIndex: resolveNextStageIndex(
            workflow.stages,
            stage,
            outcome,
            state.nextStageIndex,
          ),
          status: 'ready',
        });
        completed = this.#withEvent(completed, {
          attempt,
          stageId: stage.definition.id,
          type: 'workflow.stage.completed',
        });
        state = await this.#put(completed, state.revision, true);
      }

      validateBoundary(
        workflow.validateOutput,
        state.currentValue,
        'workflow_output_validation_failed',
        'Workflow output failed validation.',
        state,
      );
      let completed: WorkflowRunState = {
        ...state,
        output: clone(state.currentValue),
        status: 'completed',
      };
      completed = this.#withEvent(completed, { type: 'workflow.completed' });
      state = await this.#put(completed, state.revision, false);
      return workflowResult(state);
    } catch (error) {
      if (error instanceof AiError && error.category === 'persistence_conflict') {
        throw error;
      }
      return await this.#finishWithError(
        state,
        normalizeWorkflowError(error, options.signal),
        executorInvoked,
      );
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async #finishWithError(
    state: WorkflowRunState,
    error: AiError,
    executorInvoked = false,
  ): Promise<WorkflowRunResult> {
    const status = error.category === 'cancelled' ? 'cancelled' : 'failed';
    let failed: WorkflowRunState = {
      ...state,
      error: serializeAiError(error),
      status,
    };
    failed = this.#withEvent(
      failed,
      status === 'cancelled'
        ? { error: serializeAiError(error), type: 'workflow.cancelled' }
        : { error: serializeAiError(error), type: 'workflow.failed' },
    );
    const stored = await this.#put(failed, state.revision, executorInvoked);
    return workflowResult(stored);
  }

  #registerWorkflow(
    source: WorkflowDefinition,
    executors: ReadonlyMap<string, WorkflowExecutor>,
  ): void {
    validateIdentifier('workflow name', source.name);
    validateIdentifier('workflow version', source.version);
    const key = workflowKey(source);
    if (this.#workflows.has(key)) {
      throw new AiError('invalid_request', `Workflow ${key} is already registered.`, {
        code: 'duplicate_workflow_version',
        details: { name: source.name, version: source.version },
      });
    }
    if (source.stages.length === 0 || source.stages.length > this.#limits.maxStages) {
      throw new AiError('invalid_request', `Workflow ${key} has an invalid stage count.`, {
        code: 'invalid_workflow_stage_count',
        details: { count: source.stages.length, maxStages: this.#limits.maxStages },
      });
    }
    const definition = clone(source);
    const seen = new Set<string>();
    const stages = definition.stages.map((stage): RegisteredStage => {
      validateIdentifier('workflow stage ID', stage.id);
      if (seen.has(stage.id)) {
        throw new AiError('invalid_request', `Workflow stage ${stage.id} is duplicated.`, {
          code: 'duplicate_workflow_stage_id',
          details: { stageId: stage.id, workflow: key },
        });
      }
      seen.add(stage.id);
      if (!Number.isSafeInteger(stage.timeoutMs) || stage.timeoutMs <= 0) {
        throw new AiError('invalid_request', `Workflow stage ${stage.id} has an invalid timeout.`, {
          code: 'invalid_workflow_stage_timeout',
          details: { stageId: stage.id, timeoutMs: stage.timeoutMs },
        });
      }
      const maxAttempts = stage.retry?.maxAttempts ?? 1;
      if (
        !Number.isSafeInteger(maxAttempts) ||
        maxAttempts <= 0 ||
        maxAttempts > this.#limits.maxStageAttempts
      ) {
        throw new AiError(
          'invalid_request',
          `Workflow stage ${stage.id} has an invalid attempt limit.`,
          {
            code: 'invalid_workflow_stage_attempts',
            details: { maxAttempts, stageId: stage.id },
          },
        );
      }
      const executor = executors.get(stage.executorId);
      if (executor === undefined) {
        throw new AiError(
          'invalid_request',
          `Workflow stage ${stage.id} references an unknown executor.`,
          {
            code: 'workflow_executor_not_found',
            details: { executorId: stage.executorId, stageId: stage.id },
          },
        );
      }
      if (maxAttempts > 1 && executor.effect === 'external') {
        throw new AiError(
          'invalid_request',
          `External executor ${executor.id} cannot be retried automatically.`,
          {
            code: 'unsafe_workflow_retry',
            details: { executorId: executor.id, stageId: stage.id },
          },
        );
      }
      if (stage.kind === 'approval_wait' && executor.effect !== 'none') {
        throw new AiError(
          'invalid_request',
          `Approval preparation executor ${executor.id} must be side-effect free.`,
          {
            code: 'unsafe_approval_executor',
            details: { executorId: executor.id, stageId: stage.id },
          },
        );
      }
      return {
        definition: stage,
        executor,
        validateInput: this.#compileSchema(stage.inputSchema, key, stage.id, 'input'),
        validateOutput: this.#compileSchema(stage.outputSchema, key, stage.id, 'output'),
      };
    });
    validateBranchTargets(stages, key);
    this.#workflows.set(key, {
      definition,
      stages,
      validateInput: this.#compileSchema(definition.inputSchema, key, undefined, 'input'),
      validateOutput: this.#compileSchema(definition.outputSchema, key, undefined, 'output'),
    });
  }

  #compileSchema(
    schema: JsonObject,
    workflow: string,
    stageId: string | undefined,
    boundary: 'input' | 'output',
  ): ValidateFunction {
    try {
      return this.#ajv.compile(schema);
    } catch (cause) {
      throw new AiError('invalid_request', `Workflow ${workflow} has an invalid schema.`, {
        cause,
        code: 'invalid_workflow_schema',
        details: {
          boundary,
          ...(stageId === undefined ? {} : { stageId }),
          workflow,
        },
      });
    }
  }

  #requireWorkflow(reference: WorkflowRef): RegisteredWorkflow {
    const workflow = this.#workflows.get(workflowKey(reference));
    if (workflow === undefined) {
      throw new AiError(
        'invalid_request',
        `Workflow ${reference.name}@${reference.version} is not registered.`,
        {
          code: 'workflow_not_found',
          details: { name: reference.name, version: reference.version },
        },
      );
    }
    return workflow;
  }

  #withEvent(state: WorkflowRunState, event: WorkflowEventPayload): WorkflowRunState {
    const base: WorkflowEventBase = {
      eventId: this.#idGenerator(),
      name: state.name,
      occurredAt: this.#clock().toISOString(),
      runId: state.runId,
      sequence: state.events.length + 1,
      version: state.version,
    };
    return {
      ...state,
      events: [...state.events, { ...base, ...event }],
      updatedAt: base.occurredAt,
    };
  }

  async #get(runId: string): Promise<WorkflowRunState | undefined> {
    try {
      return await this.#store.get(runId);
    } catch (cause) {
      throw persistenceError(runId, cause, false);
    }
  }

  async #put(
    state: WorkflowRunState,
    expectedRevision: number | null,
    executorInvoked: boolean,
  ): Promise<WorkflowRunState> {
    try {
      return await this.#store.put(state, { expectedRevision });
    } catch (cause) {
      throw persistenceError(state.runId, cause, executorInvoked);
    }
  }
}

function registerExecutors(
  sources: readonly WorkflowExecutor[],
): ReadonlyMap<string, WorkflowExecutor> {
  const executors = new Map<string, WorkflowExecutor>();
  for (const executor of sources) {
    validateIdentifier('workflow executor ID', executor.id);
    if (executors.has(executor.id)) {
      throw new AiError('invalid_request', `Workflow executor ${executor.id} is duplicated.`, {
        code: 'duplicate_workflow_executor',
        details: { executorId: executor.id },
      });
    }
    executors.set(executor.id, executor);
  }
  return executors;
}

async function executeStage(
  stage: RegisteredStage,
  input: JsonValue,
  state: WorkflowRunState,
  attempt: number,
  invocationSignal: AbortSignal,
  startedAtMs: number,
): Promise<WorkflowStageOutcome> {
  const timeoutController = new AbortController();
  const timeoutError = new AiError('timeout', `Workflow stage ${stage.definition.id} timed out.`, {
    code: 'workflow_stage_timeout',
    details: { stageId: stage.definition.id, timeoutMs: stage.definition.timeoutMs },
    retryable: stage.executor.effect !== 'external',
  });
  const timeout = globalThis.setTimeout(() => {
    timeoutController.abort(timeoutError);
  }, stage.definition.timeoutMs);
  const signal = AbortSignal.any([invocationSignal, timeoutController.signal]);
  try {
    throwIfAborted(signal);
    const execution = Promise.resolve(
      stage.executor.execute(clone(input), {
        attempt,
        deadline: new Date(startedAtMs + stage.definition.timeoutMs).toISOString(),
        name: state.name,
        runId: state.runId,
        signal,
        stageId: stage.definition.id,
        version: state.version,
      }),
    );
    return await raceAbort(execution, signal);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(errorReason(signal.reason, 'Workflow execution was aborted.'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(errorReason(signal.reason, 'Workflow execution was aborted.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(errorReason(error, 'Workflow executor rejected with a non-error value.'));
      },
    );
  });
}

function assertOutcomeKind(stage: WorkflowStageDefinition, outcome: WorkflowStageOutcome): void {
  if (stage.kind === 'approval_wait' && outcome.status !== 'awaiting_approval') {
    throw new AiError(
      'malformed_response',
      `Approval stage ${stage.id} did not request approval.`,
      {
        code: 'workflow_approval_outcome_required',
        details: { stageId: stage.id },
      },
    );
  }
  if (stage.kind !== 'approval_wait' && outcome.status !== 'completed') {
    throw new AiError(
      'malformed_response',
      `Workflow stage ${stage.id} unexpectedly requested approval.`,
      {
        code: 'workflow_approval_outcome_unexpected',
        details: { stageId: stage.id },
      },
    );
  }
  if (outcome.status !== 'completed') {
    return;
  }
  if (stage.kind === 'branch' && outcome.nextStageId === undefined) {
    throw new AiError('malformed_response', `Branch stage ${stage.id} did not select a target.`, {
      code: 'workflow_branch_target_required',
      details: { stageId: stage.id },
    });
  }
  if (stage.kind !== 'branch' && outcome.nextStageId !== undefined) {
    throw new AiError(
      'malformed_response',
      `Non-branch stage ${stage.id} selected a branch target.`,
      {
        code: 'workflow_branch_target_unexpected',
        details: { stageId: stage.id, target: outcome.nextStageId },
      },
    );
  }
}

function validateBranchTargets(stages: readonly RegisteredStage[], workflow: string): void {
  const indexes = new Map(stages.map((stage, index) => [stage.definition.id, index]));
  for (const [index, stage] of stages.entries()) {
    const targets = stage.definition.nextStageIds;
    if (stage.definition.kind !== 'branch') {
      if (targets !== undefined) {
        throw new AiError('invalid_request', `Stage ${stage.definition.id} is not a branch.`, {
          code: 'workflow_branch_targets_unexpected',
          details: { stageId: stage.definition.id, workflow },
        });
      }
      continue;
    }
    if (targets === undefined || targets.length === 0 || new Set(targets).size !== targets.length) {
      throw new AiError(
        'invalid_request',
        `Branch stage ${stage.definition.id} needs unique targets.`,
        {
          code: 'invalid_workflow_branch_targets',
          details: { stageId: stage.definition.id, workflow },
        },
      );
    }
    for (const target of targets) {
      const targetIndex = indexes.get(target);
      if (targetIndex === undefined || targetIndex <= index) {
        throw new AiError(
          'invalid_request',
          `Branch stage ${stage.definition.id} has a non-forward target.`,
          {
            code: 'invalid_workflow_branch_target',
            details: { stageId: stage.definition.id, target, workflow },
          },
        );
      }
    }
  }
}

function resolveNextStageIndex(
  stages: readonly RegisteredStage[],
  stage: RegisteredStage,
  outcome: Extract<WorkflowStageOutcome, { readonly status: 'completed' }>,
  currentIndex: number,
): number {
  if (stage.definition.kind !== 'branch') {
    return currentIndex + 1;
  }
  const target = outcome.nextStageId;
  if (target === undefined || !stage.definition.nextStageIds?.includes(target)) {
    throw new AiError(
      'authorization',
      `Branch stage ${stage.definition.id} selected an undeclared target.`,
      {
        code: 'workflow_branch_target_not_allowed',
        details: { stageId: stage.definition.id, target: target ?? '' },
      },
    );
  }
  const targetIndex = stages.findIndex(({ definition }) => definition.id === target);
  if (targetIndex <= currentIndex) {
    throw new AiError('malformed_response', `Branch target ${target} cannot be resolved.`, {
      code: 'workflow_branch_target_invalid',
      details: { stageId: stage.definition.id, target },
    });
  }
  return targetIndex;
}

function validateBoundary(
  validate: ValidateFunction,
  value: JsonValue,
  code: string,
  message: string,
  context: WorkflowRef & { readonly stageId?: string },
): void {
  if (validate(value)) {
    return;
  }
  throw new AiError('invalid_request', message, {
    code,
    details: {
      issues: validationIssues(validate.errors),
      name: context.name,
      ...(context.stageId === undefined ? {} : { stageId: context.stageId }),
      version: context.version,
    },
  });
}

function validationIssues(
  errors: readonly ErrorObject[] | null | undefined,
): readonly JsonObject[] {
  return (errors ?? []).map((error): JsonObject => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'Schema validation failed.',
    schemaPath: error.schemaPath,
  }));
}

function normalizeStageError(
  error: unknown,
  stage: WorkflowStageDefinition,
  executor: WorkflowExecutor,
  invocationSignal: AbortSignal,
  callerSignal: AbortSignal | undefined,
): AiError {
  if (invocationSignal.aborted) {
    return normalizeWorkflowError(invocationSignal.reason, callerSignal);
  }
  if (error instanceof AiError) {
    return error;
  }
  return new AiError('tool_execution', `Workflow stage ${stage.id} failed.`, {
    cause: error,
    code: 'workflow_stage_failed',
    details: { executorId: executor.id, stageId: stage.id },
  });
}

function normalizeWorkflowError(error: unknown, callerSignal: AbortSignal | undefined): AiError {
  if (callerSignal?.aborted === true) {
    return new AiError('cancelled', 'Workflow execution was cancelled.', {
      cause: error,
      code: 'workflow_cancelled',
    });
  }
  if (error instanceof AiError) {
    return error;
  }
  return new AiError('tool_execution', 'Workflow execution failed.', {
    cause: error,
    code: 'workflow_execution_failed',
  });
}

function throwIfAborted(signal: AbortSignal, callerSignal?: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  throw normalizeWorkflowError(signal.reason, callerSignal);
}

function persistenceError(runId: string, cause: unknown, executorInvoked: boolean): AiError {
  if (cause instanceof AiError && cause.category === 'persistence_conflict') {
    return new AiError(cause.category, cause.message, {
      cause,
      code: cause.code,
      ...(cause.details === undefined ? {} : { details: cause.details }),
      retryable: executorInvoked ? false : cause.retryable,
    });
  }
  return new AiError('persistence_conflict', `Workflow run ${runId} could not be persisted.`, {
    cause,
    code: 'workflow_persistence_failed',
    details: { executorInvoked, runId },
    retryable: !executorInvoked,
  });
}

function workflowResult(state: WorkflowRunState): WorkflowRunResult {
  if (!isResultStatus(state.status)) {
    throw new AiError('malformed_response', 'Workflow run is not at a result boundary.', {
      code: 'workflow_result_not_terminal',
      details: { runId: state.runId, status: state.status },
    });
  }
  const approval = state.status === 'awaiting_approval' ? findApproval(state.events) : undefined;
  if (state.status === 'awaiting_approval' && approval === undefined) {
    throw new AiError('malformed_response', 'Workflow approval event is missing.', {
      code: 'workflow_approval_event_missing',
      details: { runId: state.runId },
    });
  }
  return {
    ...(approval === undefined ? {} : { approval: clone(approval) }),
    ...(state.error === undefined ? {} : { error: clone(state.error) }),
    events: clone(state.events),
    name: state.name,
    ...(state.output === undefined ? {} : { output: clone(state.output) }),
    revision: state.revision,
    runId: state.runId,
    status: state.status,
    version: state.version,
  };
}

function findApproval(events: readonly WorkflowEvent[]): ApprovalRequest | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'workflow.approval.requested') {
      return event.approval;
    }
  }
  return undefined;
}

function latestStageAttempt(events: readonly WorkflowEvent[], stageId: string): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'workflow.stage.started' && event.stageId === stageId) {
      return event.attempt;
    }
  }
  throw new AiError('malformed_response', 'Workflow stage attempt is missing.', {
    code: 'workflow_stage_attempt_missing',
    details: { stageId },
  });
}

function removeTransientFields(
  state: WorkflowRunState,
  update: Pick<WorkflowRunState, 'currentValue' | 'nextStageIndex' | 'status'>,
): WorkflowRunState {
  return {
    createdAt: state.createdAt,
    currentValue: update.currentValue,
    events: state.events,
    input: state.input,
    name: state.name,
    nextStageIndex: update.nextStageIndex,
    revision: state.revision,
    runId: state.runId,
    status: update.status,
    updatedAt: state.updatedAt,
    version: state.version,
  };
}

function errorReason(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback, { cause: reason });
}

function mergeLimits(input: Partial<WorkflowRunnerLimits> | undefined): WorkflowRunnerLimits {
  const limits = { ...defaultWorkflowRunnerLimits, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AiError('invalid_request', `Workflow limit ${name} must be positive.`, {
        code: 'invalid_workflow_limit',
        details: { limit: name, value },
      });
    }
  }
  return limits;
}

function validateIdentifier(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new AiError('invalid_request', `Invalid ${label}: ${value}.`, {
      code: 'invalid_workflow_identifier',
      details: { label, value },
    });
  }
}

function workflowKey(reference: WorkflowRef): string {
  return `${reference.name}@${reference.version}`;
}

function isTerminalStatus(
  status: WorkflowRunState['status'],
): status is 'cancelled' | 'completed' | 'failed' {
  return status === 'cancelled' || status === 'completed' || status === 'failed';
}

function isResultStatus(status: WorkflowRunState['status']): status is WorkflowRunResult['status'] {
  return status === 'awaiting_approval' || isTerminalStatus(status);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

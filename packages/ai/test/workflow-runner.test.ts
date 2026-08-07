import { describe, expect, it } from 'vitest';

import {
  AiError,
  ApprovalCoordinator,
  InMemoryWorkflowRunStore,
  WorkflowRunner,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type SaveWorkflowRunOptions,
  type WorkflowDefinition,
  type WorkflowExecutor,
  type WorkflowRunState,
  type WorkflowRunStore,
} from '../src/index.js';

const objectSchema: JsonSchema = {
  additionalProperties: false,
  properties: { value: { type: 'integer' } },
  required: ['value'],
  type: 'object',
};

function valueOf(input: JsonValue): number {
  if (!isJsonObject(input)) {
    throw new Error('Expected object input.');
  }
  const value = input['value'];
  if (typeof value !== 'number') {
    throw new Error('Expected numeric value.');
  }
  return value;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stage(
  id: string,
  executorId: string,
  kind: WorkflowDefinition['stages'][number]['kind'] = 'deterministic',
): WorkflowDefinition['stages'][number] {
  return {
    executorId,
    id,
    inputSchema: objectSchema,
    kind,
    outputSchema: objectSchema,
    timeoutMs: 1_000,
  };
}

function workflow(stages: WorkflowDefinition['stages']): WorkflowDefinition {
  return {
    inputSchema: objectSchema,
    name: 'customer.enrichment',
    outputSchema: objectSchema,
    stages,
    version: '1.0.0',
  };
}

interface RunnerFixture {
  readonly approvals: ApprovalCoordinator;
  readonly runner: WorkflowRunner;
  readonly store: WorkflowRunStore;
}

function fixture(
  definition: WorkflowDefinition,
  executors: readonly WorkflowExecutor[],
  store: WorkflowRunStore = new InMemoryWorkflowRunStore(),
): RunnerFixture {
  let id = 0;
  const approvals = new ApprovalCoordinator({
    clock: () => new Date('2026-08-07T12:00:00.000Z'),
    idGenerator: () => 'approval-1',
  });
  return {
    approvals,
    runner: new WorkflowRunner({
      approvals,
      clock: () => new Date('2026-08-07T12:00:00.000Z'),
      definitions: [definition],
      executors,
      idGenerator: () => `workflow-id-${String(++id)}`,
      store,
    }),
    store,
  };
}

function increment(id: string): WorkflowExecutor {
  return {
    effect: 'none',
    execute: (input) => ({ output: { value: valueOf(input) + 1 }, status: 'completed' }),
    id,
  };
}

describe('WorkflowRunner', () => {
  it('runs a finite deterministic workflow with validated, versioned events', async () => {
    const { runner, store } = fixture(
      workflow([stage('first', 'increment'), stage('second', 'double')]),
      [
        increment('increment'),
        {
          effect: 'none',
          execute: (input) => ({ output: { value: valueOf(input) * 2 }, status: 'completed' }),
          id: 'double',
        },
      ],
    );

    const result = await runner.run(
      { name: 'customer.enrichment', version: '1.0.0' },
      { value: 2 },
    );

    expect(result).toMatchObject({ output: { value: 6 }, status: 'completed' });
    expect(result.events.map(({ type }) => type)).toEqual([
      'workflow.started',
      'workflow.stage.started',
      'workflow.stage.completed',
      'workflow.stage.started',
      'workflow.stage.completed',
      'workflow.completed',
    ]);
    expect(result.events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      result.events.every(
        ({ name, version }) => name === 'customer.enrichment' && version === '1.0.0',
      ),
    ).toBe(true);
    expect((await store.get(result.runId))?.status).toBe('completed');
    await expect(runner.resume(result.runId)).resolves.toEqual(result);
  });

  it('rejects invalid workflow input before invoking an executor', async () => {
    let calls = 0;
    const { runner } = fixture(workflow([stage('first', 'increment')]), [
      {
        effect: 'none',
        execute: () => {
          calls += 1;
          return { output: { value: 1 }, status: 'completed' };
        },
        id: 'increment',
      },
    ]);

    await expect(
      runner.run({ name: 'customer.enrichment', version: '1.0.0' }, { value: 'wrong' }),
    ).rejects.toMatchObject({ code: 'workflow_input_validation_failed' });
    expect(calls).toBe(0);
  });

  it('fails a run when stage output violates its schema', async () => {
    const { runner } = fixture(workflow([stage('first', 'bad-output')]), [
      {
        effect: 'none',
        execute: () => ({ output: { value: 'wrong' }, status: 'completed' }),
        id: 'bad-output',
      },
    ]);

    const result = await runner.run(
      { name: 'customer.enrichment', version: '1.0.0' },
      { value: 1 },
    );
    expect(result).toMatchObject({
      error: { code: 'workflow_stage_output_validation_failed' },
      status: 'failed',
    });
  });

  it('retries only explicitly retryable failures on safe executors', async () => {
    let calls = 0;
    const retryStage = { ...stage('retry', 'sometimes'), retry: { maxAttempts: 2 } };
    const { runner } = fixture(workflow([retryStage]), [
      {
        effect: 'idempotent',
        execute: (input) => {
          calls += 1;
          if (calls === 1) {
            throw new AiError('provider_unavailable', 'Temporary failure.', {
              code: 'temporary_failure',
              retryable: true,
            });
          }
          return { output: input, status: 'completed' };
        },
        id: 'sometimes',
      },
    ]);

    const result = await runner.run(
      { name: 'customer.enrichment', version: '1.0.0' },
      { value: 1 },
    );
    expect(result.status).toBe('completed');
    expect(calls).toBe(2);
    expect(result.events.filter(({ type }) => type === 'workflow.stage.retrying')).toHaveLength(1);
  });

  it('pauses at an exact-action approval and resumes without replaying prior stages', async () => {
    let beforeCalls = 0;
    let externalCalls = 0;
    const definition = workflow([
      stage('prepare', 'prepare'),
      stage('approval', 'approval', 'approval_wait'),
      stage('write', 'write', 'tool'),
    ]);
    const { approvals, runner } = fixture(definition, [
      {
        effect: 'none',
        execute: (input) => {
          beforeCalls += 1;
          return { output: { value: valueOf(input) + 1 }, status: 'completed' };
        },
        id: 'prepare',
      },
      {
        effect: 'none',
        execute: (input) => ({
          approval: {
            action: {
              arguments: { value: valueOf(input) },
              kind: 'external_write',
              target: 'customer.update',
            },
            description: 'Update the customer.',
            expiresAt: '2026-08-07T13:00:00.000Z',
          },
          output: input,
          status: 'awaiting_approval',
        }),
        id: 'approval',
      },
      {
        effect: 'external',
        execute: (input) => {
          externalCalls += 1;
          return { output: { value: valueOf(input) * 10 }, status: 'completed' };
        },
        id: 'write',
      },
    ]);

    const paused = await runner.run(
      { name: definition.name, version: definition.version },
      { value: 1 },
    );
    expect(paused).toMatchObject({
      approval: { action: { arguments: { value: 2 } }, status: 'pending' },
      status: 'awaiting_approval',
    });
    expect(beforeCalls).toBe(1);
    expect(externalCalls).toBe(0);
    await expect(runner.resume(paused.runId)).resolves.toMatchObject({
      status: 'awaiting_approval',
    });

    const approval = paused.approval;
    if (approval === undefined) {
      throw new Error('Expected approval request.');
    }
    await approvals.decide({
      actorId: 'operator-1',
      decision: 'approved',
      expectedActionHash: approval.actionHash,
      requestId: approval.id,
    });
    const completed = await runner.resume(paused.runId);
    expect(completed).toMatchObject({ output: { value: 20 }, status: 'completed' });
    expect(beforeCalls).toBe(1);
    expect(externalCalls).toBe(1);
    await runner.resume(paused.runId);
    expect(externalCalls).toBe(1);
  });

  it('turns a denied approval into a failed run without invoking later stages', async () => {
    let externalCalls = 0;
    const definition = workflow([
      stage('approval', 'approval', 'approval_wait'),
      stage('write', 'write', 'tool'),
    ]);
    const { approvals, runner } = fixture(definition, [
      {
        effect: 'none',
        execute: (input) => ({
          approval: {
            action: {
              arguments: { value: valueOf(input) },
              kind: 'external_write',
              target: 'write',
            },
            description: 'Write data.',
            expiresAt: '2026-08-07T13:00:00.000Z',
          },
          output: input,
          status: 'awaiting_approval',
        }),
        id: 'approval',
      },
      {
        effect: 'external',
        execute: (input) => {
          externalCalls += 1;
          return { output: input, status: 'completed' };
        },
        id: 'write',
      },
    ]);
    const paused = await runner.run(
      { name: definition.name, version: definition.version },
      { value: 1 },
    );
    if (paused.approval === undefined) {
      throw new Error('Expected approval request.');
    }
    await approvals.decide({
      actorId: 'operator-1',
      decision: 'denied',
      expectedActionHash: paused.approval.actionHash,
      requestId: paused.approval.id,
    });

    await expect(runner.resume(paused.runId)).resolves.toMatchObject({
      error: { code: 'approval_denied' },
      status: 'failed',
    });
    expect(externalCalls).toBe(0);
  });

  it('allows only one concurrent resume to cross an approval checkpoint', async () => {
    let externalCalls = 0;
    const definition = workflow([
      stage('approval', 'approval', 'approval_wait'),
      stage('write', 'write', 'tool'),
    ]);
    const { approvals, runner } = fixture(definition, [
      {
        effect: 'none',
        execute: (input) => ({
          approval: {
            action: {
              arguments: { value: valueOf(input) },
              kind: 'external_write',
              target: 'write',
            },
            description: 'Write data.',
            expiresAt: '2026-08-07T13:00:00.000Z',
          },
          output: input,
          status: 'awaiting_approval',
        }),
        id: 'approval',
      },
      {
        effect: 'external',
        execute: (input) => {
          externalCalls += 1;
          return { output: input, status: 'completed' };
        },
        id: 'write',
      },
    ]);
    const paused = await runner.run(
      { name: definition.name, version: definition.version },
      { value: 1 },
    );
    if (paused.approval === undefined) {
      throw new Error('Expected approval request.');
    }
    await approvals.decide({
      actorId: 'operator-1',
      decision: 'approved',
      expectedActionHash: paused.approval.actionHash,
      requestId: paused.approval.id,
    });

    const results = await Promise.allSettled([
      runner.resume(paused.runId),
      runner.resume(paused.runId),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(externalCalls).toBe(1);
  });

  it('does not replay a stage when checkpoint persistence fails after execution', async () => {
    let calls = 0;
    const store = new FailingCompletionStore();
    const definition = workflow([stage('write', 'write', 'tool')]);
    const { runner } = fixture(
      definition,
      [
        {
          effect: 'external',
          execute: (input) => {
            calls += 1;
            return { output: input, status: 'completed' };
          },
          id: 'write',
        },
      ],
      store,
    );

    let runId = '';
    try {
      await runner.run({ name: definition.name, version: definition.version }, { value: 1 });
    } catch (error) {
      expect(error).toMatchObject({ code: 'workflow_persistence_failed', retryable: false });
      runId = store.runId;
    }
    expect(calls).toBe(1);
    await expect(runner.resume(runId)).rejects.toMatchObject({
      code: 'workflow_recovery_unsafe',
    });
    expect(calls).toBe(1);
  });

  it('rejects unsafe definitions and bounds stage timeouts', async () => {
    expect(
      () =>
        fixture(workflow([{ ...stage('write', 'write'), retry: { maxAttempts: 2 } }]), [
          {
            effect: 'external',
            execute: (input) => ({ output: input, status: 'completed' }),
            id: 'write',
          },
        ]).runner,
    ).toThrow(expect.objectContaining({ code: 'unsafe_workflow_retry' }));

    const timeoutDefinition = workflow([{ ...stage('slow', 'slow'), timeoutMs: 5 }]);
    const { runner } = fixture(timeoutDefinition, [
      {
        effect: 'none',
        execute: () => new Promise(() => undefined),
        id: 'slow',
      },
    ]);
    await expect(
      runner.run(
        { name: timeoutDefinition.name, version: timeoutDefinition.version },
        { value: 1 },
      ),
    ).resolves.toMatchObject({ error: { code: 'workflow_stage_timeout' }, status: 'failed' });
  });
});

class FailingCompletionStore implements WorkflowRunStore {
  readonly #delegate = new InMemoryWorkflowRunStore();
  public runId = '';

  public get(runId: string): Promise<WorkflowRunState | undefined> {
    return this.#delegate.get(runId);
  }

  public put(state: WorkflowRunState, options: SaveWorkflowRunOptions): Promise<WorkflowRunState> {
    this.runId = state.runId;
    if (state.status === 'ready' && state.nextStageIndex === 1) {
      return Promise.reject(new Error('Database unavailable.'));
    }
    return this.#delegate.put(state, options);
  }
}

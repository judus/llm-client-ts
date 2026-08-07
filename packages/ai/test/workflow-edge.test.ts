import { describe, expect, it } from 'vitest';

import {
  ApprovalCoordinator,
  WorkflowRunner,
  type JsonSchema,
  type WorkflowDefinition,
  type WorkflowExecutor,
} from '../src/index.js';

const schema: JsonSchema = {
  additionalProperties: false,
  properties: { value: { type: 'integer' } },
  required: ['value'],
  type: 'object',
};

function executor(id = 'work', effect: WorkflowExecutor['effect'] = 'none'): WorkflowExecutor {
  return {
    effect,
    execute: (input) => ({ output: input, status: 'completed' }),
    id,
  };
}

function definition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    inputSchema: schema,
    name: 'workflow',
    outputSchema: schema,
    stages: [
      {
        executorId: 'work',
        id: 'work',
        inputSchema: schema,
        kind: 'deterministic',
        outputSchema: schema,
        timeoutMs: 1_000,
      },
    ],
    version: '1',
    ...overrides,
  };
}

function construct(
  definitions: readonly WorkflowDefinition[],
  executors: readonly WorkflowExecutor[] = [executor()],
  limits?: ConstructorParameters<typeof WorkflowRunner>[0]['limits'],
): WorkflowRunner {
  return new WorkflowRunner({
    approvals: new ApprovalCoordinator(),
    definitions,
    executors,
    ...(limits === undefined ? {} : { limits }),
  });
}

describe('WorkflowRunner boundaries', () => {
  it('normalizes cancellation, active-duration exhaustion, and executor failures', async () => {
    const cancelled = construct([definition()]);
    const controller = new AbortController();
    controller.abort('caller stopped');
    await expect(
      cancelled.run(
        { name: 'workflow', version: '1' },
        { value: 1 },
        { signal: controller.signal },
      ),
    ).resolves.toMatchObject({ error: { code: 'workflow_cancelled' }, status: 'cancelled' });

    const failed = construct(
      [definition()],
      [
        {
          effect: 'none',
          execute: () => {
            throw new Error('broken');
          },
          id: 'work',
        },
      ],
    );
    await expect(
      failed.run({ name: 'workflow', version: '1' }, { value: 1 }),
    ).resolves.toMatchObject({ error: { code: 'workflow_stage_failed' }, status: 'failed' });

    const activeLimit = construct(
      [definition()],
      [
        {
          effect: 'none',
          execute: () => new Promise(() => undefined),
          id: 'work',
        },
      ],
      { maxActiveDurationMs: 5 },
    );
    await expect(
      activeLimit.run({ name: 'workflow', version: '1' }, { value: 1 }),
    ).resolves.toMatchObject({
      error: { code: 'workflow_active_duration_exceeded' },
      status: 'failed',
    });
  });

  it('rejects mismatched approval outcomes', async () => {
    const approvalOutcome: WorkflowExecutor = {
      effect: 'none',
      execute: (input) => ({
        approval: {
          action: { arguments: {}, kind: 'custom', target: 'unexpected' },
          description: 'Unexpected.',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        output: input,
        status: 'awaiting_approval',
      }),
      id: 'work',
    };
    const regular = construct([definition()], [approvalOutcome]);
    await expect(
      regular.run({ name: 'workflow', version: '1' }, { value: 1 }),
    ).resolves.toMatchObject({
      error: { code: 'workflow_approval_outcome_unexpected' },
      status: 'failed',
    });

    const approvalStage = definition({
      stages: [{ ...definition().stages[0]!, kind: 'approval_wait' }],
    });
    const missing = construct([approvalStage]);
    await expect(
      missing.run({ name: 'workflow', version: '1' }, { value: 1 }),
    ).resolves.toMatchObject({
      error: { code: 'workflow_approval_outcome_required' },
      status: 'failed',
    });
  });

  it('follows only declared forward branch targets', async () => {
    let skippedCalls = 0;
    const branched = definition({
      stages: [
        {
          ...definition().stages[0]!,
          executorId: 'route',
          id: 'route',
          kind: 'branch',
          nextStageIds: ['skip', 'selected'],
        },
        { ...definition().stages[0]!, executorId: 'skip', id: 'skip' },
        { ...definition().stages[0]!, executorId: 'selected', id: 'selected' },
        { ...definition().stages[0]!, executorId: 'finish', id: 'finish' },
      ],
    });
    const runner = construct(
      [branched],
      [
        {
          effect: 'none',
          execute: (input) => ({ nextStageId: 'selected', output: input, status: 'completed' }),
          id: 'route',
        },
        {
          effect: 'none',
          execute: (input) => {
            skippedCalls += 1;
            return { output: input, status: 'completed' };
          },
          id: 'skip',
        },
        executor('selected'),
        executor('finish'),
      ],
    );

    const result = await runner.run({ name: 'workflow', version: '1' }, { value: 1 });
    expect(result.status).toBe('completed');
    expect(skippedCalls).toBe(0);

    const forbidden = construct(
      [branched],
      [
        {
          effect: 'none',
          execute: (input) => ({ nextStageId: 'finish', output: input, status: 'completed' }),
          id: 'route',
        },
        executor('skip'),
        executor('selected'),
        executor('finish'),
      ],
    );
    await expect(
      forbidden.run({ name: 'workflow', version: '1' }, { value: 1 }),
    ).resolves.toMatchObject({
      error: { code: 'workflow_branch_target_not_allowed' },
      status: 'failed',
    });

    const missing = construct(
      [branched],
      [executor('route'), executor('skip'), executor('selected'), executor('finish')],
    );
    await expect(
      missing.run({ name: 'workflow', version: '1' }, { value: 1 }),
    ).resolves.toMatchObject({
      error: { code: 'workflow_branch_target_required' },
      status: 'failed',
    });

    const unexpected = construct(
      [definition()],
      [
        {
          effect: 'none',
          execute: (input) => ({ nextStageId: 'work', output: input, status: 'completed' }),
          id: 'work',
        },
      ],
    );
    await expect(
      unexpected.run({ name: 'workflow', version: '1' }, { value: 1 }),
    ).resolves.toMatchObject({
      error: { code: 'workflow_branch_target_unexpected' },
      status: 'failed',
    });
  });

  it('validates workflow declarations before execution', () => {
    expect(() => construct([definition({ stages: [] })])).toThrow(
      expect.objectContaining({ code: 'invalid_workflow_stage_count' }),
    );
    expect(() =>
      construct([
        definition({
          stages: [definition().stages[0]!, definition().stages[0]!],
        }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'duplicate_workflow_stage_id' }));
    expect(() =>
      construct([definition({ stages: [{ ...definition().stages[0]!, timeoutMs: 0 }] })]),
    ).toThrow(expect.objectContaining({ code: 'invalid_workflow_stage_timeout' }));
    expect(() =>
      construct([
        definition({
          stages: [{ ...definition().stages[0]!, retry: { maxAttempts: 4 } }],
        }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'invalid_workflow_stage_attempts' }));
    expect(() =>
      construct([definition({ stages: [{ ...definition().stages[0]!, executorId: 'missing' }] })]),
    ).toThrow(expect.objectContaining({ code: 'workflow_executor_not_found' }));
    expect(() =>
      construct(
        [definition({ stages: [{ ...definition().stages[0]!, kind: 'approval_wait' }] })],
        [executor('work', 'external')],
      ),
    ).toThrow(expect.objectContaining({ code: 'unsafe_approval_executor' }));
    expect(() => construct([definition({ inputSchema: { type: 'invalid' } })])).toThrow(
      expect.objectContaining({ code: 'invalid_workflow_schema' }),
    );
    expect(() => construct([definition()], [executor(), executor()])).toThrow(
      expect.objectContaining({ code: 'duplicate_workflow_executor' }),
    );
    expect(() => construct([definition({ name: 'not valid!' })])).toThrow(
      expect.objectContaining({ code: 'invalid_workflow_identifier' }),
    );
    expect(() => construct([definition()], [executor()], { maxStages: 0 })).toThrow(
      expect.objectContaining({ code: 'invalid_workflow_limit' }),
    );
    expect(() => construct([definition(), definition()])).toThrow(
      expect.objectContaining({ code: 'duplicate_workflow_version' }),
    );
    expect(() =>
      construct([
        definition({
          stages: [{ ...definition().stages[0]!, kind: 'branch' }],
        }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'invalid_workflow_branch_targets' }));
    expect(() =>
      construct([
        definition({
          stages: [
            {
              ...definition().stages[0]!,
              kind: 'branch',
              nextStageIds: ['missing'],
            },
          ],
        }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'invalid_workflow_branch_target' }));
    expect(() =>
      construct([
        definition({
          stages: [{ ...definition().stages[0]!, nextStageIds: ['work'] }],
        }),
      ]),
    ).toThrow(expect.objectContaining({ code: 'workflow_branch_targets_unexpected' }));
  });

  it('rejects unknown workflow identities and run IDs', async () => {
    const runner = construct([definition()]);
    await expect(runner.run({ name: 'missing', version: '1' }, { value: 1 })).rejects.toMatchObject(
      {
        code: 'workflow_not_found',
      },
    );
    await expect(runner.resume('missing')).rejects.toMatchObject({
      code: 'workflow_run_not_found',
    });
  });
});

import { describe, expect, it } from 'vitest';

import { InMemoryWorkflowRunStore, type WorkflowRunState } from '../src/index.js';

function state(): WorkflowRunState {
  return {
    createdAt: '2026-08-07T12:00:00.000Z',
    currentValue: { nested: { value: 'original' } },
    events: [],
    input: { value: 1 },
    name: 'workflow',
    nextStageIndex: 0,
    revision: 0,
    runId: 'run-1',
    status: 'ready',
    updatedAt: '2026-08-07T12:00:00.000Z',
    version: '1',
  };
}

describe('InMemoryWorkflowRunStore', () => {
  it('creates and updates with atomic revision checks and defensive copies', async () => {
    const store = new InMemoryWorkflowRunStore();
    const source = state();
    const created = await store.put(source, { expectedRevision: null });
    expect(created.revision).toBe(0);
    if (source.currentValue !== null && typeof source.currentValue === 'object') {
      Reflect.set(source.currentValue, 'changed', true);
    }
    expect((await store.get(source.runId))?.currentValue).toEqual({
      nested: { value: 'original' },
    });

    const updated = await store.put({ ...created, status: 'executing' }, { expectedRevision: 0 });
    expect(updated).toMatchObject({ revision: 1, status: 'executing' });
    if (updated.currentValue !== null && typeof updated.currentValue === 'object') {
      Reflect.set(updated.currentValue, 'changed', true);
    }
    expect((await store.get(source.runId))?.currentValue).toEqual({
      nested: { value: 'original' },
    });
  });

  it('rejects duplicate creates, missing updates, and stale revisions', async () => {
    const store = new InMemoryWorkflowRunStore();
    const run = state();
    await store.put(run, { expectedRevision: null });
    await expect(store.put(run, { expectedRevision: null })).rejects.toMatchObject({
      code: 'duplicate_workflow_run',
    });
    await expect(
      store.put({ ...run, runId: 'missing' }, { expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'workflow_run_not_found' });
    await expect(store.put(run, { expectedRevision: 1 })).rejects.toMatchObject({
      code: 'workflow_revision_conflict',
      retryable: true,
    });
  });
});

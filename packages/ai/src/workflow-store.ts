import { AiError } from './error.js';
import type {
  SaveWorkflowRunOptions,
  WorkflowRunState,
  WorkflowRunStore,
} from './workflow-types.js';

/** In-memory workflow checkpoints with optimistic revision checks. */
export class InMemoryWorkflowRunStore implements WorkflowRunStore {
  readonly #runs = new Map<string, WorkflowRunState>();

  public get(runId: string): Promise<WorkflowRunState | undefined> {
    const state = this.#runs.get(runId);
    return Promise.resolve(state === undefined ? undefined : clone(state));
  }

  public put(state: WorkflowRunState, options: SaveWorkflowRunOptions): Promise<WorkflowRunState> {
    const existing = this.#runs.get(state.runId);
    if (options.expectedRevision === null) {
      if (existing !== undefined) {
        return Promise.reject(
          new AiError('persistence_conflict', `Workflow run ${state.runId} already exists.`, {
            code: 'duplicate_workflow_run',
            details: { runId: state.runId },
          }),
        );
      }
      const created = { ...clone(state), revision: 0 };
      this.#runs.set(state.runId, created);
      return Promise.resolve(clone(created));
    }
    if (existing === undefined) {
      return Promise.reject(
        new AiError('invalid_request', `Workflow run ${state.runId} was not found.`, {
          code: 'workflow_run_not_found',
          details: { runId: state.runId },
        }),
      );
    }
    if (existing.revision !== options.expectedRevision) {
      return Promise.reject(
        new AiError('persistence_conflict', `Workflow run ${state.runId} changed concurrently.`, {
          code: 'workflow_revision_conflict',
          details: {
            actualRevision: existing.revision,
            expectedRevision: options.expectedRevision,
            runId: state.runId,
          },
          retryable: true,
        }),
      );
    }
    const updated = { ...clone(state), revision: existing.revision + 1 };
    this.#runs.set(state.runId, updated);
    return Promise.resolve(clone(updated));
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

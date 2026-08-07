# ADR 0007: Checkpoint declared workflows at every stage boundary

- Status: accepted
- Date: 2026-08-07

## Decision

Workflows are immutable `name@version` declarations. Each named stage has a semantic kind, a code executor reference, draft 2020-12 input and output schemas, a finite timeout, effect classification, optional bounded retry policy, and trace metadata. Branch stages declare every allowed target and can move only forward, keeping the graph finite.

The runner persists revision-checked state before invoking a stage and after accepting its validated output. A stored `executing` state means completion is uncertain and is never replayed automatically. Retries require both an explicitly retryable error and a non-external executor; external effects are never retried by the runner.

Approval stages use side-effect-free preparation executors. The exact proposed action and pending output are checkpointed. Resume verifies that approval and advances the stage without rerunning its preparation or any earlier stage. Concurrent resume attempts compete on the same expected checkpoint revision before later executors can run.

Executor functions remain code references while workflow definitions, checkpoints, and events remain serializable JSON-oriented contracts. The core supplies an in-memory store and accepts an injected durable store.

## Consequences

- A workflow cannot hide an unlimited model or tool loop inside the runner.
- Crashes inside a stage require application reconciliation rather than unsafe replay.
- Approval waits can outlive one process invocation without consuming active execution time.
- Forward branches are inspectable and cannot jump backward into a loop.
- Durable stores must atomically compare and increment workflow revisions.
- Stage handlers must honor their abort signal; the runner can stop waiting at a timeout but cannot forcibly terminate arbitrary application code.

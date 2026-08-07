# ADR 0003: Bounded agent and tool execution

- Status: accepted
- Date: 2026-08-07

## Decision

The low-level client and agent runtime remain separate APIs. `AiClient` performs one model operation and never executes tools. `BoundedAgentRuntime` owns the finite model/tool cycle and uses `ToolRegistry` for local or remotely backed executors.

All tool input is validated with JSON Schema draft 2020-12 before policy evaluation. Declared structured output is validated before it becomes model-visible. Tool names are unique inside a registry, and an agent may restrict the registry with an explicit allow-list.

The built-in policy is deny-safe: it allows only tools explicitly marked read-only and denies destructive, approval-requiring, and unannotated tools. Applications inject policy when their trust model differs. Dry-run decisions return simulated output without invoking the executor.

Every run has finite defaults for model steps, total calls, per-tool calls, concurrency, wall-clock time, reported tokens, and repeated identical failures. Concurrent work is executed in bounded batches, while results and events retain model-call order. One `AbortSignal` reaches provider and tool work.

## Consequences

- Invalid arguments cannot reach executors.
- Tool annotations inform policy but do not grant authority by themselves outside the configured policy.
- Parallel completion timing does not reorder tool results.
- Provider, policy, validation, and tool failures become stable terminal results or normalized tool results.
- Approval suspension and resumability can be added without changing the low-level client contract.

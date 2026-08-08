# ADR 0004: Conversation consistency and rolling summaries

- Status: accepted
- Date: 2026-08-08

## Decision

Conversation persistence is an application-owned port. Every append supplies the expected revision, and a successful batch increments that revision exactly once. Snapshots return conversation metadata, revision, and messages from one read. Store boundaries use defensive copies.

The fluent client reads one snapshot before a turn and appends the completed batch once. It does not automatically replay model requests or MCP tool calls after a persistence conflict.

Context selection is separate from persistence. System and developer instructions are pinned. An assistant tool-call message and its complete tool-result messages form an indivisible group. Token estimation is injectable; the character estimator is the deterministic fallback.

When a maximum context is configured, the client creates rolling summaries before ordinary generation. Raw source messages remain stored. A summary is a derived developer message marked with its source boundary. A later summary merges the previous checkpoint with newly omitted messages. Summary provider usage is added to the turn usage.

## Consequences

- Concurrent writers receive a typed conflict instead of silently interleaving turns.
- Storage technology is irrelevant to the client.
- Tool calls are never separated from their results during trimming or compression.
- Raw history remains auditable even when model context uses a summary.
- Provider-specific token estimators can replace the fallback without changing storage.

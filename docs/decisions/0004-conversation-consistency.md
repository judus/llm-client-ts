# ADR 0004: Conversation consistency and context selection

- Status: accepted
- Date: 2026-08-07

## Decision

Conversation persistence is an application-owned port. Every append supplies the expected conversation revision, and successful batches increment that revision exactly once. The reference in-memory store performs the revision check, message validation, append, and revision update atomically.

Snapshots return conversation metadata, revision, and messages from one read. Store boundaries use defensive copies so callers cannot mutate persisted state through shared object references.

Context selection is a separate strategy from persistence. The initial selector pins system and developer instructions, selects recent history within explicit reserves, and treats each assistant tool-call message plus its complete result messages as one indivisible group. Incomplete groups and orphan results are omitted with explicit reasons. Token counting is injectable; the character estimator is only a deterministic fallback.

Summaries are explicit records with source message boundaries, prompt version, model, creation time, and source-retention status. Recursive summarization must retain that lineage.

The agent runtime may receive a conversation store and history selector. It reads one snapshot before model work and performs one append after the run reaches a terminal state. It never retries that append or replays the run automatically. Persistence conflicts after any tool executor was invoked are marked non-retryable, since annotations cannot prove that an external side effect did not occur.

## Consequences

- Concurrent writers receive a typed revision conflict instead of silently interleaving state.
- Provider-specific tokenizers can replace the fallback without changing storage.
- Context construction can be traced because omissions and reserves are returned as data.
- Durable source messages and summaries remain distinct records.

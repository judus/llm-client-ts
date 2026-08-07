# ADR 0009: Bound and checksum artifacts at ingestion

- Status: accepted
- Date: 2026-08-07

## Decision

Artifacts are provider-neutral binary records addressed by a suite-generated ID and described by immutable metadata. Every stored artifact records its exact byte length, SHA-256 checksum, normalized MIME type, creation time, optional safe filename, and optional JSON metadata for application classification, tenant, retention, and redaction policy.

The store accepts either bytes or an asynchronous byte source. Implementations must enforce a finite byte limit while reading, honor cancellation, reject invalid MIME types and unsafe filenames, and commit only after the entire source has been validated and checksummed. Returned references omit bytes; reads return defensive copies.

The core supplies a bounded in-memory reference implementation. Durable, encrypted, content-deduplicated, and object-storage implementations remain application or integration concerns behind the same `ArtifactStore` contract.

## Consequences

- Messages and traces can retain small immutable references instead of copying binary payloads.
- Checksums provide a stable identity input for provider-file reuse without making provider IDs portable.
- Failed, oversized, or cancelled streams cannot leave partially visible artifacts in the reference store.
- The in-memory implementation necessarily buffers accepted content, but its hard limit prevents unbounded growth per artifact.

# ADR 0010: Scope and lease provider files explicitly

- Status: accepted
- Date: 2026-08-07

## Decision

A provider file is a temporary, provider-owned representation of one immutable artifact. Reuse requires an exact match on provider, opaque tenant and credential scope, provider purpose, artifact SHA-256 checksum, and delete-on-release policy. Provider file IDs never substitute for artifact IDs and never cross a scope boundary.

Every acquisition returns an independent finite lease. The effective expiry is the earlier of the requested lease expiry and a provider-reported expiry. Concurrent acquisitions for the same reuse key share one upload, but they increment distinct references only after a valid lease has been created.

The manager records upload, reuse, release, expiry, deletion, and cleanup-failure events. Releasing the final delete-on-release lease attempts deletion. Failed deletion keeps the remote record eligible for a later `cleanup()` retry. Cleanup also releases expired leases and returns a structured report instead of hiding partial failure.

Caller cancellation prevents a lease from being returned but does not assert that an already-started shared upload was undone. Such zero-reference uploads remain tracked for cleanup. This avoids unsafe assumptions about whether a provider accepted an external side effect before cancellation was observed.

## Consequences

- Identical bytes cannot leak across tenants or credential sets through cache reuse.
- Concurrent callers avoid duplicate uploads while retaining independent lease lifetimes.
- Cleanup failure is inspectable and retryable.
- Applications must use stable, non-secret scope identifiers and schedule cleanup for long-lived managers.
- Durable implementations will need atomic equivalents of the in-memory reuse and reference transitions.

# ADR 0018: Bound the ephemeral realtime transport

- Status: accepted
- Date: 2026-08-08

## Decision

The first OpenAI live transport uses the platform WebSocket implementation with a short-lived `ek_` client credential. It rejects long-lived API keys. Trusted-server credential issuance remains the separate boundary established by ADR 0017.

`OpenAIRealtimeTransport` exposes only JSON wire messages, normalized transport errors, and explicit socket closure. OpenAI SDK event unions, emitter types, WebSocket instances, and close events do not cross the package boundary. The SDK-backed implementation propagates caller cancellation, permits one event consumer, makes close idempotent, rejects sends after closure begins, and normalizes connection and send failures.

Unread events are bounded, defaulting to 1,024. Overflow discards the unread queue, emits an explicit transport error, and closes with WebSocket code 1009. Non-object provider messages likewise fail closed. This protects consumers that stop reading while audio deltas continue arriving.

The transport is intentionally lower-level than `RealtimeVoiceProvider`. Provider event mapping, conversation commits, tool proposals, response reconciliation, and session lifecycle normalization belong to the adapter above it.

## Consequences

- Browser and Node 24 consumers can share an ephemeral transport without an optional Node-specific WebSocket dependency.
- Long-lived provider credentials cannot accidentally enter the subprotocol-based client transport.
- A stalled event consumer fails visibly instead of growing memory without a bound.
- The provider adapter can be tested against an SDK-free transport port.
- Server-side long-lived-key WebSocket support may be added later as a separate transport with explicit dependency and credential semantics.

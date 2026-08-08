# ADR 0016: Guard the realtime session lifecycle

- Status: accepted
- Date: 2026-08-08

## Decision

Realtime voice uses a dedicated full-duplex session contract. It is not an extension of `ModelProvider` and does not reuse the bounded composed-turn API.

`RealtimeVoiceProvider` declares model-specific session capabilities and connects with a normalized `RealtimeVoiceSessionConfig`. Configuration explicitly selects input/output audio encodings and either manual turn commit or server VAD. Provider-specific connection objects, sockets, WebRTC peers, and event unions remain outside core contracts.

`RealtimeVoiceSession` supports audio and text input, manual commit, interruption, tool results, one event stream, and explicit close. Its normalized event union covers session lifecycle, audio activity, partial/final input and output transcripts, canonical message commits, response audio, tool proposals/results, interruption, usage, and terminal close/failure states. Output audio bytes are media delivery payloads and must be redacted by ordinary trace exporters.

`GuardedRealtimeVoiceSession` wraps a provider session and enforces the portable lifecycle. It validates capability/configuration compatibility before use, bounds audio chunks, rejects unsupported operations before provider I/O, permits one event consumer, requires contiguous event sequence numbers and matching session IDs, requires `session.started` first and exactly one terminal event last, blocks operations once closure begins, and makes close idempotent.

Tool proposals and tool results are transport primitives at this layer. The provider session never executes a tool. A higher realtime runtime must route proposals through the same registry, policy, approval, cancellation, and persistence semantics used by bounded agent execution.

## Consequences

- Provider transports cannot silently invent lifecycle or turn-detection semantics.
- Disconnects and malformed streams become explicit terminal or normalized failure states.
- Manual push-to-talk is the portable baseline while server VAD remains capability-gated.
- Realtime media can flow concurrently without placing raw audio in ordinary trace records.
- Browser credential issuance and provider-specific transports can be added without changing application session contracts.
- Policy-controlled tool execution remains a separate runtime responsibility rather than a provider side effect.

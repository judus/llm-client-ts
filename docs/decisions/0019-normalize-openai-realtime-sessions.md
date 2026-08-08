# ADR 0019: Normalize OpenAI realtime sessions

- Status: accepted
- Date: 2026-08-08

## Decision

`OpenAIRealtimeVoiceProvider` adapts the SDK-free wire transport to the core realtime session contract. Connection does not succeed until `session.created` supplies a provider session ID and the configured `session.update` is acknowledged. The handshake is bounded, cancellable, and fails closed.

The adapter maps manual commit and server VAD explicitly. Audio chunks, typed messages, manual audio commits, response interruption, and tool results become provider client events. Provider events become contiguous core events for speech activity, partial and final input/output transcripts, canonical user and assistant messages, output audio, response lifecycle, tool proposals, usage, recoverable operation errors, and terminal close/failure.

Provider function calls remain proposals. The adapter parses and validates their JSON arguments but never executes them. Tool results are sent only when a higher runtime has completed policy, approval, validation, execution, and persistence responsibilities.

Recoverable provider operation errors and response failures are not session-terminal. Core therefore distinguishes `realtime.operation.failed` and `realtime.response.failed` from `realtime.session.failed`. Malformed media, malformed tool arguments, malformed required fields, transport failure, and silent transport termination produce an explicit terminal failure.

## Consequences

- Consumers operate on one provider-neutral session/event model rather than OpenAI event unions.
- Final audio transcripts are represented in the same canonical conversation-message shape as typed turns.
- Tool safety remains owned by the higher bounded runtime.
- Handshake and event corruption cannot leave an apparently open session.
- Realtime runtime orchestration must still reconcile persistence, tool execution, interruption playback state, and reconnect policy.

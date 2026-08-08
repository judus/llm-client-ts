# ADR 0014: Compose voice around canonical text

- Status: accepted
- Date: 2026-08-08

## Decision

Composed voice is a provider-neutral orchestration layer around the existing bounded agent runtime. It does not introduce a second conversation engine.

`ComposedVoiceRuntime` accepts independent `TranscriptionProvider` and optional `SpeechSynthesisProvider` implementations. A completed transcription becomes an ordinary user text part with `source: "transcribed"` and is passed through the same agent, tool, MCP, policy, budget, context-selection, and conversation-persistence path as typed text. The persisted assistant message remains the canonical response; generated audio is a representation of its displayable text.

Transcription is an event stream so providers can expose ephemeral text deltas before one final normalized transcription. The composed runtime wraps the normal agent event stream rather than translating or hiding it. Each stage has a normalized terminal failure, and a synthesis failure retains the successfully completed agent result and assistant transcript.

Input and output audio retention are independent and disabled by default. Retention requires an injected `ArtifactStore`; only already materialized bytes or artifact references can be retained. Default events carry transcript text and audio metadata, never raw audio bytes. The terminal result may contain synthesized audio so the immediate caller can play it without forcing durable retention.

Realtime, full-duplex voice remains a separate session contract. It has different lifecycle, interruption, transport, and transcript-reconciliation requirements and will not be forced into the turn-oriented composed API.

## Consequences

- Spoken and typed turns can alternate in one ordered conversation.
- Speech-to-text, model, and text-to-speech providers can be mixed independently.
- Voice does not bypass the bounded runtime or create a second tool execution path.
- Partial transcript deltas are observable but only the final transcript becomes durable conversation content.
- Audio persistence is explicit, bounded by the artifact store, and absent from default traces.
- Provider-specific transcription and synthesis adapters can be implemented without changing core conversation semantics.

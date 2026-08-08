# ADR 0014: Compose recorded voice around canonical text

- Status: accepted
- Date: 2026-08-08

## Decision

Recorded voice is a modality of the fluent client, not a second conversation engine.

An optional `TranscriptionProvider` converts recorded audio into one final normalized transcript. That transcript becomes an ordinary user text part with `source: "transcribed"` and follows the same history, context, MCP discovery, tool execution, and persistence path as typed input.

An optional `SpeechSynthesisProvider` converts the final assistant text into audio. The text message remains canonical history; generated audio is its immediate playable representation and is returned only in the turn result.

Transcription, model continuations, history summarization, and speech usage are aggregated. Partial transcription deltas may exist inside a provider adapter, but only the final transcript is persisted.

Live microphone capture, playback, full-duplex sessions, VAD, and interruption are excluded from the focused client.

## Consequences

- Spoken and typed turns alternate in one ordered conversation.
- Voice uses the same MCP tool path as text.
- Audio output is optional and does not create a duplicate assistant message.
- UI device concerns stay outside the backend client package.
- Realtime concerns cannot distort the simpler recorded-turn API.

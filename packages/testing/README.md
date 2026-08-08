# `@maduser/ai-ts-testing`

Conformance fixtures and deterministic providers for the Maduser AI TypeScript suite.

`ScriptedProvider`, `ScriptedTranscriptionProvider`, and `ScriptedSpeechSynthesisProvider` execute finite queues and record normalized requests. Exhaustion, mismatched operations, provider failures, and cancellation remain explicit.

`exerciseTranscriptionProvider()` verifies the portable delta/final event protocol and returns the collected final transcript. `exerciseSpeechSynthesisProvider()` verifies that synthesized audio has a MIME type and, for byte sources, non-empty data. Provider packages can use these helpers in contract and live integration tests without importing OpenAI, AWS, or a specific test framework into the published API.

`ScriptedProvider` consumes deterministic generate, stream, and error steps while recording the normalized requests it receives. It is intended for application and adapter tests that exercise `ModelClient` or a configured fluent client without provider credentials or network access.

The package is not ready for public release yet.

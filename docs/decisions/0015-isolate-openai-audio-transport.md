# ADR 0015: Isolate bounded OpenAI audio transport

- Status: accepted
- Date: 2026-08-08

## Decision

OpenAI file transcription and speech generation implement the provider-neutral core contracts through a dedicated normalized transport boundary.

`OpenAITranscriptionProvider` uses the bounded Transcriptions API, streams partial transcript events when configured, and requires exactly one final transcript. It accepts only materialized bytes, validates the documented file-size and format limits before network I/O, and defaults to `gpt-transcribe`. `whisper-1` requires final-only mode because it does not support the file-streaming protocol.

`OpenAISpeechSynthesisProvider` uses the request-oriented Speech API and defaults to `gpt-4o-mini-tts`, the `alloy` voice, and MP3 output. Model, voice, style instructions, speed, and output format remain configurable. Generated audio is normalized to an `AudioPart` containing bytes; deterministic input-character usage and provider request metadata are retained.

OpenAI SDK request objects, event unions, upload values, response wrappers, and web `Response` objects stay inside `OpenAISdkAudioTransport`. Public injection ports use only suite types, plain objects, `Uint8Array`, `AbortSignal`, and async iterables. Both adapters reuse the package's normalized OpenAI error mapping.

This is request-oriented recorded audio. Live microphone input, bidirectional audio, voice activity detection, and interruption are outside the focused client scope.

## Consequences

- Applications can combine OpenAI transcription or synthesis with any compatible configured model provider.
- Invalid size, MIME type, language, speed, output format, and malformed event sequences fail locally and consistently.
- Partial file-transcription deltas reach the common voice event stream while only the final text becomes canonical conversation content.
- No OpenAI SDK type crosses the package's public audio contracts.
- Realtime transport concerns do not distort the simpler request-oriented composed voice API.

# `@maduser/ai-ts-openai`

OpenAI provider adapter for `@maduser/ai-ts`.

The current alpha uses the Responses API for text, image, and document input; text generation; streaming; function tools; and structured-output request mapping. Responses, usage, refusals, and errors are normalized into core types; OpenAI SDK values do not cross the package boundary. Response storage defaults to disabled.

```ts
import { AiClient } from '@maduser/ai-ts';
import { createOpenAIProvider } from '@maduser/ai-ts-openai';

const provider = createOpenAIProvider();
const client = new AiClient(provider);
```

`OPENAI_API_KEY` is used by the underlying SDK when `apiKey` is omitted.

## Realtime client credentials

`OpenAIRealtimeClientSecretIssuer` is the trusted-server boundary for browser or mobile realtime clients. It validates the provider-neutral realtime configuration, maps it to an OpenAI realtime session, and returns a short-lived opaque credential without exposing the server API key.

```ts
import { OpenAIRealtimeClientSecretIssuer } from '@maduser/ai-ts-openai';

const issuer = new OpenAIRealtimeClientSecretIssuer({
  expiresAfterSeconds: 600,
});

const secret = await issuer.issue(realtimeConfig);
```

The default lifetime is ten minutes; configured lifetimes must be 10–7,200 seconds. PCM input and output must be mono at 24 kHz. G.711 A-law and µ-law are also supported. Manual commit and server VAD map explicitly, and optional input transcription defaults to `gpt-4o-mini-transcribe`.

The returned `value` must be delivered only to its intended client and must never enter logs, traces, analytics, URLs, or persisted conversation state. Credential issuance is deliberately separate from the forthcoming live WebSocket/WebRTC session transports.

## Composed voice

The package implements the core `TranscriptionProvider` and `SpeechSynthesisProvider` contracts. They can be used together or mixed independently with another provider.

```ts
import { ComposedVoiceRuntime } from '@maduser/ai-ts';
import {
  createOpenAISpeechSynthesisProvider,
  createOpenAITranscriptionProvider,
} from '@maduser/ai-ts-openai';

const voice = new ComposedVoiceRuntime({
  agent: boundedAgent,
  synthesizer: createOpenAISpeechSynthesisProvider({
    voice: 'nova',
  }),
  transcriber: createOpenAITranscriptionProvider(),
});
```

Bounded transcription defaults to `gpt-transcribe` with partial transcript streaming enabled. Inputs must be materialized bytes in a supported audio format and cannot exceed 25 MB. Set `stream: false` for final-only output; `whisper-1` requires that mode. Language hints use ISO-639-1 codes.

Speech generation defaults to `gpt-4o-mini-tts`, the `alloy` voice, and `audio/mpeg`. Requests can override voice, style instructions, speed, and output MIME type. MP3, Opus, AAC, FLAC, WAV, and PCM outputs map to normalized `AudioPart` bytes. The adapter enforces the 4,096-character input and 0.25–4.0 speed bounds locally.

Both adapters accept the same connection settings as the Responses provider. Cancellation reaches the SDK. OpenAI request IDs, model/voice data, detected languages, token or duration usage, and deterministic TTS character counts are normalized without exposing SDK response types.

## Image and document input

An `ImagePart` or `DocumentPart` keeps its text-adjacent position in the Responses message. Supported sources map as follows:

- `bytes` becomes a Base64 data URL. Inline documents require a safe filename.
- `url` becomes `image_url` or `file_url`; only credential-free HTTP(S) URLs are accepted.
- an OpenAI `provider_file` becomes `file_id`.
- `artifact` fails before transport because request mapping performs no hidden storage reads or uploads. Resolve the artifact to bytes, or acquire a provider-file lease and replace the source explicitly.

The mapper accepts PNG, JPEG, WEBP, and GIF image MIME types. It enforces the provider's image-count and encoded-payload bounds and keeps inline documents below the combined 50 MB request boundary. Model-specific capability overrides remain available for deployments that support a narrower set.

## Provider files

`OpenAIFileAdapter` implements the core provider-file lifecycle port. It uploads immutable artifacts through the Files API, maps provider expiry into the neutral lease model, enforces one configured scope, and requires a confirmed delete response. Use it with `ProviderFileLeaseManager` so reuse, reference counting, cancellation, expiry, and deletion retries remain provider-neutral.

```ts
import { ProviderFileLeaseManager } from '@maduser/ai-ts';
import { OpenAIFileAdapter } from '@maduser/ai-ts-openai';

const files = new ProviderFileLeaseManager(
  new OpenAIFileAdapter({
    expiresAfterSeconds: 24 * 60 * 60,
    scopeId: 'tenant-and-credential-scope',
  }),
);
```

The adapter accepts only OpenAI file purposes known by this release. Scope identifiers must be stable and non-secret. The optional provider expiry is restricted to the Files API range of one hour through thirty days.

The package is not ready for public release yet.

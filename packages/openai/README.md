# `@maduser/ai-ts-openai`

OpenAI provider adapter for `@maduser/ai-ts`.

The current alpha uses the Responses API for text, image, and document input; text generation; streaming; function tools; and structured-output request mapping. Responses, usage, refusals, and errors are normalized into core types; OpenAI SDK values do not cross the package boundary. Response storage defaults to disabled.

```ts
import { AiClient } from '@maduser/ai-ts';
import { createOpenAIProvider } from '@maduser/ai-ts-openai';

const provider = createOpenAIProvider();
const client = new AiClient(provider);
```

`OPENAI_API_KEY` is used by the underlying SDK when `apiKey` is omitted. Audio, transcription, speech, and realtime request mappings remain intentionally disabled until their dedicated milestones.

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

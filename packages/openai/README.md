# `@maduser/ai-ts-openai`

OpenAI provider adapter for `@maduser/ai-ts`.

The current alpha uses the Responses API for text generation, streaming, function tools, and structured-output request mapping. Responses, usage, refusals, and errors are normalized into core types; OpenAI SDK values do not cross the package boundary. Response storage defaults to disabled.

```ts
import { AiClient } from '@maduser/ai-ts';
import { createOpenAIProvider } from '@maduser/ai-ts-openai';

const provider = createOpenAIProvider();
const client = new AiClient(provider);
```

`OPENAI_API_KEY` is used by the underlying SDK when `apiKey` is omitted. Image, document, audio, file-lifecycle, transcription, speech, and realtime mappings remain intentionally disabled until their dedicated milestones.

The package is not ready for public release yet.

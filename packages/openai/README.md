# @maduser/ai-ts-openai

OpenAI adapter for `@maduser/ai-ts`.

```ts
import { createAiClient } from '@maduser/ai-ts';
import { openAI } from '@maduser/ai-ts-openai';

const ai = createAiClient({
  provider: openAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-5.4',
  }),
});
```

`openAI()` binds the selected model and configures:

- text, document, image, structured-output, and function-tool requests through the Responses API;
- recorded-audio transcription through the Audio API;
- optional speech output through the Audio API.

Transcription and speech are enabled with their conservative defaults. Disable either capability explicitly when it is not required:

```ts
openAI({
  apiKey,
  model,
  transcription: false,
  speechSynthesis: false,
});
```

The lower-level `createOpenAIProvider()` factory remains available for adapter tests and applications that construct normalized `ModelRequest` values directly.

OpenAI SDK objects and raw responses remain inside this package. Returned messages, errors, finish reasons, tool calls, and usage use the provider-neutral core types.

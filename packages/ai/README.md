# `@maduser/ai-ts`

Provider-neutral contracts and runtime for the Maduser AI TypeScript suite.

The current alpha includes normalized messages and multimodal content contracts, capability-aware requests, tool definitions and results, usage, errors, strict stream validation, and the low-level `AiClient`. It never executes model-requested tools automatically.

```ts
import { AiClient } from '@maduser/ai-ts';

const client = new AiClient(provider);
const response = await client.generate({
  messages: [
    {
      content: [{ text: 'Hello', type: 'text' }],
      conversationId: 'conversation-1',
      createdAt: new Date().toISOString(),
      id: crypto.randomUUID(),
      role: 'user',
    },
  ],
  model: { model: 'model-name', provider: provider.id },
});
```

The package is not ready for public release yet. Public contracts may change before the first alpha release.

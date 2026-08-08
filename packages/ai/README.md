# @maduser/ai-ts

The provider-neutral client package.

## Text

```ts
const result = await ai.user('Explain Sol in one paragraph.').run();

result.text;
result.usage;
result.finishReason;
```

`createAiClient()` returns the fluent `AiClient`. Calling `.request()` is never required.

## MCP tools

Declare defaults once:

```ts
const ai = createAiClient({
  provider,
  mcp: [
    'http://127.0.0.1:3001/mcp',
    {
      name: 'catalog',
      url: 'https://example.test/mcp',
      headers: async () => ({ authorization: `Bearer ${await token()}` }),
    },
  ],
});
```

The client discovers tools, validates arguments and declared outputs, executes requested tools, returns results to the model, and continues until the model produces a final answer. Tool names are namespaced as `server__tool` for provider compatibility; allowlists also accept the friendlier `server.tool` form.

```ts
await ai.user('Find Sol.').tools(['catalog.lookup']).run();
```

- omit `.tools()` to expose every discovered tool;
- `.tools([...])` exposes only those tools and rejects unknown names before a model request;
- `.tools([])` exposes no tools;
- `.mcp([...])` replaces constructor defaults for one request;
- `.addMcp([...])` extends constructor defaults;
- `.mcp([])` disables MCP for one request.

The finite tool-step limit and per-call timeout are transport safety bounds, not business approval or spending policy.

## Chat history

```ts
const ai = createAiClient({
  provider,
  history: {
    repository,
    maxContextTokens: 100_000,
  },
});

const chat = ai.chat('commander-123');
await chat.user('Tell me about Sol.').run();
await chat.user('Which stations did you mention?').run();
```

`ConversationStore` is storage-neutral. The client loads one revisioned snapshot and appends one completed turn using optimistic concurrency. `InMemoryConversationStore` is the reference implementation.

When `maxContextTokens` is configured, history compression is enabled by default. The client creates a rolling summary when active history reaches 80% of available input capacity and retains the most recent 50% beside it. Both thresholds are configurable. Raw messages remain in the repository; summaries are derived checkpoints. Summarization usage is included in `result.usage`.

## Documents

```ts
await ai
  .user('Summarize this document.')
  .document({
    bytes: await readFile('manual.pdf'),
    filename: 'manual.pdf',
    mimeType: 'application/pdf',
  })
  .run();
```

Documents can use bytes, an HTTPS URL, or an existing provider file ID. Providers decide how the normalized input is transmitted. The OpenAI adapter sends byte documents as Responses API file input.

## Recorded voice

```ts
const result = await ai
  .chat('commander-123')
  .audio({ bytes: recording, mimeType: 'audio/webm' })
  .speak({ voice: 'alloy' })
  .run();
```

The provider transcribes recorded audio first. That final transcript becomes the canonical user message and goes through the same history and MCP tool path as typed text. `.speak()` is optional and synthesizes the final assistant text. The result includes the transcript, optional audio, and aggregate usage for transcription, model/tool continuations, history summaries, and speech.

Live full-duplex microphone sessions are not part of the focused client scope.

## Provider contract

Additional adapters implement `ConfiguredProvider`. It binds a provider ID and model to normalized generate/stream methods and may expose transcription and speech services. Provider SDK objects do not cross the package boundary.

`ModelClient` remains available as the strict low-level request/stream validator for adapter authors. Application code should normally use `createAiClient()`.

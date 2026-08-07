# `@maduser/ai-ts`

Provider-neutral contracts and runtime for the Maduser AI TypeScript suite.

The current alpha includes normalized messages and multimodal content contracts, capability-aware requests, tool definitions and results, usage, errors, strict stream validation, the low-level `AiClient`, and the bounded `BoundedAgentRuntime`.

`AiClient` never executes model-requested tools. Applications that want execution opt into the agent runtime, register concrete executors, and receive a terminal result plus an ordered run-event stream.

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

## Bounded local tools

```ts
import { AiClient, BoundedAgentRuntime, ToolRegistry } from '@maduser/ai-ts';

const tools = new ToolRegistry([
  {
    definition: {
      annotations: { readOnly: true },
      description: 'Look up a customer by numeric ID.',
      inputSchema: {
        additionalProperties: false,
        properties: { id: { type: 'integer' } },
        required: ['id'],
        type: 'object',
      },
      name: 'customer.lookup',
    },
    execute: async (arguments_, { signal }) => {
      const customer = await loadCustomer(arguments_['id'], signal);
      return { structuredContent: customer };
    },
  },
]);

const runtime = new BoundedAgentRuntime({
  client: new AiClient(provider),
  tools,
});

const result = await runtime.run({
  agent: {
    id: 'support',
    model: { model: 'model-name', provider: provider.id },
    tools: ['customer.lookup'],
  },
  input: [{ source: 'typed', text: 'Find customer 42.', type: 'text' }],
});
```

Inputs are validated with JSON Schema draft 2020-12 before policy evaluation or execution. Outputs are validated when a tool declares an output schema. The default policy permits only tools explicitly annotated as read-only and denies destructive, approval-requiring, and unannotated tools. Applications can inject a stricter or domain-specific `ToolPolicy`.

Every run has finite model-step, tool-call, per-tool, parallelism, token, repeated-failure, and wall-clock limits. Cancellation reaches both model providers and tool handlers through `AbortSignal`.

## Conversations and context

`ConversationStore` is the persistence port. `InMemoryConversationStore` is the reference implementation and requires an expected revision on every append, preventing concurrent runs from silently interleaving message batches. `snapshot()` reads metadata, revision, and messages together.

Pass a store as `conversations` when constructing `BoundedAgentRuntime` to continue runs against durable history. Each run loads one snapshot, selects context, and appends its new message batch once. A failed append is never retried automatically. If any executor was invoked, the normalized persistence error is explicitly non-retryable because repeating the run could duplicate an external side effect.

`PairSafeHistorySelector` is independent of storage. It reserves output/tool capacity, retains system and developer instructions, prefers recent history, and never separates assistant tool calls from their result messages. Its result lists every omitted message and reason. Applications should inject a provider-aware `TokenEstimator`; `CharacterTokenEstimator` is a deterministic fallback.

Summary contracts retain source-message boundaries, prompt version, generating model, timestamp, and whether durable sources remain available.

## Versioned prompts

`PromptRegistry` stores immutable `name@version` definitions. Variables are validated with JSON Schema draft 2020-12 before rendering, nested placeholders are resolved explicitly, and object/array interpolation is rejected. Each render returns its exact version and a deterministic SHA-256 fingerprint.

Environment bindings are routing records, not new prompt identities. Moving `production` from version `1.2.0` to `1.3.0` changes selection without rewriting either immutable definition.

The package is not ready for public release yet. Public contracts may change before the first alpha release.

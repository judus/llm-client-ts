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

The package is not ready for public release yet. Public contracts may change before the first alpha release.

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

## Approvals

`ApprovalCoordinator` creates, resolves, and verifies UI-neutral approval requests. Every request contains the exact proposed action, a canonical SHA-256 action hash, an expiry, and a description suitable for the approving surface. Decisions record the actor, time, outcome, and optional reason.

Verification succeeds only while an approval remains valid and only for the same action kind, target, arguments, and context. Changing any of those fields after approval produces an authorization error. Pending, denied, expired, missing, duplicate, and stale decisions have distinct normalized error codes.

`InMemoryApprovalStore` provides reference single-decision semantics and defensive copies. Production applications should inject durable storage with the same atomic create and decide behavior. An approval grants authority only for its bound action; it does not relax workflow limits or authorize adjacent operations.

## Declared workflows

`WorkflowRunner` executes immutable `name@version` definitions whose stages refer to registered code executors. Workflow and stage inputs and outputs are JSON values validated with draft 2020-12 schemas. Stage kinds cover deterministic functions, models, structured models, agents, tools, summaries, policy gates, approval waits, and forward-only branches.

Definitions declare each stage timeout, optional bounded retry policy, effect classification, and—in branch stages—the complete set of allowed forward targets. External-effect executors cannot be retried automatically. Approval preparation must be side-effect free.

The runner persists a revision-checked checkpoint before invoking every executor and after every completed stage. Approval stages persist the proposed action and output, return `awaiting_approval`, and release that output only after `ApprovalCoordinator` verifies the exact action. Concurrent resumes are resolved by optimistic concurrency. If a process or persistence failure leaves a run inside a stage, the runner returns `workflow_recovery_unsafe` instead of replaying a possibly completed side effect.

`WorkflowRunStore` is the durable persistence port; `InMemoryWorkflowRunStore` is its defensive-copy reference implementation. Ordered events include the workflow name/version, stage identity, attempts, retries, approval boundaries, and terminal outcome. Active execution time, stage count, stage attempts, cancellation, and individual stage timeouts are all finite.

## Artifacts

`ArtifactStore` keeps binary content outside messages while `ArtifactRef` carries its stable ID, byte length, SHA-256 checksum, MIME type, creation time, and optional filename and JSON metadata. `BinarySource` can refer to that artifact ID from document, image, or audio content.

`InMemoryArtifactStore` is the bounded reference implementation. It accepts bytes or an asynchronous byte source, enforces the byte limit while reading, validates MIME types and safe filenames, honors cancellation, and publishes an artifact only after the complete input has been checksummed. Reads return defensive copies. Applications can replace it with durable or encrypted storage behind the same contract.

`ProviderFileLeaseManager` maps artifacts to provider files without treating provider IDs as portable. Reuse is isolated by provider, opaque tenant/credential scope, purpose, artifact checksum, and cleanup policy. Concurrent acquisitions share one upload, while every caller receives a separately expiring lease. Provider expiry can shorten but never extend a requested lease.

Releasing the final delete-on-release lease attempts remote deletion. Failed cleanup remains retryable through `cleanup()` and is recorded in the ordered lifecycle event log. Expired leases are released by cleanup as well. Because an upload is a potentially completed external effect, cancellation never claims to undo it; zero-reference uploads remain tracked for deterministic cleanup.

## Composed voice

`ComposedVoiceRuntime` connects independently replaceable transcription and speech-synthesis providers to the normal bounded agent runtime. The completed user transcript is submitted as canonical text with `source: "transcribed"`; the assistant's persisted text remains the canonical response. Typed and spoken turns therefore use the same conversation, context, tools, policy, MCP, and budget behavior.

```ts
import { ComposedVoiceRuntime } from '@maduser/ai-ts';

const voice = new ComposedVoiceRuntime({
  agent: runtime,
  synthesizer,
  transcriber,
});

const result = await voice.run({
  agent: assistant,
  audio: {
    mimeType: 'audio/webm',
    source: { bytes: recordedAudio, type: 'bytes' },
    type: 'audio',
  },
  conversationId: 'conversation-1',
});
```

Transcription providers may stream partial deltas before one final transcript. Voice events wrap the unchanged agent events and expose synthesis metadata without embedding raw audio. Input and output retention are configured independently and default to off; enabling either requires an `ArtifactStore`. Passing `synthesis: false` produces a transcript-only response, while an injected synthesizer is used by default otherwise.

The package is not ready for public release yet. Public contracts may change before the first alpha release.

# Maduser AI TypeScript Suite: Standalone Client and Agent Runtime

Status: implementation in progress
Plan date: 2026-08-07
Target runtime: Node.js 24 or newer
Primary language: strict TypeScript

Implementation status on 2026-08-08:

- Milestones 0 through 5 are complete in the local Git history.
- Milestone 6 is in progress. Artifact storage, provider-file leases, OpenAI file and multimodal mapping, the Bedrock Converse/ConverseStream runtime, discovery normalization, and the model capability registry are complete. The packaged AWS control-plane discovery transport remains.
- Milestone 7 is complete. Provider-neutral speech contracts, the composed runtime, transcript events, canonical conversation persistence, independent audio retention, OpenAI transcription/synthesis adapters, monotonic stage telemetry, and reusable conformance fixtures are implemented and tested.
- Milestones 8 and 9 have not started.

## 1. Outcome

Build a reusable set of npm packages that combines:

- a provider-neutral low-level LLM client;
- a bounded agent and tool-execution runtime;
- durable conversation and artifact abstractions;
- structured workflows, prompts, policies, and execution traces;
- OpenAI and Amazon Bedrock integrations;
- MCP client integration;
- text, image, document, and audio content;
- composed and realtime voice interaction;
- test utilities that make provider and agent behavior reproducible.

The result must be usable from unrelated applications without coupling the core to a UI framework, database, web server, or a specific business domain.

This is not just a wrapper around provider SDKs. It is the shared boundary between application code and model providers, with stable domain types and explicit runtime behavior.

## 2. Decisions already made

### 2.1 Language and runtime

- Implement the project in TypeScript.
- Publish it as npm packages.
- Support Node.js 24 or newer.
- Keep core types portable enough for browser use where practical.
- Keep Node-only transports and persistence implementations outside the portable core.
- Use `AbortSignal`, `Uint8Array`, async iterables, and JSON-compatible values at public boundaries instead of framework-specific types.

### 2.2 Repository and release model

Use one monorepo and one coordinated release train. The initial packages are:

- `@maduser/ai-ts` — core types, low-level client, agent runtime, conversations, workflows, policies, tracing, and voice contracts;
- `@maduser/ai-ts-openai` — OpenAI request, streaming, files, transcription, speech, and realtime adapters;
- `@maduser/ai-ts-bedrock` — Amazon Bedrock Converse, ConverseStream, model discovery, document, tool, and bidirectional voice adapters;
- `@maduser/ai-ts-mcp` — MCP discovery, transport, lifecycle, and conversion into core tools;
- `@maduser/ai-ts-testing` — fake providers, scripted models, in-memory stores, event assertions, and conformance suites.

Do not split every feature into a package. Prompts, workflows, policy, conversation, and voice contracts belong in `@maduser/ai-ts` until real dependency or runtime boundaries justify further packages.

### 2.3 Architectural direction

- Provider SDK objects must not leak into core application code.
- Low-level model access and higher-level agent execution must be distinct APIs.
- Tool execution must be bounded, cancellable, validated, observable, and policy-controlled.
- Conversation history is an application-owned domain model, not a provider response cache.
- Typed workflows and versioned prompts are first-class concepts.
- Text and voice are modalities of one conversation, not separate conversation systems.
- Provider capabilities are discovered or declared explicitly; unsupported behavior must fail before a request is sent.

### 2.4 Quality bar and consumer independence

`ai-ts-suite` is a first-class product suite, not an integration helper for its first consumer. Its runtime baseline, dependencies, architecture, and release cadence must be chosen for the long-term quality of the packages themselves. Compatibility with an older consumer is solved at that consumer's boundary through an upgrade, adapter, IPC bridge, or separately hosted runtime; it must not lower the package baseline or force obsolete provider SDKs into the project.

The engineering reference is the discipline demonstrated by `maduser/argon`:

- one precise purpose per package;
- a small, deliberate public API;
- explicit contracts and predictable failure modes;
- strict typing across production code and tests;
- minimal production dependencies;
- framework-independent internals;
- fast production paths without weakening correctness;
- unit tests for components and integration tests for assembled behavior;
- maximum practical static-analysis strictness;
- enforced code style, package validation, coverage, and CI;
- documentation that states actual behavior and constraints;
- releases treated as durable public contracts.

For TypeScript, this means:

- no public `any`, untyped provider payloads, or unchecked casts;
- `unknown` at untrusted boundaries followed by validation and normalization;
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`, and `verbatimModuleSyntax` enabled;
- provider SDKs confined to their adapter packages;
- no dependency added to core when a small, well-tested implementation or interface suffices;
- no public export added merely because an internal symbol already exists;
- no warning-only quality gates in release CI;
- performance optimizations backed by benchmarks and equivalence tests;
- compatibility claims backed by CI, never by an engine declaration alone.

The default posture is to make invalid states unrepresentable in types and to validate every external value at runtime. Convenience APIs may sit on top of the strict model, but may not introduce alternate semantics.

## 3. Lessons to preserve from the reference implementations

### 3.1 Provider-neutral client

Preserve the strongest aspects of the existing low-level client:

- immutable or effectively immutable request objects;
- normalized messages, content parts, tool definitions, tool calls, and tool results;
- both complete-response and streaming APIs;
- structured JSON output based on JSON Schema;
- multimodal input;
- no provider SDK types in returned application values;
- explicit usage and finish-reason normalization.

Improve the boundary by making tool results multimodal rather than string-only and by using a capability model instead of assuming all providers support the same request options.

### 3.2 Agent runtime

Preserve the useful runtime behavior:

- repeated model/tool execution until a final answer is produced;
- conversation loading and persistence;
- safe history trimming that never separates a tool call from its result;
- optional summarization;
- middleware or hooks around execution;
- artifact handling;
- explicit run stages.

Correct the unsafe or incomplete parts:

- no unbounded loops;
- mandatory argument validation before a tool executes;
- configurable validation of tool results;
- explicit cancellation and deadlines;
- token, cost, step, tool-call, and wall-clock budgets;
- normalized errors rather than arbitrary exception text returned to the model;
- complete event traces for model requests, tool decisions, executions, retries, and persistence;
- defined behavior for parallel tool calls and partial failures.

### 3.3 Typed workflows and policy

Preserve the architectural strengths of the Python design:

- versioned protocols and workflow stages;
- structured schemas rather than loose dictionaries;
- capability profiles;
- budgets;
- dry-run support;
- traces;
- policy decisions such as allow, deny, require approval, and simulate.

Complete the missing integration by connecting those concepts to a working model-driven tool loop and MCP tool broker.

### 3.4 Bedrock, documents, and provider discovery

Preserve the useful features of the Laravel integration:

- Bedrock Converse and streaming support;
- structured JSON responses;
- documents supplied as inline content;
- tools;
- model and inference-profile discovery.

Improve the design by separating the fluent request builder from the provider transport, replacing raw arrays with typed normalized values, and isolating AWS SDK objects inside the adapter.

## 4. Scope

### 4.1 Version 1 scope

Version 1 includes:

- normalized model requests and responses;
- streaming text and structured events;
- text, image, document, and audio content types;
- JSON Schema structured outputs;
- normalized tool definitions, calls, results, and errors;
- a bounded agent loop;
- tool registry and executor;
- policy and approval hooks;
- in-memory conversations and storage interfaces;
- history selection, trimming, and summarization interfaces;
- artifact and provider-file lifecycle abstractions;
- prompt registry and declarative workflows;
- OpenAI adapter;
- Amazon Bedrock adapter;
- MCP integration using stdio and Streamable HTTP;
- composed voice turns;
- provider-neutral realtime voice session contracts;
- at least one realtime voice adapter;
- tracing, usage, budget, and test support.

### 4.2 Explicit non-goals for version 1

- A chat UI or component library.
- Microphone capture, speaker playback, device selection, or echo cancellation.
- A hosted agent service.
- A mandatory database implementation.
- A general-purpose workflow orchestration platform.
- Autonomous long-running background agents.
- Provider-specific features that cannot be represented safely in the normalized API, unless exposed through a clearly marked adapter extension.
- Silent fallback that changes model, provider, modality, or tool policy.

## 5. Design principles

### 5.1 Stable core, replaceable edges

Core code owns the semantic contract. Provider adapters translate it. Applications should be able to change providers without rewriting conversations, tools, policies, or workflows, subject to declared capability differences.

### 5.2 Capability-aware portability

Provider neutrality does not mean pretending providers are identical. Every provider and model exposes a capability profile such as:

```ts
interface ModelCapabilities {
  input: {
    text: boolean;
    images: boolean;
    documents: boolean;
    audio: boolean;
  };
  output: {
    text: boolean;
    audio: boolean;
    structured: boolean;
  };
  tools: {
    calls: boolean;
    parallelCalls: boolean;
    strictSchemas: boolean;
  };
  streaming: boolean;
  realtime: boolean;
  transcription: boolean;
  speechSynthesis: boolean;
  limits?: {
    contextTokens?: number;
    outputTokens?: number;
    documentBytes?: number;
    audioDurationMs?: number;
  };
}
```

Request validation happens against this profile before transport execution.

### 5.3 One canonical execution event stream

Complete responses are conveniences derived from events. Streaming, tracing, voice transcripts, tool progress, and observability should share one ordered run-event model.

### 5.4 Explicit ownership

- The application owns business decisions and presentation.
- The core owns normalized semantics and runtime safety.
- Provider adapters own API translation and provider lifecycle details.
- Tool implementations own side effects.
- Policies decide whether a side effect may proceed.
- Stores own persistence and concurrency guarantees.

## 6. Proposed repository structure

```text
ai-ts-suite/
  .context/
    project-plan.md
  docs/
    architecture.md
    concepts/
    guides/
    providers/
  examples/
    basic-client/
    structured-output/
    tool-agent/
    mcp-client/
    composed-voice/
    realtime-voice/
  packages/
    ai/
      src/
        client/
        content/
        conversations/
        errors/
        events/
        files/
        models/
        policy/
        prompts/
        runtime/
        tools/
        tracing/
        usage/
        voice/
        workflows/
    openai/
      src/
        responses/
        chat/
        files/
        audio/
        realtime/
    bedrock/
      src/
        converse/
        discovery/
        documents/
        audio/
    mcp/
      src/
        client/
        transports/
        tools/
    testing/
      src/
        fakes/
        fixtures/
        matchers/
        conformance/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
```

Use package exports so consumers import deliberate public surfaces rather than internal files. Example:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./client": "./dist/client/index.js",
    "./agent": "./dist/runtime/index.js",
    "./voice": "./dist/voice/index.js",
    "./testing": "./dist/testing/index.js"
  }
}
```

The exact build tool is an implementation choice, but the published output should be ESM-first, include declarations and source maps, and avoid importing optional provider SDKs from `@maduser/ai-ts`.

## 7. Core domain model

### 7.1 Content

Use discriminated content parts rather than reducing messages to strings:

```ts
type ContentPart = TextPart | ImagePart | DocumentPart | AudioPart | ToolCallPart | ToolResultPart;

interface TextPart {
  type: 'text';
  text: string;
  source?: 'typed' | 'transcribed' | 'generated' | 'summarized';
}

interface BinarySource {
  bytes?: Uint8Array;
  url?: string;
  artifactId?: string;
  providerFileId?: string;
}

interface ImagePart {
  type: 'image';
  source: BinarySource;
  mimeType: string;
  detail?: 'auto' | 'low' | 'high';
}

interface DocumentPart {
  type: 'document';
  source: BinarySource;
  mimeType: string;
  filename?: string;
  title?: string;
}

interface AudioPart {
  type: 'audio';
  source: BinarySource;
  mimeType: string;
  durationMs?: number;
  sampleRateHz?: number;
  channels?: number;
}
```

Only one source field may be set in `BinarySource`; enforce this through constructors or a stricter union in the final API.

### 7.2 Messages

```ts
type MessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

interface ConversationMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: ContentPart[];
  createdAt: Date;
  parentId?: string;
  runId?: string;
  metadata?: JsonObject;
}
```

Requirements:

- message IDs are provider-independent;
- tool calls and results carry correlation IDs;
- timestamps and ordering are preserved;
- provider IDs may be stored as metadata but never become primary identifiers;
- histories remain valid when trimmed, summarized, or migrated;
- typed and transcribed text share the same persisted text representation.

### 7.3 Requests and responses

```ts
interface ModelRequest {
  model: ModelSelector;
  messages: ConversationMessage[];
  tools?: ToolDefinition[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  sampling?: SamplingOptions;
  limits?: RequestLimits;
  metadata?: JsonObject;
}

interface ModelResponse {
  id: string;
  model: ResolvedModel;
  message: ConversationMessage;
  finishReason: FinishReason;
  usage: Usage;
  providerMetadata?: JsonObject;
}

interface ModelProvider {
  capabilities(model: ModelSelector): Promise<ModelCapabilities>;
  generate(request: ModelRequest, options?: CallOptions): Promise<ModelResponse>;
  stream(request: ModelRequest, options?: CallOptions): AsyncIterable<RunEvent>;
}
```

`CallOptions` must include `signal`, deadline/timeout, tracing context, and optional idempotency information.

### 7.4 Structured output

Support JSON Schema as the interoperable contract:

```ts
type ResponseFormat =
  | { type: 'text' }
  | { type: 'json' }
  | {
      type: 'json_schema';
      name: string;
      schema: JsonSchema;
      strict?: boolean;
    };
```

The core returns parsed JSON only after schema validation. The response must distinguish:

- provider refusal;
- incomplete output;
- invalid JSON;
- schema validation failure;
- unsupported strictness.

Schema libraries may be integrated through adapters, but public APIs should accept standard JSON Schema.

## 8. Low-level client

The low-level client is useful when an application wants exactly one model request without an agent loop.

```ts
interface AiClient {
  generate(request: ModelRequest, options?: CallOptions): Promise<ModelResponse>;
  stream(request: ModelRequest, options?: CallOptions): AsyncIterable<RunEvent>;
}
```

Responsibilities:

- resolve provider and model;
- validate request against capabilities;
- apply provider-independent middleware;
- invoke the adapter;
- normalize events, response, usage, and errors;
- emit trace data;
- never execute requested tools automatically.

Middleware use cases include logging, metrics, request defaults, safety metadata, caching, rate limiting, and redaction. Middleware must not be able to silently mutate policy decisions after approval.

## 9. Tools and MCP

### 9.1 Tool model

```ts
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: ToolAnnotations;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

interface ToolResult {
  callId: string;
  status: 'success' | 'error' | 'denied' | 'cancelled';
  content: ContentPart[];
  structuredContent?: JsonValue;
  error?: NormalizedToolError;
}
```

Tool annotations should include whether a tool is read-only, destructive, idempotent, open-world, or likely to require approval. These are policy inputs, not trusted security guarantees.

### 9.2 Registry and execution

The tool registry must:

- reject duplicate names unless an explicit namespace strategy resolves them;
- validate arguments before execution;
- optionally validate structured output;
- support cancellation and deadlines;
- enforce concurrency limits;
- classify errors;
- preserve tool call/result ordering;
- expose definitions independently from executors for discovery and dry-run;
- allow local functions and remote MCP tools to look identical to the agent runtime.

### 9.3 MCP integration

The MCP package must support:

- stdio transport for locally launched servers;
- Streamable HTTP for remote servers;
- server initialization and capability negotiation;
- tool discovery and refresh;
- name qualification to prevent collisions;
- conversion between MCP schemas/content and core types;
- lifecycle, reconnect, and shutdown behavior;
- per-server timeouts and concurrency limits;
- policy metadata attached by local configuration;
- normalized MCP errors without losing diagnostic cause chains;
- optional tool-list caching with explicit invalidation.

MCP resources and prompts can be added after the tool path is stable. Do not let their future support distort the initial tool contract.

## 10. Agent runtime

### 10.1 Run contract

```ts
interface AgentRunRequest {
  agent: AgentDefinition;
  input: ContentPart[];
  conversationId?: string;
  context?: JsonObject;
  limits?: RunLimits;
}

interface AgentRuntime {
  run(request: AgentRunRequest, options?: RunOptions): Promise<AgentResult>;
  stream(request: AgentRunRequest, options?: RunOptions): AsyncIterable<RunEvent>;
}
```

The runtime owns this bounded cycle:

```text
load conversation
  -> build context
  -> check budget and policy
  -> invoke model
  -> return final response, or validate and execute requested tools
  -> append tool results
  -> repeat within limits
  -> persist final state and trace
```

### 10.2 Required limits

Every run has finite defaults for:

- model steps;
- total tool calls;
- calls per individual tool;
- concurrent tool calls;
- input and output tokens where the provider reports them;
- estimated or reported monetary cost;
- audio duration or units;
- wall-clock duration;
- retry attempts;
- generated artifact bytes.

The runtime terminates with a typed limit result. It must never rely on `while (true)` plus the expectation that a model will eventually stop.

### 10.3 Tool execution semantics

- Validate every call before policy evaluation and execution.
- Evaluate policy using the normalized call, agent identity, run context, tool metadata, and budget state.
- Permit `allow`, `deny`, `require_approval`, and `dry_run` decisions.
- Execute parallel calls only when both model output and local configuration allow it.
- Preserve deterministic result ordering even when execution is concurrent.
- Mark transient and permanent failures separately.
- Give the model a safe normalized error, while retaining detailed diagnostics in the trace.
- Detect repeated identical failing calls and stop or escalate according to policy.

### 10.4 Cancellation and recovery

- All provider and tool calls receive the run `AbortSignal`.
- Cancellation produces terminal events and consistent stored state.
- Persistence failures do not convert an otherwise successful external side effect into a retry without an idempotency decision.
- Resumability is optional in the first implementation, but events and checkpoints must contain enough identifiers to add it later.

## 11. Conversations and context management

### 11.1 Store contracts

```ts
interface ConversationStore {
  create(input?: CreateConversation): Promise<Conversation>;
  get(id: string): Promise<Conversation | undefined>;
  append(id: string, messages: ConversationMessage[], options?: AppendOptions): Promise<void>;
  listMessages(id: string, query?: MessageQuery): Promise<ConversationMessage[]>;
}
```

The contract must define optimistic concurrency or version checks so two simultaneous runs cannot silently interleave messages.

Provide an in-memory implementation. Database-specific stores belong in optional integrations or consumer applications.

### 11.2 History selection

Context building is a strategy:

- select relevant system/developer instructions;
- include recent turns;
- preserve complete tool-call/result groups;
- include summaries with provenance and covered message ranges;
- account for provider/model context limits;
- reserve output and tool-result capacity;
- report which messages were omitted and why in the trace.

Never truncate a tool result away from its assistant tool call.

### 11.3 Summarization

Summarization must be optional and explicit. A summary records:

- summary text or structured state;
- source message ID range;
- prompt/workflow version used;
- generating model;
- timestamp;
- whether source messages remain available in durable storage.

Do not recursively summarize without retaining lineage.

## 12. Prompts, workflows, and planning

### 12.1 Prompt registry

Prompts are addressed by stable name and version:

```ts
interface PromptRef {
  name: string;
  version: string;
}
```

The registry supports:

- immutable prompt versions;
- variables validated against a schema;
- environment-specific selection without changing semantic version identity;
- rendered-prompt fingerprints in traces;
- tests against representative fixtures.

Secrets and transient application state must not be compiled into stored prompt definitions.

### 12.2 Workflows

A workflow is a typed sequence or graph of named stages, not a collection of ad hoc model calls. Initial stage kinds should include:

- deterministic function;
- model generation;
- structured model generation;
- agent run;
- policy gate;
- approval wait;
- tool execution;
- summarization;
- branching based on typed output.

Each stage declares input/output schemas, limits, retry behavior, and trace metadata. Workflows must be serializable enough to inspect and version, but executable functions can remain code references.

### 12.3 Run planning

Distinguish two meanings of planning:

- **Declared execution plan:** application-defined workflow, tools, policies, and limits. This is required.
- **Model-generated plan:** an optional structured model output that proposes steps. This can be added later and must never grant authority or bypass the declared plan.

The initial release focuses on declared plans. If model-generated planning is added, proposed steps are data that the runtime validates against available capabilities and policy.

## 13. Policy and approvals

### 13.1 Policy interface

```ts
type PolicyDecision =
  | { outcome: 'allow' }
  | { outcome: 'deny'; reason: string }
  | { outcome: 'require_approval'; request: ApprovalRequest }
  | { outcome: 'dry_run'; explanation?: string };

interface PolicyEvaluator {
  evaluate(action: ProposedAction, context: PolicyContext): Promise<PolicyDecision>;
}
```

Policy applies to tool calls, provider file uploads, external writes, sensitive document access, and any application-defined action.

### 13.2 Approval behavior

- Approval requests contain an immutable description of the exact proposed action.
- Approval is tied to a call hash or version so arguments cannot change afterward.
- A denied or expired approval becomes a normalized tool result.
- Approval mechanisms are injected; the core does not assume a terminal or web UI.
- Dry-run must produce the proposed call and policy result without invoking its executor.

## 14. Files, documents, and artifacts

### 14.1 Artifact store

```ts
interface ArtifactStore {
  put(input: PutArtifact): Promise<ArtifactRef>;
  get(id: string): Promise<Artifact | undefined>;
  delete(id: string): Promise<void>;
}
```

Artifacts cover documents, images, audio, generated files, and large tool outputs. The core stores references in messages and traces rather than copying large base64 payloads.

### 14.2 Provider file lifecycle

Provider adapters may need to upload a local artifact and obtain a provider file ID. Model this explicitly:

- upload or reuse;
- record provider, purpose, checksum, and expiry;
- scope references to credentials/tenant;
- delete on lease expiry where configured;
- do not assume provider IDs are portable;
- allow inline bytes where the provider supports them;
- expose cleanup failures in operational telemetry.

### 14.3 Document safety

- Validate MIME type, filename, and byte limits.
- Sanitize provider-required document names.
- Avoid loading unbounded files fully into memory when streaming is possible.
- Treat document contents as untrusted prompt input.
- Provide metadata hooks for classification, tenant, retention, and redaction.

## 15. Voice interaction

### 15.1 Conversation rule

Text and voice are alternate modalities in one ordered conversation. A user may type, speak, then type again without switching histories.

For every completed voice turn:

- persist canonical text with `source: "transcribed"`;
- optionally attach the original audio through an artifact reference;
- correlate transcript, audio, model calls, tools, and response using message and run IDs;
- persist the assistant's final display transcript;
- optionally attach the generated assistant audio.

Partial transcript deltas are ephemeral run events. The final transcript becomes conversation content.

### 15.2 Composed voice

The first voice implementation uses independently replaceable stages:

```text
input audio
  -> speech-to-text provider
  -> canonical user message
  -> normal bounded agent runtime
  -> canonical assistant text
  -> text-to-speech provider
  -> optional output audio artifact
```

Contracts:

```ts
interface SpeechProvider {
  transcribe(input: AudioInput, options?: TranscriptionOptions): Promise<Transcription>;
  synthesize(text: string, options?: SpeechOptions): Promise<AudioOutput>;
}
```

This path permits mixing providers and guarantees that tools, policy, workflows, and conversation storage behave exactly as they do for typed input.

### 15.3 Realtime voice

Realtime speech requires a distinct session API rather than forcing full-duplex behavior into `ModelProvider`:

```ts
interface RealtimeVoiceProvider {
  connect(config: VoiceSessionConfig): Promise<VoiceSession>;
}

interface VoiceSession {
  sendAudio(chunk: AudioChunk): Promise<void>;
  sendText(text: string): Promise<void>;
  commitInput(): Promise<void>;
  interrupt(): Promise<void>;
  events(): AsyncIterable<VoiceEvent>;
  close(): Promise<void>;
}
```

The normalized event model must represent:

- session started and configured;
- input audio started/stopped;
- input transcript delta/final;
- canonical user message committed;
- model response started;
- tool call proposed/approved/started/completed;
- output transcript delta/final;
- output audio chunks/completion;
- interruption or barge-in;
- cancellation, error, and session closure.

### 15.4 Turn detection and interruption

- Support manual commit/push-to-talk as the portable baseline.
- Represent server voice-activity detection as a capability and session option.
- Do not assume identical VAD configuration across providers.
- An interruption aborts current output promptly and records what transcript/audio was actually delivered where that information is available.
- Tool calls already in progress follow their own cancellation and idempotency semantics; stopping audio does not automatically undo side effects.

### 15.5 Browser and server boundary

- Browser microphone/device APIs are outside the core.
- Provider credentials must not be exposed to browser clients.
- Browser realtime transports may require short-lived session credentials issued by a trusted server adapter.
- WebRTC, WebSocket, and provider-specific bidirectional transports live in provider/platform packages.
- The core works with encoded chunks and normalized events.

### 15.6 Voice retention and observability

- Transcript retention and audio retention are separate settings.
- Raw audio is excluded from ordinary traces and logs.
- Usage supports text tokens, audio tokens, characters, duration, and arbitrary provider units.
- Trace timing includes transcription latency, first transcript delta, first response audio, tool pauses, interruption, and total turn duration.
- If transcription fails, the result records whether an audio artifact remains available for retry.

## 16. Unified run events

Use a discriminated event union. A representative subset is:

```ts
type RunEvent =
  | RunStartedEvent
  | ModelRequestStartedEvent
  | ModelTextDeltaEvent
  | ModelResponseCompletedEvent
  | ToolCallProposedEvent
  | PolicyDecisionEvent
  | ToolExecutionStartedEvent
  | ToolExecutionCompletedEvent
  | TranscriptDeltaEvent
  | TranscriptFinalEvent
  | AudioDeltaEvent
  | UsageUpdatedEvent
  | BudgetUpdatedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent;
```

Every event includes:

- event ID;
- timestamp;
- run ID;
- monotonically increasing sequence number;
- optional conversation, message, provider request, and tool call IDs;
- typed payload;
- trace/span correlation.

Consumers must be able to reconstruct a final `AgentResult` from a complete event stream.

## 17. Usage, budgets, and cost

Avoid a text-only usage object:

```ts
interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  audioInputMs?: number;
  audioOutputMs?: number;
  characters?: number;
  providerUnits?: Record<string, number>;
  estimatedCost?: Money;
}
```

Requirements:

- retain raw provider usage in adapter diagnostics;
- normalize known dimensions;
- mark cost as estimated or reported;
- aggregate per call, step, run, conversation, model, and tool where meaningful;
- let budget checks run before and after operations;
- never report missing provider usage as zero.

## 18. Errors and retries

Define stable error categories:

- authentication;
- authorization;
- invalid request;
- unsupported capability;
- rate limit;
- provider unavailable;
- timeout;
- cancelled;
- content policy/refusal;
- malformed provider response;
- structured-output validation;
- tool validation;
- tool execution;
- policy denial;
- approval required/expired;
- budget exceeded;
- persistence conflict;
- transport/session failure.

Each error contains a safe message, retryability, category, relevant normalized IDs, and an optional diagnostic cause not intended for model context.

Retries must be explicit and limited. They must consider idempotency, elapsed deadline, provider retry hints, and accumulated budgets. Do not retry arbitrary tool side effects automatically.

## 19. OpenAI adapter plan

The OpenAI package should implement:

- Responses API as the preferred general model path;
- Chat Completions only where required for compatibility or a feature unavailable through the preferred path;
- streaming event translation;
- function/tool definitions and calls;
- structured outputs;
- image input;
- document input where supported;
- provider file upload, reference, and cleanup;
- transcription;
- speech generation;
- realtime audio/text sessions;
- provider capability profiles;
- normalized usage, refusals, truncation, and errors.

Provider-specific options may be exposed through a namespaced extension object, but portable functionality must use normalized fields.

Add contract fixtures for every provider event type used by the adapter. Avoid tests that depend only on live API calls.

## 20. Amazon Bedrock adapter plan

The Bedrock package should implement:

- Converse;
- ConverseStream;
- system, user, assistant, tool-use, and tool-result translation;
- images and inline documents supported by selected models;
- structured output where the selected model/API supports it;
- model and inference-profile discovery;
- model capability profiles;
- normalized usage, stop reasons, guardrail/error information;
- bidirectional voice sessions for compatible speech models;
- AWS credential and region configuration without exposing SDK clients in core types.

Model discovery and capability declaration are separate: discovery says what exists, while a tested capability registry says which normalized features the adapter can safely provide.

## 21. Security and privacy

- Never include secrets in requests, traces, errors, or artifacts unless the application deliberately supplies them as model input.
- Provide redaction hooks for messages, tool arguments/results, provider metadata, and traces.
- Treat prompts, documents, transcripts, MCP output, and tool output as untrusted data.
- Keep credentials in provider configuration and platform credential chains.
- Support tenant/context metadata without making tenancy assumptions in core.
- Make retention policy configurable for messages, documents, audio, provider files, and traces.
- Make destructive and open-world tools visible to policy.
- Ensure approval records are auditable and bound to exact arguments.
- Document that model-generated tool calls are proposals, never authority.

## 22. Observability and tracing

Provide an exporter-neutral trace interface. The core should not require a specific telemetry backend.

Trace records should include:

- workflow, prompt, agent, and model versions;
- request and response IDs;
- selected provider/model and capability profile;
- context-selection decisions;
- model and tool timings;
- tool arguments/results subject to redaction;
- policy and approval decisions;
- retries;
- usage and budget updates;
- errors and cancellation;
- voice latency and interruptions;
- persistence outcomes.

Support no-op, in-memory, callback, and OpenTelemetry-oriented exporters. Exact OpenTelemetry dependency placement should be decided during implementation to keep it optional.

## 23. Testing strategy

### 23.1 Core unit tests

- content and message invariants;
- capability validation;
- schema validation;
- event ordering;
- usage aggregation;
- error classification;
- history trimming and tool-pair preservation;
- summary lineage;
- run limits and cancellation;
- policy and approval binding;
- artifact and provider-file leases;
- voice transcript reconciliation and interruption.

### 23.2 Scripted provider tests

`@maduser/ai-ts-testing` provides a provider that consumes a script such as:

```ts
const provider = scriptedProvider([
  reply.withToolCall('lookup', { id: 42 }),
  reply.withText('The result is ready.'),
]);
```

It must simulate:

- text deltas;
- tool calls;
- invalid arguments;
- parallel calls;
- refusals;
- timeouts and rate limits;
- malformed provider events;
- usage updates;
- transcript and audio deltas;
- disconnect and reconnect scenarios.

### 23.3 Adapter conformance tests

Each provider adapter runs a shared suite proving:

- normalized request mapping;
- response/event invariants;
- tool correlation;
- cancellation behavior;
- usage semantics;
- error mapping;
- declared capabilities match implemented behavior.

Provider-specific fixture tests cover recorded or hand-authored API payloads. Optional live tests run only with credentials and are not required for ordinary development.

### 23.4 MCP tests

- in-process fixture server;
- stdio lifecycle;
- Streamable HTTP lifecycle;
- discovery refresh;
- duplicate names and namespacing;
- schema conversion;
- cancellation and timeout;
- server failure and reconnect;
- multimodal tool results.

### 23.5 Compatibility and quality gates

- TypeScript type checking with the full strictness profile defined in section 2.4;
- zero unchecked `any` or unjustified suppression in production code;
- unit and integration tests;
- package-specific coverage thresholds, with near-complete branch coverage required for core state machines, policy, budgets, event reduction, and history management;
- mutation or property-based tests for critical state machines and validation logic;
- package export tests from built tarballs;
- Node.js supported-version matrix;
- browser build/type test for portable entry points;
- lint and formatting with zero warnings;
- unused export, dependency, and dead-code detection;
- API surface report or snapshot;
- dependency and license audit;
- provenance/SBOM generation and reproducible release metadata;
- benchmark checks for streaming, event reduction, history construction, and high-volume tool execution;
- examples compiled and exercised in CI;
- no provider SDK dependency reachable from the core package graph.

CI must validate the artifacts that will actually be published, not only the source workspace. It should pack each package, install it into clean ESM and TypeScript fixture projects, verify public types and subpath exports, and run smoke tests without workspace path resolution.

Quality exceptions require an inline reason and, where relevant, a tracking issue. Release workflows must not use `|| true`, ignored failures, or advisory-only checks for tests, typing, lint, package validation, API compatibility, or security gates.

## 24. Documentation deliverables

Before a stable release, provide:

- architecture and package-boundary overview;
- core concepts: messages, content, tools, runs, conversations, workflows, artifacts, voice;
- provider setup guides;
- capability matrix;
- low-level client guide;
- bounded tool-agent guide;
- MCP guide;
- structured-output guide;
- documents and provider-file lifecycle guide;
- composed voice guide;
- realtime voice guide;
- policy and approval guide;
- persistence integration guide;
- testing guide;
- migration notes mapping concepts from the existing PHP and Python implementations.

Every guide should use actual exported symbols and compile its examples in CI.

## 25. Implementation milestones

### Milestone 0: Architecture baseline

Deliverables:

- initialize monorepo tooling;
- create package boundaries and dependency rules;
- record architecture decisions;
- define naming and stability rules;
- create public API review process;
- establish CI for type checking, tests, package builds, and tarball import tests.

Exit criteria:

- every package can build and be imported;
- core has no provider SDK dependency;
- an API surface snapshot is generated;
- architecture decisions in this plan are either accepted or replaced by recorded decisions.

### Milestone 1: Core model and low-level client

Deliverables:

- JSON value/schema types;
- content parts and messages;
- requests, responses, finish reasons, and usage;
- provider and capability interfaces;
- call options, cancellation, and normalized errors;
- unified text streaming events;
- low-level `generate` and `stream` client;
- in-memory tracing and fake provider.

Exit criteria:

- a scripted provider passes the core client conformance suite;
- text, tool calls, structured output, and errors are representable without provider types;
- streams can be reduced into the same final response returned by `generate`.

### Milestone 2: OpenAI text and structured output

Deliverables:

- OpenAI configuration and provider;
- preferred general API mapping;
- text generation and streaming;
- tools and structured outputs;
- normalized errors and usage;
- fixture-based adapter tests;
- one optional live smoke test.

Exit criteria:

- low-level examples work without importing the OpenAI SDK directly;
- capability validation rejects unsupported combinations before transport;
- tool and structured-response fixtures pass conformance tests.

### Milestone 3: Bounded agent and local tools

Deliverables:

- tool registry and executor;
- mandatory input validation;
- optional output validation;
- agent loop;
- run limits and budgets;
- cancellation;
- sequential and bounded-parallel tool execution;
- run event stream and final result;
- policy interface with allow/deny/dry-run;
- complete scripted tests.

Exit criteria:

- no path can execute an unlimited model/tool loop;
- invalid tool arguments never reach executors;
- cancellation terminates provider and tool work;
- all decisions appear in ordered events;
- repeated tool failures terminate predictably.

### Milestone 4: Conversations, context, prompts, and workflows

Deliverables:

- conversation and message store interfaces;
- in-memory store with concurrency checks;
- history-selection strategy;
- pair-safe trimming;
- summarization interface and lineage;
- prompt registry and variables;
- typed workflow stages;
- approval wait/resume contract design;
- workflow and context traces.

Exit criteria:

- multiple runs continue one conversation safely;
- context limiting never creates invalid tool history;
- prompt and workflow versions are present in traces;
- deterministic workflows can be tested without a live provider.

### Milestone 5: MCP integration

Deliverables:

- stdio and Streamable HTTP clients;
- lifecycle management;
- tool discovery and namespacing;
- MCP-to-core schema/content conversion;
- policy annotations from local configuration;
- fixture MCP server and integration suite.

Exit criteria:

- discovered MCP tools execute through the same agent path as local tools;
- transport failures are normalized;
- duplicate tool names cannot silently shadow each other;
- shutdown leaves no child process or open connection behind.

### Milestone 6: Documents, artifacts, and Bedrock

Deliverables:

- artifact store interface and in-memory implementation;
- provider-file lease/lifecycle abstraction;
- image/document request support;
- OpenAI provider-file implementation;
- Bedrock Converse and ConverseStream;
- inline document mapping;
- model/inference-profile discovery;
- Bedrock capability registry and conformance fixtures.

Exit criteria:

- the same document request can use inline or uploaded representations as capabilities require;
- provider file cleanup is testable and observable;
- Bedrock model/tool/document responses normalize to the same core types;
- AWS SDK types do not leak into public core APIs.

### Milestone 7: Composed voice

Deliverables:

- audio content and artifact metadata;
- speech provider contract;
- transcription and synthesis implementations;
- composed voice workflow;
- transcript streaming events where available;
- canonical transcript persistence;
- independent transcript/audio retention settings;
- voice usage and latency telemetry.

Exit criteria:

- typed and spoken turns can alternate in one conversation;
- both user and assistant transcripts appear as canonical messages;
- provider combinations can be mixed;
- the normal agent, MCP, policy, and budget path is used;
- raw audio does not appear in default traces.

### Milestone 8: Realtime voice

Deliverables:

- realtime provider/session contracts;
- normalized realtime events;
- manual commit and provider VAD options;
- interruption/barge-in behavior;
- realtime tool-call integration through the bounded runtime;
- server credential/session support;
- one provider implementation;
- disconnect, cancellation, and transcript-reconciliation tests;
- Bedrock bidirectional voice adapter after the shared contract proves stable.

Exit criteria:

- input and output audio stream concurrently where supported;
- partial transcripts update live and final transcripts persist once;
- interruptions stop output and leave a consistent history;
- tools remain policy-controlled;
- reconnect/failure produces an explicit terminal or recovery state;
- no long-lived provider credential is required in a browser-facing consumer.

### Milestone 9: Release hardening

Deliverables:

- security and privacy review;
- performance benchmarks;
- memory and backpressure tests for streams and audio;
- complete documentation and examples;
- public API review;
- changelog and versioning policy;
- release candidates published from CI;
- migration guidance for existing implementations.

Exit criteria:

- all quality gates pass from packed artifacts;
- capability matrix is verified by conformance tests;
- no high-severity unresolved security issue;
- examples cover every supported package;
- stable release has documented compatibility and deprecation rules.

## 26. Dependency order

```text
core values and events
  -> low-level client
  -> first provider adapter
  -> tools and bounded agent runtime
  -> conversation/context/workflow
  -> MCP
  -> artifacts/documents and second provider
  -> composed voice
  -> realtime voice
  -> release hardening
```

Some work can proceed in parallel after the core contracts stabilize:

- OpenAI fixture mapping and testing utilities;
- conversation store and policy interfaces;
- documentation examples;
- Bedrock discovery research;
- voice event fixtures.

Public contract changes should be cheapest in milestones 0–2 and increasingly controlled afterward.

## 27. Definition of version 1 completeness

Version 1 is complete when a consumer can:

1. configure OpenAI or Bedrock without exposing SDK objects to application logic;
2. send text, images, and documents through the normalized client;
3. request and validate structured output;
4. run a bounded agent with local and MCP tools;
5. apply policy, approval, dry-run, cancellation, and budgets;
6. continue a durable conversation with safe context reduction;
7. execute versioned prompts and declared workflows;
8. inspect an ordered trace and normalized usage;
9. use speech-to-text and text-to-speech while retaining canonical transcripts;
10. run a realtime voice session through the same conversation and tool semantics;
11. test all of the above without live provider credentials.

## 28. Risks and mitigations

### Lowest-common-denominator API

Risk: normalization hides useful provider capabilities.

Mitigation: capability profiles plus namespaced, clearly non-portable adapter extensions. Keep the portable path strong, but do not invent false equivalence.

### Premature package fragmentation

Risk: too many packages make APIs hard to evolve.

Mitigation: begin with the five packages listed above and prefer subpath exports for logical grouping.

### Agent loops causing uncontrolled work

Risk: repeated model/tool calls create cost, latency, or side effects.

Mitigation: finite defaults, policy gates, idempotency awareness, repeated-failure detection, and complete events.

### Conversation corruption

Risk: concurrent runs or trimming break tool history.

Mitigation: optimistic concurrency, atomic append semantics, correlation validation, and pair-safe context strategies.

### Provider event drift

Risk: provider APIs evolve faster than normalized contracts.

Mitigation: isolate translators, maintain payload fixtures, pin compatible SDK ranges, run optional live smoke tests, and version capability declarations.

### Audio complexity leaking into core

Risk: codecs, devices, and transports make the core platform-specific.

Mitigation: core audio metadata and session semantics only; platform/provider packages own capture and transport details.

### Realtime bypassing safety

Risk: low-latency tool calls bypass ordinary agent policy.

Mitigation: treat realtime tool calls as proposals routed through the same registry, policy, budget, and execution services.

### Sensitive content in traces

Risk: documents, transcripts, tool arguments, or audio are logged.

Mitigation: metadata-first tracing, default raw-content exclusion, redaction hooks, explicit retention policies, and tests for secret leakage.

## 29. Decisions to validate during milestones 0–1

These choices should be resolved with small prototypes before freezing the public API:

- whether the core package targets ES2024 or a newer baseline while requiring Node 24;
- the build and API-extraction toolchain;
- the JSON Schema TypeScript representation and validation adapter;
- whether dates cross public boundaries as `Date` or ISO strings in serializable records;
- exact event naming and reduction rules;
- error `cause` exposure and serialization;
- optimistic concurrency token format for conversation stores;
- artifact streaming interface;
- middleware composition and ordering;
- how provider-specific request extensions are typed;
- which realtime adapter should prove the shared session contract first.

These are implementation decisions, not reasons to postpone the architecture. Each should result in a short decision record and a contract test.

## 30. First implementation slice

The first useful vertical slice should be deliberately small:

1. create workspace and package scaffolding;
2. implement text content, messages, requests, responses, usage, and errors;
3. implement `ModelProvider`, `AiClient.generate`, and `AiClient.stream`;
4. add a scripted fake provider and event reducer;
5. add the OpenAI text adapter with fixture tests;
6. add one example that streams a response and prints normalized usage;
7. pack and import both npm packages in a clean fixture project.

Only after this slice proves the package and event boundaries should tool execution be added. That keeps early feedback focused on the most foundational API decisions.

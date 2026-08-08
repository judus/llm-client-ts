# Maduser AI TypeScript: Focused Client Plan

Status: active implementation
Revised: 2026-08-08
Runtime: Node.js 24 or newer
Language: strict TypeScript, ESM

## 1. Outcome

Build one reusable npm package that makes ordinary AI API use ergonomic and consistent across unrelated backend applications.

The client must provide:

- text input and text output;
- recorded-audio input through transcription;
- optional audio output through speech synthesis;
- document input from bytes, URLs, or existing provider file IDs;
- automatic MCP discovery, tool execution, and model continuation;
- storage-neutral chat history when a repository is supplied;
- token-triggered rolling history summaries;
- normalized provider requests, responses, errors, capabilities, and usage;
- a provider abstraction with OpenAI as the only initial implementation.

This is a client library, not an agent platform.

## 2. Explicit exclusions

The suite does not implement:

- permissions or application authorization;
- approval requests or approval UIs;
- tool policy decisions;
- monetary spending enforcement;
- declarative workflows or autonomous planning;
- long-running agents or background job orchestration;
- a web server, REST API, WebSocket gateway, or frontend;
- a database-specific repository;
- live full-duplex voice sessions in the first focused release;
- a second provider before the core/OpenAI contract is proven.

The host application decides whether a request is allowed and what usage is affordable. The client returns usage so the host can make those decisions.

Finite tool steps, timeouts, cancellation, schema validation, and optimistic revisions remain client responsibilities because they are technical correctness bounds.

## 3. Repository layout

The project is one Git repository and one published npm package: `@maduser/ai-ts`.

### Main entry point: `@maduser/ai-ts`

Owns:

- `createAiClient()` and the fluent request API;
- normalized messages and multimodal content;
- `ConfiguredProvider` and low-level provider contracts;
- MCP Streamable HTTP transport and tool normalization;
- repository-backed conversations and context selection;
- rolling history compression;
- recorded-voice composition;
- aggregate usage and normalized errors;
- strict low-level `ModelClient` for adapter authors.

Core production dependencies remain deliberately small:

- the official MCP client SDK;
- Ajv for JSON Schema validation.

### OpenAI entry point: `@maduser/ai-ts/providers/openai`

Owns all OpenAI SDK coupling:

- Responses API request and response mapping;
- text streaming normalization;
- document and image input mapping;
- JSON Schema structured output;
- function-tool mapping;
- audio transcription;
- speech synthesis;
- OpenAI error and usage normalization.

### Testing entry point: `@maduser/ai-ts/testing`

Owns deterministic provider fixtures used by adapter and consumer tests. It has no production role.

The entry points are subfolders of the same package. They do not have separate repositories, manifests, versions, releases, or build pipelines.

## 4. Public API

### 4.1 Provider and client construction

```ts
const ai = createAiClient({
  provider: openAI({
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-5.4',
  }),
  instructions: 'Be concise and cite tool-derived facts.',
  mcp: [
    'http://127.0.0.1:3001/mcp',
    {
      name: 'catalog',
      url: 'https://example.test/mcp',
      headers: async () => ({ authorization: `Bearer ${await token()}` }),
    },
  ],
  history: {
    repository,
    maxContextTokens: 100_000,
  },
});
```

The model is bound by the configured provider. Callers do not repeat provider and model selectors on every request.

### 4.2 Text

```ts
const result = await ai.user('Find information about Sol.').run();
```

There is no mandatory `.request()` step.

### 4.3 Stable chats

```ts
const chat = ai.chat('commander-123');

await chat.user('Tell me about Sol.').run();
await chat.user('Which stations did you mention?').run();
```

Calling `ai.user()` without `.chat(id)` creates an independent generated chat ID and returns it in the result.

### 4.4 MCP overrides and allowlists

```ts
await ai.user('Find Sol.').tools(['catalog.lookup']).run();
```

Semantics:

- no `.mcp()` uses constructor defaults;
- `.mcp([...])` replaces defaults for one request;
- `.addMcp([...])` extends the currently effective list;
- `.mcp([])` disables MCP for one request;
- no `.tools()` exposes all discovered tools;
- `.tools([...])` exposes only the allowlist;
- `.tools([])` exposes no tools;
- an unknown allowed tool fails before the model request;
- an unregistered model-requested tool is never dispatched.

MCP names are deterministic and provider-safe: `server__tool`. The allowlist accepts both `server__tool` and `server.tool`.

### 4.5 Documents

```ts
await ai
  .user('Summarize this.')
  .document({
    bytes: await readFile('manual.pdf'),
    filename: 'manual.pdf',
    mimeType: 'application/pdf',
  })
  .run();
```

The same method accepts an HTTPS URL or an existing provider file ID. The normalized document remains provider-neutral; the selected adapter controls transport representation.

### 4.6 Recorded voice

```ts
const result = await ai
  .chat('commander-123')
  .audio({ bytes: recording, mimeType: 'audio/webm' })
  .speak({ voice: 'alloy' })
  .run();
```

Execution is:

1. transcribe recorded audio;
2. use the final transcript as the canonical user message;
3. run the ordinary history and MCP-capable model turn;
4. optionally synthesize the final assistant text.

Typed and spoken turns therefore share one history. Partial transcription deltas are provider details; only the final transcript is persisted. Audio output is a representation of the assistant text, not a second assistant message.

### 4.7 Result

```ts
interface AiResult {
  chatId: string;
  text: string;
  message: ConversationMessage;
  finishReason: FinishReason;
  transcript?: Transcription;
  audio?: SpeechSynthesis;
  usage: Usage;
}
```

Usage aggregates every provider operation performed for the turn:

- transcription;
- rolling history summary;
- initial model response;
- model continuations after tool results;
- optional speech synthesis.

The client reports usage and never converts it into a permission decision.

## 5. Provider contract

`ConfiguredProvider` binds:

- a stable provider ID;
- the selected model;
- capability lookup;
- complete-response generation;
- streaming generation;
- optional transcription;
- optional speech synthesis.

Provider adapters normalize all external data before returning. Raw SDK objects, provider exceptions, transport event types, and provider-specific usage payloads do not leak into application code.

Unsupported capabilities fail before transport execution where the provider declares enough information to do so.

Only OpenAI is implemented initially. A future provider must prove itself against the existing normalized contract; the core is not widened speculatively for an imagined provider.

## 6. MCP execution contract

The client owns the technical model/tool loop:

1. resolve per-request MCP server configuration;
2. establish Streamable HTTP sessions;
3. discover tools;
4. namespace and validate definitions;
5. apply the optional allowlist;
6. send definitions with the model request;
7. validate requested arguments with JSON Schema;
8. execute requested tools with cancellation and deadlines;
9. normalize text, image, audio, resource, and structured results;
10. return results to the model;
11. continue until final text or the technical step bound is reached;
12. close MCP sessions.

Tool failures become normalized tool results so the model may recover. Cancellation and invalid configuration remain caller-visible errors. No approval or policy hook exists in this path.

The first transport is MCP Streamable HTTP because constructor URL configuration is the primary ergonomic requirement. Additional transports can be introduced only when they do not complicate the ordinary URL path.

## 7. History and repository contract

`ConversationStore` exposes creation, revisioned snapshots, message queries, and atomic append with an expected revision.

The client:

- loads one snapshot before a turn;
- creates the conversation when absent;
- builds context without splitting tool calls from tool results;
- appends the completed turn once;
- rejects concurrent revision conflicts;
- never silently reruns a model or tool after a persistence conflict.

The repository implementation decides whether storage is memory, SQL, a remote API, files, or another system.

### Rolling summaries

Automatic compression is enabled when `maxContextTokens` is configured unless explicitly disabled.

- Default trigger: 80% of available input tokens.
- Default recent window: 50% of available input tokens.
- Output and anticipated tool-result reserves are removed before these calculations.
- Tool call/result groups stay together.
- Raw source messages remain stored.
- The rolling summary is a derived developer message with lineage metadata.
- Subsequent summaries merge the previous checkpoint with newly omitted messages.
- Summary token usage is included in the turn result.

The estimator is deterministic and conservative. A provider-specific estimator may be introduced later behind the same contract.

## 8. Documents and binary data

Public binary values use `Uint8Array`; framework streams and SDK file objects are excluded.

Supported sources are:

- materialized bytes;
- an HTTP or HTTPS URL;
- an existing provider file ID explicitly tagged with its provider.

Adapters enforce provider-specific MIME types, byte limits, filename rules, URL schemes, and provider-file ownership. The focused client does not contain a general artifact store or file-lease subsystem.

## 9. Voice boundary

The focused release supports recorded turns, not full-duplex realtime sessions.

Reasons:

- recorded transcription composes cleanly with the normal MCP loop;
- the final transcript naturally becomes canonical history;
- optional speech output does not require a second conversation protocol;
- browser microphone capture and playback belong to application UI code;
- realtime interruption, VAD, ephemeral browser credentials, and duplex transport would materially widen the package.

Realtime can be reconsidered as a separate package after the basic client is stable. It must not distort the recorded-turn API.

## 10. Failure model

The suite exposes stable `AiError` categories and codes for:

- invalid requests;
- unsupported capabilities;
- authentication and authorization failures reported by providers;
- rate limits and provider unavailability;
- transport and timeout failures;
- cancellation;
- malformed provider or MCP responses;
- tool input/output validation and execution failures;
- persistence conflicts;
- structured-output validation;
- provider content filtering or refusal.

Secrets, raw request authorization headers, and diagnostic causes are never returned to the model as tool content.

## 11. Quality standard

The suite follows the same discipline expected from the Argon projects:

- strict TypeScript including unchecked-index and exact-optional checks;
- no public `any`;
- `unknown` plus validation at external boundaries;
- immutable or defensively copied stored values;
- minimal public exports;
- provider SDK isolation;
- deterministic tests without live credentials;
- real protocol integration tests where practical;
- zero-warning lint and format gates;
- enforced coverage thresholds;
- local Git commits representing coherent milestones.

The primary gate is:

```bash
pnpm check
```

Live OpenAI smoke tests remain opt-in because they require user credentials and incur cost. Mock transport tests must cover ordinary behavior without a key.

## 12. Current implementation status

Implemented:

- one standard TypeScript package with a single build and quality gate;
- normalized low-level provider contract;
- fluent text API;
- constructor and per-request MCP configuration;
- dynamic MCP headers;
- tool discovery, allowlists, validation, execution, and continuation;
- optimistic repository-backed history;
- token-aware context selection;
- rolling history summaries with retained raw messages;
- document byte, URL, and provider-file inputs;
- recorded-audio transcription path;
- optional speech synthesis;
- aggregate usage;
- OpenAI Responses, transcription, and speech adapters;
- deterministic provider and MCP fixtures.

Remaining before the first publishable alpha:

1. finish public API examples;
2. add failure-path tests for the new fluent MCP/history composition;
3. run the complete quality gate;
4. optionally run one credentialed OpenAI smoke test supplied by the user.

## 13. Future work, in order

After the alpha contract is stable:

1. fluent streaming that preserves the same final result and history semantics;
2. explicit structured-output ergonomics on the fluent builder;
3. provider-specific token estimators;
4. discovery caching with clear invalidation and credential scoping;
5. another provider implementation chosen from an actual consumer requirement;
6. later ports of feasible contracts to Python and PHP.

The TypeScript design is not simplified for future ports. Each port should preserve semantic contracts where its runtime permits and document unavoidable differences locally.

# ADR 0008: Keep MCP transport narrow and policy local

- Status: accepted
- Date: 2026-08-07

## Decision

The MCP package uses the official TypeScript client for protocol negotiation and transport behavior, while exposing a small suite-owned `McpSession` seam to the broker. The public factories support stdio and Streamable HTTP. SDK wire types are converted immediately into JSON-oriented suite contracts before entering tool discovery or execution.

Every server receives a stable local ID and namespace. Remote tool names become `namespace__tool`; duplicates and non-portable names are rejected before registry construction. Discovery is explicitly cacheable and invalidatable. Calls use per-server concurrency limits, request timeouts, propagated cancellation, and the deadline supplied by the core tool runtime.

Tool policy annotations are supplied only by trusted local configuration keyed by the original remote name. Remote descriptions and schemas may inform a model, but remote metadata never grants authority or bypasses core policy and approval checks.

MCP tool output is converted into core text, image, audio, and document content. Protocol, malformed-data, cancellation, tool-level, transport, and aggregate shutdown failures are normalized as core errors while retaining diagnostic causes.

## Consequences

- MCP tools and local tools execute through one core registry and bounded-agent path.
- Applications can substitute a deterministic session without emulating SDK internals.
- SDK changes are contained behind the session adapter and conversion boundary.
- Names cannot silently collide across servers.
- Closing a client is terminal; a failed connection remains retryable.
- Resources and prompts can be added later without widening the initial tool contract.

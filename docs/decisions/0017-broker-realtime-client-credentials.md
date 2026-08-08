# ADR 0017: Broker realtime client credentials

- Status: accepted
- Date: 2026-08-08

## Decision

Browser and mobile realtime clients use short-lived provider credentials issued by a trusted server boundary. They never receive the server's long-lived OpenAI API key.

Core defines only `RealtimeClientSecret` and `RealtimeClientSecretIssuer`. The credential value is opaque, accompanied by its provider, provider session ID, and absolute expiry, and is explicitly excluded from logs and traces. Core does not prescribe HTTP routing, authentication, authorization, rate limiting, or client delivery; those remain consumer responsibilities.

`OpenAIRealtimeClientSecretIssuer` validates the complete provider-neutral session configuration before provider I/O, requires OpenAI-owned realtime and transcription model selectors, enforces OpenAI audio constraints, and maps manual commit, server VAD, audio formats, voice, instructions, and optional input transcription into the client-secret request. Secret lifetime defaults to 600 seconds and is bounded to the provider-supported range of 10 through 7,200 seconds.

The OpenAI SDK stays behind an SDK-free transport port. Malformed, empty, or already-expired provider credentials fail before reaching the caller. Issuance is separate from WebSocket and WebRTC transports so trusted-server and untrusted-client deployment boundaries remain explicit.

## Consequences

- Browser-facing consumers can establish provider sessions without a long-lived API key.
- Consumers must authenticate and authorize their own credential endpoint and must avoid caching or recording its response.
- Provider session configuration is checked consistently at the server boundary rather than failing after a client connects.
- Realtime transport adapters can share the same core session contract without sharing a credential-delivery mechanism.
- Credential refresh and session reconnection remain explicit future runtime concerns.

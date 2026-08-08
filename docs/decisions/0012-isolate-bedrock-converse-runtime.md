# ADR 0012: Isolate the Bedrock Converse runtime

- Status: accepted
- Date: 2026-08-08

## Decision

The first Bedrock provider slice targets `Converse` and `ConverseStream` through a provider-owned runtime transport. AWS SDK commands, response unions, credential resolution, retry machinery, and socket lifecycle remain inside `@maduser/ai-ts-bedrock`. The public mapping and transport contracts use only suite types, JSON values, `Uint8Array`, `AbortSignal`, and async iterables.

Request mapping is deterministic and has no storage or network side effects. Images and documents must already be inline bytes. The mapper validates provider ownership, supported MIME types, Bedrock role restrictions, document companion text, neutral document names, counts, and byte sizes before transport. It cannot validate image dimensions without adding an image decoder, so callers remain responsible for the provider's pixel limit.

Streaming SDK unions normalize into a small adapter event stream before the provider assembles canonical text, tool calls, usage, stop reasons, and terminal responses. Unknown or malformed required provider values fail as `malformed_response`; embedded stream exceptions and thrown SDK errors use stable core categories. Abort signals and deadlines reach the SDK. Converse idempotency keys are rejected because the API offers no corresponding guarantee.

The provider owns the AWS runtime client and exposes `close()` to destroy its HTTP resources. The standard AWS region and credential chains remain available when explicit configuration is absent.

## Consequences

- Application and core code never depend on AWS SDK types.
- Fixture transports can test complete generation and streaming behavior without AWS credentials.
- Inline documents, strict tools, structured output, and multimodal tool results share the same normalized core contracts as other providers.
- Capability declaration must remain model-aware: translation support in the adapter does not prove support in every Bedrock model.
- Model and inference-profile discovery, the tested capability registry, S3-backed inputs, and bidirectional voice remain separate additions rather than hidden runtime behavior.

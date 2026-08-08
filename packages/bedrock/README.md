# `@maduser/ai-ts-bedrock`

Amazon Bedrock provider adapter for `@maduser/ai-ts`.

The current alpha uses the Bedrock Runtime Converse and ConverseStream APIs for text, image, and inline-document input; text generation; tools; streaming; and structured-output request mapping. AWS SDK values are normalized at the transport boundary and do not cross into core application code.

```ts
import { AiClient } from '@maduser/ai-ts';
import { createBedrockProvider } from '@maduser/ai-ts-bedrock';

const provider = createBedrockProvider({ region: 'eu-central-1' });
const client = new AiClient(provider);

try {
  // Generate or stream through the provider-neutral client.
} finally {
  provider.close();
}
```

When explicit credentials are omitted, the underlying AWS SDK uses its standard credential chain. Region may likewise come from the standard SDK configuration chain. The runtime client is owned by the provider and `close()` destroys it explicitly.

## Images and documents

The adapter accepts inline bytes for GIF, JPEG, PNG, and WEBP images and for CSV, DOC, DOCX, HTML, Markdown, PDF, TXT, XLS, and XLSX documents. It enforces the Converse request limits of twenty images at 3.75 MB each and five documents at 4.5 MB each. Image dimensions are not decoded locally, so the provider's 8,000-pixel dimension limit remains a caller-side responsibility.

Documents require companion text and a neutral filename. The mapper removes the final extension for the Bedrock document name but rejects unsafe characters instead of silently rewriting potentially instruction-like names. URL, artifact, and provider-file sources fail before network I/O; applications must materialize those sources to bytes explicitly.

Tool definitions use strict schemas. Tool results may contain JSON, text, images, and documents. Converse has no idempotency-key field, so supplying a core `idempotencyKey` fails explicitly rather than suggesting replay protection that does not exist.

## Capability scope

The default capability declaration describes what this adapter can translate, not what every Bedrock model supports. Applications using a narrower model can provide static `capabilities` or a `BedrockCapabilityRegistry` through `capabilityResolver`. Configuring both fails explicitly.

Registry entries are exact model IDs. When supplied with a discovery catalog, the registry resolves inference-profile IDs from their underlying models. A profile spanning multiple different models receives the conservative intersection of every registered capability and limit; an unknown model fails before runtime I/O unless the registry has an explicit fallback.

## Discovery

`BedrockDiscoveryClient` normalizes foundation models and paginated inference profiles behind `BedrockDiscoveryTransport`. It validates every untrusted field, limits page count and size, detects token cycles and duplicate IDs, correlates foundation-model ARNs, and recommends active inference-profile IDs for invocation. System-defined profiles are the default; application profiles or all profiles can be requested explicitly.

The Bedrock control-plane API reports modalities, streaming, inference types, and lifecycle state. It does not prove Converse tools, inline documents, or structured output for a particular model, so discovery never synthesizes those capabilities. They remain explicit, tested registry data.

This alpha exposes the transport contract for fixture and application adapters. A packaged AWS control-plane SDK transport is still pending; the runtime SDK client does not contain `ListFoundationModels` or `ListInferenceProfiles`.

Bidirectional voice is also outside this runtime slice. The package is not ready for public release yet.

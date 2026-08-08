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

The default capability declaration describes what this adapter can translate, not what every Bedrock model supports. Applications using a narrower model must provide an appropriately restricted `capabilities` value. Model discovery and a tested model-specific capability registry remain pending work in this milestone.

Bidirectional voice is also outside this runtime slice. The package is not ready for public release yet.

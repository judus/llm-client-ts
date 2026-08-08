# ADR 0013: Separate Bedrock discovery from capability truth

- Status: accepted
- Date: 2026-08-08

## Decision

Bedrock control-plane discovery and model capability declaration are separate contracts.

`BedrockDiscoveryClient` accepts a control-plane transport that returns untrusted payloads. The client validates and normalizes foundation models, lifecycle timestamps, inference profiles, and model ARNs. Inference-profile pagination has explicit page and page-size bounds, rejects repeated continuation tokens and duplicate identifiers, and defaults to system-defined cross-Region profiles. The resulting catalog correlates profiles to foundation models and exposes preferred invocation IDs without exposing AWS SDK values.

Discovery fields such as input modalities and streaming support are retained as provider facts, but they do not establish support for every normalized feature. Tools, strict schemas, structured output, inline documents, and model-specific limits require explicit capability entries. `BedrockCapabilityRegistry` resolves exact model IDs and can correlate inference-profile IDs through a discovery catalog. A profile spanning several models receives the boolean intersection of their capabilities and only limits known for every model. Unknown models return no capabilities unless the application configures an explicit conservative fallback.

The provider accepts either static capabilities or a resolver. Supplying both is an error. A resolver that has no entry for the selected model fails during capability validation before a runtime request is sent.

## Consequences

- A changing provider catalog cannot silently enable an untested feature.
- Discovery remains useful for selection, lifecycle visibility, and cross-Region invocation routing.
- Capability entries can be versioned and tested independently from live account availability.
- Multi-model application inference profiles cannot claim a feature that only one member supports.
- The control-plane SDK transport can be added independently; the normalization and public discovery contract do not depend on SDK-generated types.

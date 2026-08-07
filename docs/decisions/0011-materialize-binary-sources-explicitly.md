# ADR 0011: Materialize binary sources explicitly

- Status: accepted
- Date: 2026-08-07

## Decision

Provider request mapping is synchronous and free of storage, network, and upload side effects. A normalized image or document may reach the OpenAI mapper as inline bytes, a credential-free HTTP(S) URL, or an OpenAI provider-file ID. These representations map directly to a Responses message while retaining their order relative to text.

An artifact reference is intentionally not resolved inside the mapper. The application must read the artifact and choose either inline bytes or an explicitly acquired provider-file lease before calling the model. Provider-file upload, reuse, expiry, release, and cleanup therefore remain visible lifecycle operations instead of hidden consequences of request serialization.

The mapper validates MIME types, filenames, URLs, provider ownership, provider file IDs, image count, inline document bytes, and encoded inline image payload before transport. It never fetches a URL locally. Tool-result serialization remains a separate path and does not silently discard binary message content.

## Consequences

- The same `DocumentPart` supports inline and uploaded representations by changing only its source discriminator.
- Pure mapping stays deterministic, cheap to test, and safe to call for both streaming and non-streaming requests.
- Cancellation and cleanup ownership do not become ambiguous through an implicit upload.
- Applications need an explicit materialization step when conversation history stores artifact references.
- Future convenience APIs may compose artifact lookup and provider-file leasing, but they must return or manage the lease explicitly and may not change mapper semantics.

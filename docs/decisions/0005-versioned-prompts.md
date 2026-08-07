# ADR 0005: Immutable versioned prompts

- Status: accepted
- Date: 2026-08-07

## Decision

Prompts are immutable definitions addressed by stable name and version. Registration rejects duplicate identities. Environment selection is a separate mutable binding from `(prompt name, environment)` to an existing version, so deployment routing never changes semantic version identity.

Each definition declares a JSON Schema draft 2020-12 variables contract. Rendering validates variables first, resolves explicit scalar placeholders, and rejects missing or structured interpolation. The rendered text, prompt identity, and canonicalized variables produce a SHA-256 fingerprint.

Definitions and rendered variables are defensively copied at registry boundaries. Transient application state is supplied only as render variables and is not added to the stored definition.

## Consequences

- Traces can record prompt name, version, and fingerprint without retaining full prompt content.
- Tests can bind environments independently from immutable fixture definitions.
- Objects and arrays require deliberate serialization before interpolation.
- Updating environment routing does not mutate or invalidate historical prompt references.

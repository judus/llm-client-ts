# ADR 0002: Modules and public API boundaries

- Status: accepted
- Date: 2026-08-07

## Decision

Packages are ESM-only and publish JavaScript, declarations, declaration maps, and source maps. Public access is limited to explicit package exports.

The core uses portable values at public boundaries: `Uint8Array`, `AbortSignal`, async iterables, JSON-compatible values, and JSON Schema. Provider SDK values are decoded and normalized inside adapter packages.

Source is compiled with maximum practical TypeScript strictness. Untrusted provider, persistence, tool, and network data enters as `unknown` and must be validated before becoming a domain value.

## Consequences

- Internal file paths are not public API.
- Package tarballs, not workspace source paths, are the release unit.
- Core cannot expose Node.js `Buffer` or provider SDK types.
- Convenience APIs must delegate to the same strict semantics as lower-level APIs.

# ADR 0001: Suite, runtime, and repository model

- Status: accepted
- Date: 2026-08-07

## Decision

The project is a pnpm workspace in one Git repository. It publishes multiple independent npm packages under the `@maduser/ai-ts*` name family.

The supported runtime starts at Node.js 24. Development and CI pin a concrete Node.js and pnpm version. Compatibility is claimed only for runtimes exercised by CI and packed-artifact tests.

TypeScript 6.0.2 is pinned initially. TypeScript 7.0.2 exists, but the current `typescript-eslint` 8.66.0 peer range ends below TypeScript 6.1. A fully supported strict-analysis toolchain is more valuable than adopting an unsupported compiler/parser combination. The compiler will be upgraded when the analysis toolchain supports it.

## Consequences

- Cross-package contract changes can be atomic.
- Each package retains its own npm version and dependency surface.
- Provider SDKs cannot enter the core package dependency graph.
- Node.js 24 language and runtime facilities may be used intentionally.
- Runtime and toolchain upgrades require CI and packed-artifact evidence.

# Maduser AI TypeScript Suite

A provider-neutral AI client and bounded agent runtime for serious application development.

The suite is under active construction. Its packages are intentionally independent at the npm boundary while sharing one repository, one contract test system, and one quality standard.

## Packages

- `@maduser/ai-ts` — normalized core contracts and runtime.
- `@maduser/ai-ts-openai` — OpenAI adapter.
- `@maduser/ai-ts-bedrock` — Amazon Bedrock adapter.
- `@maduser/ai-ts-mcp` — Model Context Protocol integration.
- `@maduser/ai-ts-testing` — conformance fixtures and test utilities.

## Requirements

- Node.js 24 or newer.
- pnpm 11.20.0 through Corepack.

## Development

```bash
corepack enable
pnpm install
pnpm check
```

Architecture and implementation decisions live in [`docs/decisions`](docs/decisions). The full project plan is maintained in [`.context/project-plan.md`](.context/project-plan.md).

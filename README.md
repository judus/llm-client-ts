# Maduser AI TypeScript

A focused, provider-neutral AI client for Node.js applications.

```ts
import { createAiClient } from '@maduser/ai-ts';
import { openAI } from '@maduser/ai-ts/providers/openai';

const ai = createAiClient({
  provider: openAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-5.4' }),
  mcp: [{ name: 'system', url: 'http://127.0.0.1:3001/mcp' }],
});

const result = await ai.user('Find information about Sol.').run();
console.log(result.text, result.usage);
```

## Entry points

- `@maduser/ai-ts` — fluent client, MCP execution, history, documents, and voice.
- `@maduser/ai-ts/providers/openai` — OpenAI Responses, transcription, and speech.
- `@maduser/ai-ts/testing` — deterministic test utilities.

This is one npm package in one ordinary repository. It intentionally contains no approval system, permission policy, autonomous-agent framework, or workflow engine. The host application owns business authorization and spending decisions; the client reports provider usage.

## Requirements

- Node.js 24 or newer.
- pnpm 11.20.0 through Corepack.

```bash
corepack enable
pnpm install
pnpm check
```

The implementation plan is maintained in [`.context/project-plan.md`](.context/project-plan.md).

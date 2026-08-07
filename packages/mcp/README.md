# `@maduser/ai-ts-mcp`

Model Context Protocol tool integration for `@maduser/ai-ts`.

The package discovers tools through the official MCP TypeScript client and exposes them as ordinary core `LocalTool` executors. It supports locally launched stdio servers and remote Streamable HTTP servers.

```ts
import { BoundedAgentRuntime, type AiClient } from '@maduser/ai-ts';
import { McpToolBroker, McpToolClient, createStdioMcpSession } from '@maduser/ai-ts-mcp';

declare const client: AiClient;

const filesystem = new McpToolClient({
  annotations: {
    read_file: { readOnly: true },
    write_file: { destructive: true, requiresApproval: true },
  },
  namespace: 'filesystem',
  serverId: 'local-filesystem',
  session: createStdioMcpSession({
    args: ['server.js'],
    client: { name: 'my-app', version: '1.0.0' },
    command: 'node',
  }),
});

const broker = new McpToolBroker({ clients: [filesystem] });
const tools = await broker.registry();
const runtime = new BoundedAgentRuntime({ client, tools });

try {
  // Run the agent through the same bounded path used for local tools.
} finally {
  await broker.close();
}
```

## Guarantees

- Remote names are qualified as `namespace__tool` and validated for portable provider limits.
- Discovery is cached until `force: true` is requested or `invalidate()` is called.
- Each server has a bounded concurrency queue and request timeout.
- Cancellation and caller deadlines propagate to MCP calls.
- MCP tool-level, transport, cancellation, validation, and shutdown failures become typed core errors with diagnostic causes.
- Text, image, audio, embedded resource, and resource-link results convert into core content.
- A failed connection may be retried; `close()` is terminal and idempotent.

Policy annotations come only from local configuration. Remote metadata is descriptive input and is never treated as an authorization decision. The core policy engine remains responsible for approval and execution decisions.

MCP resources and prompts are intentionally outside this first tool-focused API.

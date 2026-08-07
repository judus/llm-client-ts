import { AiError, ToolRegistry, type LocalTool } from '@maduser/ai-ts';

import type { McpToolBrokerOptions } from './types.js';

/** Aggregates multiple namespaced MCP servers into the ordinary core tool path. */
export class McpToolBroker {
  readonly #clients: McpToolBrokerOptions['clients'];

  public constructor(options: McpToolBrokerOptions) {
    const serverIds = new Set<string>();
    for (const client of options.clients) {
      if (serverIds.has(client.serverId)) {
        throw new AiError('invalid_request', `MCP server ${client.serverId} is duplicated.`, {
          code: 'duplicate_mcp_server',
          details: { serverId: client.serverId },
        });
      }
      serverIds.add(client.serverId);
    }
    this.#clients = [...options.clients];
  }

  public async discover(
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<readonly LocalTool[]> {
    const discoveries = await Promise.all(this.#clients.map((client) => client.discover(options)));
    const tools = discoveries.flatMap(({ tools }) => tools);
    const names = new Set<string>();
    for (const tool of tools) {
      if (names.has(tool.definition.name)) {
        throw new AiError('invalid_request', `MCP tool ${tool.definition.name} is duplicated.`, {
          code: 'duplicate_qualified_mcp_tool',
          details: { toolName: tool.definition.name },
        });
      }
      names.add(tool.definition.name);
    }
    return tools;
  }

  public async registry(
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ToolRegistry> {
    return new ToolRegistry(await this.discover(options));
  }

  public invalidate(): void {
    for (const client of this.#clients) {
      client.invalidate();
    }
  }

  public async close(): Promise<void> {
    const results = await Promise.allSettled(this.#clients.map((client) => client.close()));
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      const reasons: unknown[] = [];
      for (const failure of failures) {
        const reason: unknown = Reflect.get(failure, 'reason');
        reasons.push(reason);
      }
      throw new AiError('transport', 'One or more MCP clients failed to close.', {
        cause: new AggregateError(reasons),
        code: 'mcp_broker_close_failed',
        details: { failures: failures.length },
      });
    }
  }
}

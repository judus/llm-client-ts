import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ContentBlock,
  type Tool,
} from '@modelcontextprotocol/client';

import { AiError } from './error.js';
import type { JsonObject, JsonValue } from './json.js';
import type { LocalTool, ToolExecutionContext, ToolExecutionOutput } from './tool-registry.js';
import type { ToolResultContentPart } from './content.js';

export interface McpServerOptions {
  /** Fetch implementation, primarily for custom transports and deterministic tests. */
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?:
    | Readonly<Record<string, string>>
    | (() => Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>);
  readonly name?: string;
  readonly timeoutMs?: number;
  readonly url: string | URL;
}

export type McpServer = McpServerOptions | string | URL;

interface NormalizedMcpServer {
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: McpServerOptions['headers'];
  readonly name: string;
  readonly timeoutMs: number;
  readonly url: URL;
}

interface OpenMcpServer {
  readonly close: () => Promise<void>;
  readonly tools: readonly LocalTool[];
}

/** Opens the requested MCP servers and returns their namespaced tools. */
export async function openMcpServers(
  inputs: readonly McpServer[],
  signal?: AbortSignal,
): Promise<{ readonly close: () => Promise<void>; readonly tools: readonly LocalTool[] }> {
  const normalized = normalizeMcpServers(inputs);
  const opened: OpenMcpServer[] = [];
  try {
    for (const server of normalized) {
      opened.push(await openMcpServer(server, signal));
    }
  } catch (error) {
    await Promise.allSettled(opened.map(async (server) => server.close()));
    throw error;
  }

  return {
    close: async (): Promise<void> => {
      const results = await Promise.allSettled(opened.map(async (server) => server.close()));
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failures.length > 0) {
        const reasons: unknown[] = [];
        for (const failure of failures) {
          const reason: unknown = Reflect.get(failure, 'reason');
          reasons.push(reason);
        }
        throw new AiError('transport', 'One or more MCP connections failed to close.', {
          cause: new AggregateError(reasons),
          code: 'mcp_close_failed',
          details: { failures: failures.length },
        });
      }
    },
    tools: opened.flatMap((server) => server.tools),
  };
}

async function openMcpServer(
  server: NormalizedMcpServer,
  signal?: AbortSignal,
): Promise<OpenMcpServer> {
  const headers = await resolveHeaders(server.headers);
  const client = new Client(
    { name: '@maduser/ai-ts', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  const transport = new StreamableHTTPClientTransport(server.url, {
    ...(server.fetch === undefined ? {} : { fetch: server.fetch }),
    ...(headers === undefined ? {} : { requestInit: { headers } }),
  });
  try {
    await runMcpOperation(client.connect(transport), server, 'connect', signal);
    const discovery = await runMcpOperation(
      client.listTools(undefined, requestOptions(server, signal)),
      server,
      'discover',
      signal,
    );
    const remoteNames = new Set<string>();
    const tools = discovery.tools.map((tool): LocalTool => {
      if (remoteNames.has(tool.name)) {
        throw new AiError(
          'malformed_response',
          `MCP server returned duplicate tool ${tool.name}.`,
          {
            code: 'duplicate_mcp_tool',
            details: { server: server.name, tool: tool.name },
          },
        );
      }
      remoteNames.add(tool.name);
      return mapTool(client, server, tool);
    });
    return { close: async (): Promise<void> => client.close(), tools };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw normalizeMcpError(error, server, 'connect', signal);
  }
}

function mapTool(client: Client, server: NormalizedMcpServer, tool: Tool): LocalTool {
  const name = qualifyToolName(server.name, tool.name);
  return {
    definition: {
      description: tool.description ?? `MCP tool ${tool.name} from ${server.name}.`,
      inputSchema: jsonObject(tool.inputSchema, 'MCP tool input schema'),
      name,
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: jsonObject(tool.outputSchema, 'MCP tool output schema') }),
    },
    execute: async (
      arguments_: JsonObject,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutput> => {
      const deadlineMs = Date.parse(context.deadline) - Date.now();
      if (deadlineMs <= 0) {
        throw new AiError('timeout', `MCP tool ${name} missed its deadline.`, {
          code: 'mcp_tool_deadline_exceeded',
          details: { tool: name },
        });
      }
      const operationServer = { ...server, timeoutMs: Math.min(server.timeoutMs, deadlineMs) };
      const result = await runMcpOperation(
        client.callTool(
          { arguments: arguments_, name: tool.name },
          requestOptions(operationServer, context.signal),
        ),
        operationServer,
        'call_tool',
        context.signal,
      );
      return mapResult(result, server, tool.name);
    },
  };
}

function mapResult(
  result: CallToolResult,
  server: NormalizedMcpServer,
  toolName: string,
): ToolExecutionOutput {
  if (result.isError === true) {
    throw new AiError('tool_execution', `MCP tool ${toolName} reported an error.`, {
      code: 'mcp_tool_reported_error',
      details: { server: server.name, tool: toolName },
    });
  }
  const structuredContent =
    result.structuredContent === undefined
      ? undefined
      : jsonValue(result.structuredContent, 'MCP structured content');
  return {
    content: result.content.map(mapContent),
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function mapContent(content: ContentBlock): ToolResultContentPart {
  switch (content.type) {
    case 'audio':
      return {
        mimeType: content.mimeType,
        source: { bytes: decodeBase64(content.data), type: 'bytes' },
        type: 'audio',
      };
    case 'image':
      return {
        mimeType: content.mimeType,
        source: { bytes: decodeBase64(content.data), type: 'bytes' },
        type: 'image',
      };
    case 'resource':
      return 'text' in content.resource
        ? { source: 'generated', text: content.resource.text, type: 'text' }
        : {
            mimeType: content.resource.mimeType ?? 'application/octet-stream',
            source: { bytes: decodeBase64(content.resource.blob), type: 'bytes' },
            title: content.resource.uri,
            type: 'document',
          };
    case 'resource_link':
      return {
        filename: content.name,
        mimeType: content.mimeType ?? 'application/octet-stream',
        source: { type: 'url', url: content.uri },
        ...(content.title === undefined ? {} : { title: content.title }),
        type: 'document',
      };
    case 'text':
      return { source: 'generated', text: content.text, type: 'text' };
  }
}

function normalizeMcpServers(inputs: readonly McpServer[]): readonly NormalizedMcpServer[] {
  const names = new Set<string>();
  return inputs.map((input, index) => {
    const options: McpServerOptions =
      typeof input === 'string' || input instanceof URL ? { url: input } : input;
    let url: URL;
    try {
      url = new URL(options.url);
    } catch (cause) {
      throw new AiError('invalid_request', 'MCP server URL is invalid.', {
        cause,
        code: 'invalid_mcp_url',
      });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AiError('invalid_request', 'MCP server URL must use HTTP or HTTPS.', {
        code: 'invalid_mcp_protocol',
        details: { protocol: url.protocol },
      });
    }
    const name = normalizeServerName(options.name ?? derivedServerName(url, index));
    if (names.has(name)) {
      throw new AiError('invalid_request', `MCP server name ${name} is duplicated.`, {
        code: 'duplicate_mcp_server_name',
        details: { name },
      });
    }
    names.add(name);
    return {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      name,
      timeoutMs: positiveInteger(options.timeoutMs ?? 30_000, 'MCP timeout'),
      url,
    };
  });
}

function derivedServerName(url: URL, index: number): string {
  const value = `${url.hostname}_${url.port || (url.protocol === 'https:' ? '443' : '80')}`
    .replaceAll(/[^A-Za-z0-9_-]/gu, '_')
    .slice(0, 40);
  return value.length === 0 ? `mcp_${String(index + 1)}` : value;
}

function normalizeServerName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/u.test(value)) {
    throw new AiError('invalid_request', `Invalid MCP server name: ${value}.`, {
      code: 'invalid_mcp_server_name',
    });
  }
  return value;
}

function qualifyToolName(serverName: string, toolName: string): string {
  const normalizedTool = toolName.replaceAll(/[^A-Za-z0-9_-]/gu, '_');
  const qualified = `${serverName}__${normalizedTool}`;
  if (normalizedTool.length === 0 || qualified.length > 64) {
    throw new AiError('invalid_request', `MCP tool name cannot be safely qualified: ${toolName}.`, {
      code: 'invalid_mcp_tool_name',
      details: { server: serverName, tool: toolName },
    });
  }
  return qualified;
}

async function resolveHeaders(
  value: McpServerOptions['headers'],
): Promise<Readonly<Record<string, string>> | undefined> {
  return typeof value === 'function' ? value() : value;
}

function requestOptions(
  server: Pick<NormalizedMcpServer, 'timeoutMs'>,
  signal?: AbortSignal,
): { readonly maxTotalTimeout: number; readonly signal?: AbortSignal; readonly timeout: number } {
  return {
    maxTotalTimeout: server.timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    timeout: server.timeoutMs,
  };
}

async function runMcpOperation<T>(
  operation: Promise<T>,
  server: NormalizedMcpServer,
  action: 'call_tool' | 'connect' | 'discover',
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    throw normalizeMcpError(error, server, action, signal);
  }
}

function normalizeMcpError(
  error: unknown,
  server: NormalizedMcpServer,
  action: 'call_tool' | 'connect' | 'discover',
  signal?: AbortSignal,
): AiError {
  if (error instanceof AiError) {
    return error;
  }
  if (signal?.aborted === true) {
    return new AiError('cancelled', `MCP ${action} was cancelled.`, {
      cause: error,
      code: 'mcp_operation_cancelled',
      details: { action, server: server.name },
    });
  }
  return new AiError('transport', `MCP ${action} failed for ${server.name}.`, {
    cause: error,
    code: 'mcp_operation_failed',
    details: { action, server: server.name },
    retryable: action !== 'call_tool',
  });
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new AiError('malformed_response', 'MCP returned invalid base64 content.', {
      code: 'invalid_mcp_base64',
    });
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function jsonObject(value: unknown, label: string): JsonObject {
  const converted = jsonValue(value, label);
  if (converted === null || typeof converted !== 'object' || isJsonArray(converted)) {
    throw invalidJson(label);
  }
  return converted;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function jsonValue(value: unknown, label: string, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw invalidJson(label);
  }
  ancestors.add(value);
  const result: JsonValue = Array.isArray(value)
    ? value.map((item) => jsonValue(item, label, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, jsonValue(item, label, ancestors)]),
      );
  ancestors.delete(value);
  return result;
}

function invalidJson(label: string): AiError {
  return new AiError('malformed_response', `${label} is not valid JSON.`, {
    code: 'invalid_mcp_json',
  });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AiError('invalid_request', `${label} must be a positive integer.`, {
      code: 'invalid_mcp_limit',
      details: { label, value },
    });
  }
  return value;
}

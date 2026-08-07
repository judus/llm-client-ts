import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ContentBlock,
  type Tool,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AiError, type JsonObject, type JsonValue } from '@maduser/ai-ts';

import type {
  McpContentBlock,
  McpOperationOptions,
  McpRemoteTool,
  McpRemoteToolResult,
  McpSession,
  StdioMcpSessionOptions,
  StreamableHttpMcpSessionOptions,
} from './types.js';

/** Official MCP SDK v2 session behind the suite's narrow protocol seam. */
export class SdkMcpSession implements McpSession {
  readonly #client: Client;
  readonly #transport: Transport;

  public constructor(client: Client, transport: Transport) {
    this.#client = client;
    this.#transport = transport;
  }

  public async connect(options: McpOperationOptions): Promise<void> {
    try {
      await raceAbort(this.#client.connect(this.#transport), options.signal, options.timeoutMs);
    } catch (error) {
      await this.#client.close().catch(() => undefined);
      throw error;
    }
  }

  public async listTools(options: McpOperationOptions): Promise<readonly McpRemoteTool[]> {
    const result = await this.#client.listTools(undefined, requestOptions(options));
    return result.tools.map(convertTool);
  }

  public async callTool(
    name: string,
    arguments_: JsonObject,
    options: McpOperationOptions,
  ): Promise<McpRemoteToolResult> {
    const result = await this.#client.callTool(
      { arguments: arguments_, name },
      requestOptions(options),
    );
    return convertResult(result);
  }

  public close(): Promise<void> {
    return this.#client.close();
  }
}

export function createStdioMcpSession(options: StdioMcpSessionOptions): McpSession {
  const client = createClient(options.client, options.protocolNegotiation);
  const transport = new StdioClientTransport({
    ...(options.args === undefined ? {} : { args: [...options.args] }),
    command: options.command,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    ...(options.maxBufferSize === undefined ? {} : { maxBufferSize: options.maxBufferSize }),
    stderr: options.stderr ?? 'inherit',
  });
  return new SdkMcpSession(client, transport);
}

export function createStreamableHttpMcpSession(
  options: StreamableHttpMcpSessionOptions,
): McpSession {
  const client = createClient(options.client, options.protocolNegotiation);
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.headers === undefined ? {} : { requestInit: { headers: options.headers } }),
  });
  return new SdkMcpSession(client, transport);
}

function createClient(
  identity: { readonly name: string; readonly version: string },
  mode: 'auto' | 'legacy' = 'auto',
): Client {
  return new Client(identity, { versionNegotiation: { mode } });
}

function requestOptions(options: McpOperationOptions): {
  readonly maxTotalTimeout: number;
  readonly signal?: AbortSignal;
  readonly timeout: number;
} {
  return {
    maxTotalTimeout: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeout: options.timeoutMs,
  };
}

function convertTool(tool: Tool): McpRemoteTool {
  return {
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: cloneJsonObject(tool.inputSchema, 'MCP tool input schema'),
    name: tool.name,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: cloneJsonObject(tool.outputSchema, 'MCP tool output schema') }),
  };
}

function convertResult(result: CallToolResult): McpRemoteToolResult {
  const structuredContent =
    result.structuredContent === undefined
      ? undefined
      : cloneJsonValue(result.structuredContent, 'MCP structured content');
  return {
    content: result.content.map(convertContent),
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function convertContent(content: ContentBlock): McpContentBlock {
  switch (content.type) {
    case 'audio':
    case 'image':
      return { data: content.data, mimeType: content.mimeType, type: content.type };
    case 'resource':
      return {
        resource:
          'text' in content.resource
            ? {
                ...(content.resource.mimeType === undefined
                  ? {}
                  : { mimeType: content.resource.mimeType }),
                text: content.resource.text,
                uri: content.resource.uri,
              }
            : {
                blob: content.resource.blob,
                ...(content.resource.mimeType === undefined
                  ? {}
                  : { mimeType: content.resource.mimeType }),
                uri: content.resource.uri,
              },
        type: 'resource',
      };
    case 'resource_link':
      return {
        ...(content.mimeType === undefined ? {} : { mimeType: content.mimeType }),
        name: content.name,
        ...(content.title === undefined ? {} : { title: content.title }),
        type: 'resource_link',
        uri: content.uri,
      };
    case 'text':
      return { text: content.text, type: 'text' };
  }
}

function cloneJsonObject(value: unknown, label: string): JsonObject {
  const converted = cloneJsonValue(value, label);
  if (converted === null || typeof converted !== 'object' || isJsonArray(converted)) {
    throw malformedJson(label);
  }
  return converted;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function cloneJsonValue(value: unknown, label: string): JsonValue {
  if (!isJsonValue(value)) {
    throw malformedJson(label);
  }
  return structuredClone(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function malformedJson(label: string): AiError {
  return new AiError('malformed_response', `${label} is not valid JSON.`, {
    code: 'invalid_mcp_json',
    details: { label },
  });
}

async function raceAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  if (combined.aborted) {
    throw abortError(combined.reason);
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      reject(abortError(combined.reason));
    };
    combined.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        combined.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        combined.removeEventListener('abort', abort);
        reject(
          error instanceof Error ? error : new Error('MCP connection failed.', { cause: error }),
        );
      },
    );
  });
}

function abortError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error('MCP operation was aborted.', { cause: reason });
}

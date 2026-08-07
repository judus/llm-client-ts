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
  #client: Client | undefined;
  #connectController: AbortController | undefined;
  #connectPromise: Promise<void> | undefined;
  readonly #connectionFactory: () => { readonly client: Client; readonly transport: Transport };

  public constructor(
    connectionFactory: () => { readonly client: Client; readonly transport: Transport },
  ) {
    this.#connectionFactory = connectionFactory;
  }

  public async connect(options: McpOperationOptions): Promise<void> {
    if (this.#connectPromise !== undefined) {
      return this.#connectPromise;
    }
    if (this.#client !== undefined) {
      return;
    }
    const controller = new AbortController();
    this.#connectController = controller;
    const connecting = this.#open({
      ...options,
      signal:
        options.signal === undefined
          ? controller.signal
          : AbortSignal.any([options.signal, controller.signal]),
    });
    this.#connectPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.#connectPromise === connecting) {
        this.#connectController = undefined;
        this.#connectPromise = undefined;
      }
    }
  }

  async #open(options: McpOperationOptions): Promise<void> {
    const connection = this.#connectionFactory();
    this.#client = connection.client;
    try {
      await raceAbort(
        connection.client.connect(connection.transport),
        options.signal,
        options.timeoutMs,
      );
    } catch (error) {
      if (this.#client === connection.client) {
        this.#client = undefined;
      }
      await connection.client.close().catch(() => undefined);
      throw error;
    }
  }

  public async listTools(options: McpOperationOptions): Promise<readonly McpRemoteTool[]> {
    const result = await this.#connectedClient().listTools(undefined, requestOptions(options));
    return result.tools.map(convertTool);
  }

  public async callTool(
    name: string,
    arguments_: JsonObject,
    options: McpOperationOptions,
  ): Promise<McpRemoteToolResult> {
    const result = await this.#connectedClient().callTool(
      { arguments: arguments_, name },
      requestOptions(options),
    );
    return convertResult(result);
  }

  public async close(): Promise<void> {
    this.#connectController?.abort(new DOMException('MCP session closed.', 'AbortError'));
    await this.#connectPromise?.catch(() => undefined);
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
  }

  #connectedClient(): Client {
    if (this.#client === undefined) {
      throw new AiError('invalid_request', 'MCP session is not connected.', {
        code: 'mcp_session_not_connected',
      });
    }
    return this.#client;
  }
}

export function createStdioMcpSession(options: StdioMcpSessionOptions): McpSession {
  return new SdkMcpSession(() => ({
    client: createClient(options.client, options.protocolNegotiation),
    transport: new StdioClientTransport({
      ...(options.args === undefined ? {} : { args: [...options.args] }),
      command: options.command,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
      ...(options.maxBufferSize === undefined ? {} : { maxBufferSize: options.maxBufferSize }),
      stderr: options.stderr ?? 'inherit',
    }),
  }));
}

export function createStreamableHttpMcpSession(
  options: StreamableHttpMcpSessionOptions,
): McpSession {
  return new SdkMcpSession(() => ({
    client: createClient(options.client, options.protocolNegotiation),
    transport: new StreamableHTTPClientTransport(new URL(options.url), {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.headers === undefined ? {} : { requestInit: { headers: options.headers } }),
    }),
  }));
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

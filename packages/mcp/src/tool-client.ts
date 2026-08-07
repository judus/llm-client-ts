import {
  AiError,
  type JsonObject,
  type LocalTool,
  type ToolExecutionOutput,
  type ToolResultContentPart,
} from '@maduser/ai-ts';

import type {
  McpClientState,
  McpContentBlock,
  McpRemoteTool,
  McpRemoteToolResult,
  McpToolClientOptions,
  McpToolDiscovery,
} from './types.js';

/** Discovers one MCP server and exposes its tools as core LocalTool executors. */
export class McpToolClient {
  readonly #annotations: McpToolClientOptions['annotations'];
  readonly #clock: () => Date;
  readonly #namespace: string;
  readonly #requestTimeoutMs: number;
  readonly #semaphore: Semaphore;
  readonly #serverId: string;
  readonly #session: McpToolClientOptions['session'];
  #connectPromise: Promise<void> | undefined;
  #discovery: McpToolDiscovery | undefined;
  #state: McpClientState = 'disconnected';

  public constructor(options: McpToolClientOptions) {
    validateIdentifier('server ID', options.serverId);
    validateIdentifier('namespace', options.namespace);
    this.#annotations = structuredClone(options.annotations ?? {});
    this.#clock = options.clock ?? (() => new Date());
    const maxConcurrency = positiveInteger(options.maxConcurrency ?? 4, 'maxConcurrency');
    this.#namespace = options.namespace;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 30_000,
      'requestTimeoutMs',
    );
    this.#semaphore = new Semaphore(maxConcurrency);
    this.#serverId = options.serverId;
    this.#session = options.session;
  }

  public get serverId(): string {
    return this.#serverId;
  }

  public get state(): McpClientState {
    return this.#state;
  }

  public async connect(signal?: AbortSignal): Promise<void> {
    if (this.#state === 'closed') {
      throw new AiError('invalid_request', `MCP client ${this.#serverId} is closed.`, {
        code: 'mcp_client_closed',
        details: { serverId: this.#serverId },
      });
    }
    if (this.#state === 'connected') {
      return;
    }
    if (this.#connectPromise !== undefined) {
      return this.#connectPromise;
    }
    this.#state = 'connecting';
    const connecting = this.#session
      .connect({ ...(signal === undefined ? {} : { signal }), timeoutMs: this.#requestTimeoutMs })
      .then(() => {
        if (this.#state !== 'closed') {
          this.#state = 'connected';
        }
      })
      .catch((error: unknown) => {
        if (this.#state !== 'closed') {
          this.#state = 'disconnected';
        }
        throw normalizeMcpError(error, 'connect', this.#serverId, signal, true);
      })
      .finally(() => {
        this.#connectPromise = undefined;
      });
    this.#connectPromise = connecting;
    return connecting;
  }

  public async discover(
    options: { readonly force?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<McpToolDiscovery> {
    if (options.force !== true && this.#discovery !== undefined) {
      return cloneDiscovery(this.#discovery);
    }
    await this.connect(options.signal);
    let remoteTools: readonly McpRemoteTool[];
    try {
      remoteTools = await this.#session.listTools({
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: this.#requestTimeoutMs,
      });
    } catch (error) {
      if (!(error instanceof AiError) && options.signal?.aborted !== true) {
        await this.#disconnectAfterFailure();
      }
      throw normalizeMcpError(error, 'discover', this.#serverId, options.signal, true);
    }
    const names = new Set<string>();
    const tools = remoteTools.map((tool): LocalTool => {
      if (names.has(tool.name)) {
        throw new AiError(
          'malformed_response',
          `MCP server returned duplicate tool ${tool.name}.`,
          {
            code: 'duplicate_mcp_tool',
            details: { serverId: this.#serverId, toolName: tool.name },
          },
        );
      }
      names.add(tool.name);
      const qualifiedName = qualifyMcpToolName(this.#namespace, tool.name);
      const definition = {
        ...(this.#annotations?.[tool.name] === undefined
          ? {}
          : { annotations: structuredClone(this.#annotations[tool.name]) }),
        description: tool.description ?? `MCP tool ${tool.name} from ${this.#serverId}.`,
        inputSchema: structuredClone(tool.inputSchema),
        name: qualifiedName,
        ...(tool.outputSchema === undefined
          ? {}
          : { outputSchema: structuredClone(tool.outputSchema) }),
      };
      return {
        definition,
        execute: async (arguments_, context) =>
          this.#executeRemote(tool, arguments_, context.signal, context.deadline),
      };
    });
    this.#discovery = {
      discoveredAt: this.#clock().toISOString(),
      serverId: this.#serverId,
      tools,
    };
    return cloneDiscovery(this.#discovery);
  }

  public invalidate(): void {
    this.#discovery = undefined;
  }

  public async close(): Promise<void> {
    if (this.#state === 'closed') {
      return;
    }
    this.#state = 'closed';
    this.#discovery = undefined;
    let closeError: unknown;
    try {
      await this.#session.close();
    } catch (error) {
      closeError = error;
    }
    await this.#connectPromise?.catch(() => undefined);
    if (closeError !== undefined) {
      throw normalizeMcpError(closeError, 'close', this.#serverId, undefined, false);
    }
  }

  async #executeRemote(
    tool: McpRemoteTool,
    arguments_: JsonObject,
    signal: AbortSignal,
    deadline: string,
  ): Promise<ToolExecutionOutput> {
    await this.connect(signal);
    const release = await this.#semaphore.acquire(signal, this.#serverId);
    try {
      const remainingMs = Date.parse(deadline) - Date.now();
      if (remainingMs <= 0) {
        throw new AiError('timeout', `MCP tool ${tool.name} missed its deadline.`, {
          code: 'mcp_tool_deadline_exceeded',
          details: { serverId: this.#serverId, toolName: tool.name },
        });
      }
      let result: McpRemoteToolResult;
      try {
        result = await this.#session.callTool(tool.name, arguments_, {
          signal,
          timeoutMs: Math.min(remainingMs, this.#requestTimeoutMs),
        });
      } catch (error) {
        if (!(error instanceof AiError) && !signal.aborted) {
          await this.#disconnectAfterFailure();
        }
        throw normalizeMcpError(error, 'call_tool', this.#serverId, signal, false, tool.name);
      }
      if (result.isError === true) {
        throw new AiError('tool_execution', `MCP tool ${tool.name} reported an error.`, {
          code: 'mcp_tool_reported_error',
          details: { serverId: this.#serverId, toolName: tool.name },
        });
      }
      return {
        content: result.content.map(convertContent),
        ...(result.structuredContent === undefined
          ? {}
          : { structuredContent: structuredClone(result.structuredContent) }),
      };
    } finally {
      release();
    }
  }

  async #disconnectAfterFailure(): Promise<void> {
    if (this.#state === 'closed') {
      return;
    }
    this.#state = 'disconnected';
    await this.#session.close().catch(() => undefined);
  }
}

export function qualifyMcpToolName(namespace: string, toolName: string): string {
  validateIdentifier('namespace', namespace);
  validateIdentifier('MCP tool name', toolName);
  const qualified = `${namespace}__${toolName}`;
  if (qualified.length > 64) {
    throw new AiError('invalid_request', 'Qualified MCP tool name exceeds 64 characters.', {
      code: 'mcp_tool_name_too_long',
      details: { namespace, toolName },
    });
  }
  return qualified;
}

function convertContent(content: McpContentBlock): ToolResultContentPart {
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
      if ('text' in content.resource) {
        return { source: 'generated', text: content.resource.text, type: 'text' };
      }
      return {
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

function decodeBase64(value: string): Uint8Array {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
      throw new TypeError('Invalid base64.');
    }
    return new Uint8Array(Buffer.from(value, 'base64'));
  } catch (cause) {
    throw new AiError('malformed_response', 'MCP returned invalid base64 content.', {
      cause,
      code: 'invalid_mcp_base64',
    });
  }
}

function normalizeMcpError(
  error: unknown,
  operation: string,
  serverId: string,
  signal: AbortSignal | undefined,
  retryable: boolean,
  toolName?: string,
): AiError {
  if (error instanceof AiError) {
    return error;
  }
  if (signal?.aborted === true) {
    return new AiError('cancelled', `MCP ${operation} was cancelled.`, {
      cause: error,
      code: 'mcp_operation_cancelled',
      details: { operation, serverId, ...(toolName === undefined ? {} : { toolName }) },
    });
  }
  return new AiError('transport', `MCP ${operation} failed for ${serverId}.`, {
    cause: error,
    code: 'mcp_operation_failed',
    details: { operation, serverId, ...(toolName === undefined ? {} : { toolName }) },
    retryable,
  });
}

function validateIdentifier(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new AiError('invalid_request', `Invalid ${label}: ${value}.`, {
      code: 'invalid_mcp_identifier',
      details: { label, value },
    });
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AiError('invalid_request', `${name} must be a positive integer.`, {
      code: 'invalid_mcp_limit',
      details: { name, value },
    });
  }
  return value;
}

function cloneDiscovery(discovery: McpToolDiscovery): McpToolDiscovery {
  return {
    discoveredAt: discovery.discoveredAt,
    serverId: discovery.serverId,
    tools: discovery.tools.map((tool) => ({
      definition: structuredClone(tool.definition),
      execute: tool.execute,
    })),
  };
}

class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: (() => void)[] = [];

  public constructor(limit: number) {
    this.#limit = limit;
  }

  public async acquire(signal: AbortSignal, serverId: string): Promise<() => void> {
    if (signal.aborted) {
      throw cancelledSemaphore(serverId, signal.reason);
    }
    if (this.#active >= this.#limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = (): void => {
          signal.removeEventListener('abort', abort);
          resolve();
        };
        const abort = (): void => {
          const index = this.#waiters.indexOf(ready);
          if (index >= 0) {
            this.#waiters.splice(index, 1);
          }
          reject(cancelledSemaphore(serverId, signal.reason));
        };
        this.#waiters.push(ready);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#active -= 1;
      this.#waiters.shift()?.();
    };
  }
}

function cancelledSemaphore(serverId: string, cause: unknown): AiError {
  return new AiError('cancelled', 'MCP concurrency wait was cancelled.', {
    cause,
    code: 'mcp_concurrency_cancelled',
    details: { serverId },
  });
}

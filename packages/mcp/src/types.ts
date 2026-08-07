import type { JsonObject, JsonSchema, JsonValue, LocalTool, ToolAnnotations } from '@maduser/ai-ts';
import type { McpToolClient } from './tool-client.js';

export type McpClientState = 'closed' | 'connected' | 'connecting' | 'disconnected';

export interface McpOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface McpRemoteTool {
  readonly description?: string;
  readonly inputSchema: JsonSchema;
  readonly name: string;
  readonly outputSchema?: JsonSchema;
}

export type McpContentBlock =
  | { readonly data: string; readonly mimeType: string; readonly type: 'audio' | 'image' }
  | {
      readonly resource:
        | { readonly blob: string; readonly mimeType?: string; readonly uri: string }
        | { readonly mimeType?: string; readonly text: string; readonly uri: string };
      readonly type: 'resource';
    }
  | {
      readonly mimeType?: string;
      readonly name: string;
      readonly title?: string;
      readonly type: 'resource_link';
      readonly uri: string;
    }
  | { readonly text: string; readonly type: 'text' };

export interface McpRemoteToolResult {
  readonly content: readonly McpContentBlock[];
  readonly isError?: boolean;
  readonly structuredContent?: JsonValue;
}

/** Narrow protocol seam used by the broker and deterministic tests. */
export interface McpSession {
  callTool(
    name: string,
    arguments_: JsonObject,
    options: McpOperationOptions,
  ): Promise<McpRemoteToolResult>;
  close(): Promise<void>;
  connect(options: McpOperationOptions): Promise<void>;
  listTools(options: McpOperationOptions): Promise<readonly McpRemoteTool[]>;
}

export interface McpToolClientOptions {
  /** Locally trusted annotations keyed by the unqualified remote tool name. */
  readonly annotations?: Readonly<Record<string, ToolAnnotations>>;
  /** Clock used for discovery timestamps. */
  readonly clock?: () => Date;
  readonly maxConcurrency?: number;
  readonly namespace: string;
  readonly requestTimeoutMs?: number;
  readonly serverId: string;
  readonly session: McpSession;
}

export interface McpToolDiscovery {
  readonly discoveredAt: string;
  readonly serverId: string;
  readonly tools: readonly LocalTool[];
}

export interface McpClientIdentity {
  readonly name: string;
  readonly version: string;
}

export interface StdioMcpSessionOptions {
  readonly args?: readonly string[];
  readonly client: McpClientIdentity;
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxBufferSize?: number;
  readonly protocolNegotiation?: 'auto' | 'legacy';
  readonly stderr?: 'inherit' | 'pipe';
}

export interface StreamableHttpMcpSessionOptions {
  readonly client: McpClientIdentity;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: Readonly<Record<string, string>>;
  readonly protocolNegotiation?: 'auto' | 'legacy';
  readonly url: string | URL;
}

export interface McpToolBrokerOptions {
  readonly clients: readonly McpToolClient[];
}

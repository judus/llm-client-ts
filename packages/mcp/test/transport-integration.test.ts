import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AiClient,
  BoundedAgentRuntime,
  type ConversationMessage,
  type ModelResponse,
} from '@maduser/ai-ts';
import { ScriptedProvider } from '@maduser/ai-ts-testing';
import {
  McpToolBroker,
  McpToolClient,
  createStdioMcpSession,
  createStreamableHttpMcpSession,
} from '../src/index.js';

const openClients = new Set<McpToolClient>();

afterEach(async () => {
  await Promise.allSettled([...openClients].map((client) => client.close()));
  openClients.clear();
});

describe('MCP transport integration', () => {
  it('executes a real stdio server and reaps the child on shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ai-ts-mcp-stdio-'));
    const pidFile = join(directory, 'pid');
    const fixture = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));
    const client = track(
      new McpToolClient({
        annotations: { echo: { readOnly: true } },
        namespace: 'stdio',
        requestTimeoutMs: 2_000,
        serverId: 'stdio-fixture',
        session: createStdioMcpSession({
          args: [fixture],
          client: { name: 'integration-test', version: '1.0.0' },
          command: process.execPath,
          env: { MCP_FIXTURE_PID_FILE: pidFile },
          protocolNegotiation: 'legacy',
          stderr: 'pipe',
        }),
      }),
    );

    try {
      const tool = (await client.discover()).tools[0];
      if (tool === undefined) {
        throw new Error('Expected stdio fixture tool.');
      }
      const childPid = Number(await readFile(pidFile, 'utf8'));
      expect(() => process.kill(childPid, 0)).not.toThrow();
      await expect(tool.execute({ value: 'flight-ready' }, context())).resolves.toMatchObject({
        structuredContent: { echo: 'flight-ready' },
      });

      const provider = new ScriptedProvider(
        [
          {
            response: modelResponse(
              'tool-request',
              [
                {
                  arguments: { value: 'agent-path' },
                  callId: 'mcp-call',
                  name: 'stdio__echo',
                  type: 'tool_call',
                },
              ],
              'tool_calls',
            ),
            type: 'generate',
          },
          {
            response: modelResponse(
              'final',
              [{ source: 'generated', text: 'MCP completed.', type: 'text' }],
              'stop',
            ),
            type: 'generate',
          },
        ],
        {
          capabilities: {
            input: { audio: false, documents: false, images: false, text: true },
            output: { audio: false, structured: true, text: true },
            realtime: false,
            speechSynthesis: false,
            streaming: false,
            tools: { calls: true, parallelCalls: true, strictSchemas: true },
            transcription: false,
          },
        },
      );
      const runtime = new BoundedAgentRuntime({
        client: new AiClient(provider),
        tools: await new McpToolBroker({ clients: [client] }).registry(),
      });
      await expect(
        runtime.run({
          agent: {
            id: 'mcp-integration',
            model: { model: 'fixture', provider: 'scripted' },
            tools: ['stdio__echo'],
          },
          conversationId: 'mcp-integration',
          input: [{ source: 'typed', text: 'Use the echo tool.', type: 'text' }],
        }),
      ).resolves.toMatchObject({ modelSteps: 2, status: 'completed', toolCalls: 1 });
      expect(provider.requests[1]?.messages.at(-1)?.content).toEqual([
        expect.objectContaining({ callId: 'mcp-call', status: 'success', type: 'tool_result' }),
      ]);

      await client.close();
      openClients.delete(client);
      await expect.poll(() => processExists(childPid)).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('recreates Streamable HTTP connections without replaying a failed tool call', async () => {
    const sockets = new Set<Socket>();
    const received: {
      readonly authorization: string | undefined;
      readonly method: string;
      readonly sessionId: string | undefined;
    }[] = [];
    let initializeAttempts = 0;
    let toolAttempts = 0;
    const server = createServer((request, response) => {
      void handleHttpFixture(request, response, received, {
        initialize: () => {
          initializeAttempts += 1;
          return initializeAttempts === 1;
        },
        tool: () => {
          toolAttempts += 1;
          return toolAttempts === 1;
        },
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected TCP fixture address.');
    }
    const client = track(
      new McpToolClient({
        namespace: 'http',
        requestTimeoutMs: 2_000,
        serverId: 'http-fixture',
        session: createStreamableHttpMcpSession({
          client: { name: 'integration-test', version: '1.0.0' },
          headers: { authorization: 'Bearer local-fixture' },
          protocolNegotiation: 'legacy',
          url: `http://127.0.0.1:${String(address.port)}/mcp`,
        }),
      }),
    );

    try {
      await expect(client.connect()).rejects.toMatchObject({ code: 'mcp_operation_failed' });
      expect(client.state).toBe('disconnected');
      await client.connect();
      const tool = (await client.discover()).tools[0];
      if (tool === undefined) {
        throw new Error('Expected HTTP fixture tool.');
      }

      await expect(tool.execute({ value: 42 }, context())).rejects.toMatchObject({
        code: 'mcp_operation_failed',
      });
      expect(toolAttempts).toBe(1);
      expect(client.state).toBe('disconnected');
      await expect(tool.execute({ value: 42 }, context())).resolves.toMatchObject({
        structuredContent: { echo: 42 },
      });
      expect(toolAttempts).toBe(2);
      expect(initializeAttempts).toBe(3);
      expect(received.every(({ authorization }) => authorization === 'Bearer local-fixture')).toBe(
        true,
      );
      expect(
        received.some(
          ({ method, sessionId }) => method === 'tools/list' && sessionId !== undefined,
        ),
      ).toBe(true);

      await client.close();
      openClients.delete(client);
      await expect.poll(() => sockets.size).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    }
  });
});

function track(client: McpToolClient): McpToolClient {
  openClients.add(client);
  return client;
}

function context(): {
  readonly callId: string;
  readonly deadline: string;
  readonly runId: string;
  readonly signal: AbortSignal;
} {
  return {
    callId: 'integration-call',
    deadline: new Date(Date.now() + 5_000).toISOString(),
    runId: 'integration-run',
    signal: new AbortController().signal,
  };
}

function modelResponse(
  id: string,
  content: ConversationMessage['content'],
  finishReason: 'stop' | 'tool_calls',
): ModelResponse {
  return {
    finishReason,
    id,
    message: {
      content,
      conversationId: 'mcp-integration',
      createdAt: '2026-08-07T12:00:00.000Z',
      id: `message-${id}`,
      role: 'assistant',
    },
    model: { model: 'fixture', provider: 'scripted' },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

interface HttpFixtureMessage {
  readonly id?: number | string;
  readonly method: string;
  readonly params?: { readonly arguments?: { readonly value?: unknown } };
}

async function handleHttpFixture(
  request: IncomingMessage,
  response: ServerResponse,
  received: {
    readonly authorization: string | undefined;
    readonly method: string;
    readonly sessionId: string | undefined;
  }[],
  reject: { readonly initialize: () => boolean; readonly tool: () => boolean },
): Promise<void> {
  response.setHeader('connection', 'close');
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  const parsed: unknown = JSON.parse(await readRequestBody(request));
  if (!isHttpFixtureMessage(parsed)) {
    response.writeHead(400).end('invalid fixture request');
    return;
  }
  const message = parsed;
  const sessionId = request.headers['mcp-session-id'];
  received.push({
    authorization: request.headers.authorization,
    method: message.method,
    sessionId: Array.isArray(sessionId) ? sessionId.join(',') : sessionId,
  });
  if (message.method === 'initialize' && reject.initialize()) {
    response.writeHead(503, { 'content-type': 'text/plain' }).end('temporarily unavailable');
    return;
  }
  if (message.method === 'tools/call' && reject.tool()) {
    response.writeHead(503, { 'content-type': 'text/plain' }).end('temporarily unavailable');
    return;
  }
  if (message.method === 'notifications/initialized') {
    response.writeHead(202).end();
    return;
  }
  const result = httpResult(message);
  response
    .writeHead(200, {
      'content-type': 'application/json',
      ...(message.method === 'initialize' ? { 'mcp-session-id': 'fixture-session' } : {}),
    })
    .end(JSON.stringify({ id: message.id, jsonrpc: '2.0', result }));
}

function httpResult(message: {
  readonly method: string;
  readonly params?: { readonly arguments?: { readonly value?: unknown } };
}): object {
  if (message.method === 'initialize') {
    return {
      capabilities: { tools: {} },
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'http-fixture', version: '1.0.0' },
    };
  }
  if (message.method === 'tools/list') {
    return {
      tools: [
        {
          description: 'Echo JSON through HTTP.',
          inputSchema: {
            additionalProperties: false,
            properties: { value: {} },
            required: ['value'],
            type: 'object',
          },
          name: 'echo',
        },
      ],
    };
  }
  return {
    content: [{ text: JSON.stringify(message.params?.arguments?.value), type: 'text' }],
    structuredContent: { echo: message.params?.arguments?.value },
  };
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      resolve(body);
    });
    request.on('error', reject);
  });
}

function isHttpFixtureMessage(value: unknown): value is HttpFixtureMessage {
  return (
    value !== null && typeof value === 'object' && typeof Reflect.get(value, 'method') === 'string'
  );
}

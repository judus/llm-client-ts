import { describe, expect, it, vi } from 'vitest';

import { openMcpServers, type McpServer } from '../src/mcp-client.js';

interface RpcRequest {
  readonly id?: number | string;
  readonly method: string;
}

interface McpFixtureOptions {
  readonly callResult?: object;
  readonly onRequest?: (method: string, init: RequestInit | undefined) => void;
  readonly tools?: readonly object[];
}

describe('MCP client integration', () => {
  it('derives a namespace, resolves headers, maps schemas, and converts every result content type', async () => {
    const authorizations: (string | null)[] = [];
    const headers = vi.fn(async () => {
      await Promise.resolve();
      return { authorization: 'Bearer fixture' };
    });
    const fetch = fixtureFetch({
      callResult: {
        content: [
          { text: 'plain', type: 'text' },
          { data: 'AQI=', mimeType: 'image/png', type: 'image' },
          { data: 'AwQ=', mimeType: 'audio/wav', type: 'audio' },
          {
            resource: { mimeType: 'text/plain', text: 'embedded', uri: 'memory://text' },
            type: 'resource',
          },
          { resource: { blob: 'BQY=', uri: 'memory://blob' }, type: 'resource' },
          {
            mimeType: 'text/csv',
            name: 'data.csv',
            title: 'Data',
            type: 'resource_link',
            uri: 'https://example.test/data.csv',
          },
          {
            name: 'plain-resource',
            type: 'resource_link',
            uri: 'https://example.test/plain',
          },
        ],
        structuredContent: { ok: true },
      },
      onRequest: (_method, init) => {
        authorizations.push(new Headers(init?.headers).get('authorization'));
      },
      tools: [
        {
          description: 'Fixture tool.',
          inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
          name: 'fixture.tool',
          outputSchema: { properties: { ok: { type: 'boolean' } }, type: 'object' },
        },
      ],
    });

    const opened = await openMcpServers([
      { fetch, headers, url: new URL('https://tools.example.test/mcp') },
    ]);
    const tool = opened.tools[0];
    if (tool === undefined) {
      throw new Error('Expected discovered tool.');
    }

    expect(tool.definition).toMatchObject({
      description: 'Fixture tool.',
      name: 'tools_example_test_443__fixture_tool',
      outputSchema: { type: 'object' },
    });
    await expect(tool.execute({}, context())).resolves.toMatchObject({
      content: [
        { text: 'plain', type: 'text' },
        { source: { bytes: new Uint8Array([1, 2]) }, type: 'image' },
        { source: { bytes: new Uint8Array([3, 4]) }, type: 'audio' },
        { text: 'embedded', type: 'text' },
        { mimeType: 'application/octet-stream', title: 'memory://blob', type: 'document' },
        { filename: 'data.csv', title: 'Data', type: 'document' },
        { filename: 'plain-resource', mimeType: 'application/octet-stream', type: 'document' },
      ],
      structuredContent: { ok: true },
    });
    expect(headers).toHaveBeenCalledOnce();
    expect(authorizations.every((value) => value === 'Bearer fixture')).toBe(true);
    await opened.close();

    const staticHeaders: (string | null)[] = [];
    const plain = await openMcpServers([
      {
        fetch: fixtureFetch({
          callResult: {
            content: [
              {
                resource: {
                  blob: 'Bwg=',
                  mimeType: 'application/octet-stream',
                  uri: 'memory://typed-blob',
                },
                type: 'resource',
              },
            ],
          },
          onRequest: (_method, init) => {
            staticHeaders.push(new Headers(init?.headers).get('x-fixture'));
          },
        }),
        headers: { 'x-fixture': 'yes' },
        name: 'plain',
        url: 'https://plain.test/mcp',
      },
    ]);
    const plainTool = plain.tools[0];
    if (plainTool === undefined) {
      throw new Error('Expected plain tool.');
    }
    await expect(plainTool.execute({}, context())).resolves.toEqual({
      content: [
        {
          mimeType: 'application/octet-stream',
          source: { bytes: new Uint8Array([7, 8]), type: 'bytes' },
          title: 'memory://typed-blob',
          type: 'document',
        },
      ],
    });
    expect(staticHeaders.every((value) => value === 'yes')).toBe(true);
    await plain.close();
  });

  it.each([
    { code: 'invalid_mcp_url', server: { url: 'not a url' } },
    { code: 'invalid_mcp_protocol', server: { url: 'file:///tmp/mcp' } },
    { code: 'invalid_mcp_server_name', server: { name: 'bad name', url: 'https://x.test' } },
    { code: 'invalid_mcp_limit', server: { timeoutMs: 0, url: 'https://x.test' } },
  ])('rejects invalid server configuration with $code', async ({ code, server }) => {
    await expect(openMcpServers([server as McpServer])).rejects.toMatchObject({ code });
  });

  it('rejects duplicate server names before connecting', async () => {
    await expect(
      openMcpServers([
        { name: 'same', url: 'https://one.test' },
        { name: 'same', url: 'https://two.test' },
      ]),
    ).rejects.toMatchObject({ code: 'duplicate_mcp_server_name' });
  });

  it('derives names for HTTP and explicit-port URLs', async () => {
    const fetch = fixtureFetch();
    const opened = await openMcpServers([
      { fetch, url: 'http://local.test/mcp' },
      { fetch, url: 'https://remote.test:8443/mcp' },
    ]);
    expect(opened.tools.map(({ definition }) => definition.name)).toEqual([
      'local_test_80__run',
      'remote_test_8443__run',
    ]);
    await opened.close();
  });

  it('rejects duplicate, malformed, empty, and overlong discovered tool names', async () => {
    await expect(
      openMcpServers([
        {
          fetch: fixtureFetch({
            tools: [
              { inputSchema: { type: 'object' }, name: 'duplicate' },
              { inputSchema: { type: 'object' }, name: 'duplicate' },
            ],
          }),
          name: 'fixture',
          url: 'https://fixture.test',
        },
      ]),
    ).rejects.toMatchObject({ code: 'duplicate_mcp_tool' });
    await expect(
      openMcpServers([
        {
          fetch: fixtureFetch({ tools: [{ inputSchema: [], name: 'broken' }] }),
          name: 'fixture',
          url: 'https://fixture.test',
        },
      ]),
    ).rejects.toMatchObject({ code: 'mcp_operation_failed' });
    await expect(
      openMcpServers([
        {
          fetch: fixtureFetch({
            tools: [{ inputSchema: { type: 'object' }, name: 'x'.repeat(64) }],
          }),
          name: 'fixture',
          url: 'https://fixture.test',
        },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_mcp_tool_name' });
  });

  it('normalizes connection failure and cancellation', async () => {
    const rejectingFetch: typeof globalThis.fetch = async () => {
      await Promise.resolve();
      throw new Error('offline');
    };
    await expect(
      openMcpServers([{ fetch: rejectingFetch, name: 'offline', url: 'https://offline.test' }]),
    ).rejects.toMatchObject({ code: 'mcp_operation_failed', retryable: true });

    const controller = new AbortController();
    controller.abort('stop');
    await expect(
      openMcpServers(
        [{ fetch: rejectingFetch, name: 'cancelled', url: 'https://cancelled.test' }],
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'mcp_operation_cancelled' });
  });

  it('does not replay remote tool errors and enforces the execution deadline', async () => {
    const fetch = fixtureFetch({
      callResult: { content: [{ text: 'failed', type: 'text' }], isError: true },
    });
    const opened = await openMcpServers([{ fetch, name: 'fixture', url: 'https://fixture.test' }]);
    const tool = opened.tools[0];
    if (tool === undefined) {
      throw new Error('Expected discovered tool.');
    }
    await expect(tool.execute({}, context())).rejects.toMatchObject({
      code: 'mcp_tool_reported_error',
    });
    await expect(
      tool.execute({}, { ...context(), deadline: new Date(Date.now() - 1).toISOString() }),
    ).rejects.toMatchObject({ code: 'mcp_tool_deadline_exceeded' });
    await opened.close();
  });

  it('rejects invalid MCP base64 returned by a tool', async () => {
    const opened = await openMcpServers([
      {
        fetch: fixtureFetch({
          callResult: { content: [{ data: 'not-base64!', mimeType: 'image/png', type: 'image' }] },
        }),
        name: 'fixture',
        url: 'https://fixture.test',
      },
    ]);
    const tool = opened.tools[0];
    if (tool === undefined) {
      throw new Error('Expected discovered tool.');
    }
    await expect(tool.execute({}, context())).rejects.toMatchObject({
      code: 'mcp_operation_failed',
    });
    await opened.close();
  });
});

function fixtureFetch(options: McpFixtureOptions = {}): typeof globalThis.fetch {
  return async (_input, init) => {
    await Promise.resolve();
    if (init?.method === 'DELETE') {
      return new Response(null, { status: 200 });
    }
    if (typeof init?.body !== 'string') {
      return new Response('invalid', { status: 400 });
    }
    const value: unknown = JSON.parse(init.body);
    if (!isRpcRequest(value)) {
      return new Response('invalid', { status: 400 });
    }
    options.onRequest?.(value.method, init);
    if (value.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    const result =
      value.method === 'initialize'
        ? {
            capabilities: { tools: {} },
            protocolVersion: '2025-11-25',
            serverInfo: { name: 'fixture', version: '1' },
          }
        : value.method === 'tools/list'
          ? {
              tools: options.tools ?? [
                {
                  inputSchema: { additionalProperties: false, properties: {}, type: 'object' },
                  name: 'run',
                },
              ],
            }
          : (options.callResult ?? { content: [{ text: 'ok', type: 'text' }] });
    return Response.json(
      { id: value.id, jsonrpc: '2.0', result },
      {
        headers: value.method === 'initialize' ? { 'mcp-session-id': 'fixture-session' } : {},
      },
    );
  };
}

function isRpcRequest(value: unknown): value is RpcRequest {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'method') === 'string'
  );
}

function context(): {
  readonly callId: string;
  readonly deadline: string;
  readonly runId: string;
  readonly signal: AbortSignal;
} {
  return {
    callId: 'call-1',
    deadline: new Date(Date.now() + 5_000).toISOString(),
    runId: 'run-1',
    signal: new AbortController().signal,
  };
}

import { describe, expect, it } from 'vitest';

import {
  Client,
  type JSONRPCMessage,
  type JSONRPCRequest,
  type Transport,
} from '@modelcontextprotocol/client';
import { createStdioMcpSession, createStreamableHttpMcpSession } from '../src/index.js';
import { SdkMcpSession } from '../src/sdk-session.js';

class FixtureTransport implements Transport {
  public closed = false;
  public onclose: (() => void) | undefined;
  public onerror: ((error: Error) => void) | undefined;
  public onmessage: ((message: JSONRPCMessage) => void) | undefined;

  public start(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    this.closed = true;
    this.onclose?.();
    return Promise.resolve();
  }

  public send(message: JSONRPCMessage | JSONRPCMessage[]): Promise<void> {
    if (Array.isArray(message) || !('id' in message) || !('method' in message)) {
      return Promise.resolve();
    }
    this.respond(message);
    return Promise.resolve();
  }

  private respond(request: JSONRPCRequest): void {
    if (request.method === 'initialize') {
      this.onmessage?.({
        id: request.id,
        jsonrpc: '2.0',
        result: {
          capabilities: { tools: {} },
          protocolVersion: '2025-11-25',
          serverInfo: { name: 'fixture', version: '1' },
        },
      });
    } else if (request.method === 'tools/list') {
      this.onmessage?.({
        id: request.id,
        jsonrpc: '2.0',
        result: {
          tools: [
            {
              description: 'Fixture tool.',
              inputSchema: { properties: {}, type: 'object' },
              name: 'fixture_tool',
              outputSchema: { properties: {}, type: 'object' },
            },
            {
              inputSchema: { type: 'object' },
              name: 'minimal_tool',
            },
          ],
        },
      });
    } else if (request.method === 'tools/call') {
      this.onmessage?.({
        id: request.id,
        jsonrpc: '2.0',
        result: {
          content: [
            { text: 'done', type: 'text' },
            { data: 'AQI=', mimeType: 'image/png', type: 'image' },
            { data: 'AwQ=', mimeType: 'audio/wav', type: 'audio' },
            {
              resource: { mimeType: 'text/plain', text: 'embedded', uri: 'memory://resource' },
              type: 'resource',
            },
            {
              resource: { blob: 'BQY=', uri: 'memory://blob' },
              type: 'resource',
            },
            {
              resource: { text: 'plain', uri: 'memory://plain' },
              type: 'resource',
            },
            {
              resource: {
                blob: 'Bwg=',
                mimeType: 'application/octet-stream',
                uri: 'memory://typed-blob',
              },
              type: 'resource',
            },
            {
              mimeType: 'text/csv',
              name: 'file.csv',
              type: 'resource_link',
              uri: 'https://example.test/file.csv',
            },
            {
              name: 'named-resource',
              title: 'Named resource',
              type: 'resource_link',
              uri: 'https://example.test/resource',
            },
          ],
          isError: false,
          structuredContent: { ok: true },
        },
      });
    }
  }
}

describe('SdkMcpSession', () => {
  it('negotiates, discovers, calls, converts, and closes through the official client', async () => {
    const transport = new FixtureTransport();
    const sdk = new Client(
      { name: 'test-client', version: '1' },
      { versionNegotiation: { mode: 'legacy' } },
    );
    const session = new SdkMcpSession(() => ({ client: sdk, transport }));
    const options = { timeoutMs: 1_000 };
    await session.connect(options);
    await expect(session.listTools(options)).resolves.toEqual([
      {
        description: 'Fixture tool.',
        inputSchema: { properties: {}, type: 'object' },
        name: 'fixture_tool',
        outputSchema: { properties: {}, type: 'object' },
      },
      { inputSchema: { type: 'object' }, name: 'minimal_tool' },
    ]);
    const result = await session.callTool('fixture_tool', {}, options);
    expect(result.structuredContent).toEqual({ ok: true });
    expect(result.content.map(({ type }) => type)).toEqual([
      'text',
      'image',
      'audio',
      'resource',
      'resource',
      'resource',
      'resource',
      'resource_link',
      'resource_link',
    ]);
    await session.close();
    expect(transport.closed).toBe(true);
  });

  it('constructs both official transport types without opening them', () => {
    expect(
      createStdioMcpSession({
        args: ['server.js'],
        client: { name: 'test', version: '1' },
        command: 'node',
        cwd: '/tmp',
        env: { FIXTURE: 'yes' },
        maxBufferSize: 1_024,
        protocolNegotiation: 'legacy',
        stderr: 'pipe',
      }),
    ).toBeInstanceOf(SdkMcpSession);
    expect(
      createStreamableHttpMcpSession({
        client: { name: 'test', version: '1' },
        fetch: () => Promise.resolve(new Response(null, { status: 204 })),
        headers: { authorization: 'Bearer fixture' },
        protocolNegotiation: 'legacy',
        url: 'https://example.test/mcp',
      }),
    ).toBeInstanceOf(SdkMcpSession);
    expect(
      createStdioMcpSession({ client: { name: 'minimal', version: '1' }, command: 'node' }),
    ).toBeInstanceOf(SdkMcpSession);
    expect(
      createStreamableHttpMcpSession({
        client: { name: 'minimal', version: '1' },
        url: new URL('https://example.test/mcp'),
      }),
    ).toBeInstanceOf(SdkMcpSession);
  });

  it('rejects malformed JSON returned through a custom client seam', async () => {
    const sdk = new Client({ name: 'test', version: '1' });
    Reflect.set(sdk, 'listTools', () =>
      Promise.resolve({ tools: [{ inputSchema: [], name: 'broken' }] }),
    );
    const session = new SdkMcpSession(() => ({ client: sdk, transport: new FixtureTransport() }));
    await session.connect({ timeoutMs: 100 });
    await expect(session.listTools({ timeoutMs: 100 })).rejects.toMatchObject({
      code: 'invalid_mcp_json',
    });

    Reflect.set(sdk, 'callTool', () =>
      Promise.resolve({ content: [], structuredContent: { value: Number.NaN } }),
    );
    await expect(session.callTool('broken', {}, { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'invalid_mcp_json',
    });
  });

  it('aborts a connection and closes its transport', async () => {
    const transport = new FixtureTransport();
    transport.start = () => new Promise(() => undefined);
    const session = new SdkMcpSession(() => ({
      client: new Client(
        { name: 'test-client', version: '1' },
        { versionNegotiation: { mode: 'legacy' } },
      ),
      transport,
    }));
    const controller = new AbortController();
    controller.abort('stop');
    await expect(
      session.connect({ signal: controller.signal, timeoutMs: 1_000 }),
    ).rejects.toThrow();
    expect(transport.closed).toBe(true);
  });

  it('deduplicates connections and rejects operations before connection', async () => {
    let creations = 0;
    const session = new SdkMcpSession(() => {
      creations += 1;
      return {
        client: new Client(
          { name: 'test-client', version: '1' },
          { versionNegotiation: { mode: 'legacy' } },
        ),
        transport: new FixtureTransport(),
      };
    });
    await expect(session.listTools({ timeoutMs: 100 })).rejects.toMatchObject({
      code: 'mcp_session_not_connected',
    });
    await Promise.all([session.connect({ timeoutMs: 100 }), session.connect({ timeoutMs: 100 })]);
    await session.connect({ timeoutMs: 100 });
    expect(creations).toBe(1);
    await session.close();
  });

  it('aborts an in-progress connection when closed', async () => {
    const transport = new FixtureTransport();
    transport.start = () => new Promise(() => undefined);
    const session = new SdkMcpSession(() => ({
      client: new Client(
        { name: 'test-client', version: '1' },
        { versionNegotiation: { mode: 'legacy' } },
      ),
      transport,
    }));
    const connecting = session.connect({ timeoutMs: 10_000 });
    const rejected = expect(connecting).rejects.toThrow('MCP session closed.');
    await session.close();
    await rejected;
    expect(transport.closed).toBe(true);
  });
});

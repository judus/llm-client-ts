import { describe, expect, it } from 'vitest';

import { AiError, ToolRegistry } from '@maduser/ai-ts';
import {
  McpToolBroker,
  McpToolClient,
  qualifyMcpToolName,
  type McpRemoteTool,
  type McpRemoteToolResult,
  type McpSession,
} from '../src/index.js';

const remoteTool: McpRemoteTool = {
  description: 'Read a record.',
  inputSchema: {
    additionalProperties: false,
    properties: { id: { type: 'integer' } },
    required: ['id'],
    type: 'object',
  },
  name: 'records_read',
  outputSchema: { type: 'object' },
};

class FakeSession implements McpSession {
  public calls = 0;
  public closes = 0;
  public connects = 0;
  public lists = 0;
  public result: McpRemoteToolResult = {
    content: [{ text: 'ok', type: 'text' }],
    structuredContent: { found: true },
  };
  public tools: readonly McpRemoteTool[] = [remoteTool];

  public connect(): Promise<void> {
    this.connects += 1;
    return Promise.resolve();
  }

  public listTools(): Promise<readonly McpRemoteTool[]> {
    this.lists += 1;
    return Promise.resolve(this.tools);
  }

  public callTool(): Promise<McpRemoteToolResult> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }

  public close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }
}

function client(session: McpSession, namespace = 'crm', serverId = 'server-1'): McpToolClient {
  return new McpToolClient({
    annotations: { records_read: { readOnly: true } },
    clock: () => new Date('2026-08-07T12:00:00.000Z'),
    namespace,
    serverId,
    session,
  });
}

describe('McpToolClient', () => {
  it('discovers, qualifies, caches, refreshes, and executes through ToolRegistry', async () => {
    const session = new FakeSession();
    const mcp = client(session);
    const first = await mcp.discover();
    const cached = await mcp.discover();
    expect(session.connects).toBe(1);
    expect(session.lists).toBe(1);
    expect(first).toMatchObject({
      discoveredAt: '2026-08-07T12:00:00.000Z',
      serverId: 'server-1',
    });
    expect(first.tools[0]?.definition).toMatchObject({
      annotations: { readOnly: true },
      name: 'crm__records_read',
    });
    expect(cached.tools).not.toBe(first.tools);

    const registry = new ToolRegistry(first.tools);
    const output = await registry.execute(
      { arguments: { id: 42 }, id: 'call-1', name: 'crm__records_read' },
      {
        callId: 'call-1',
        deadline: new Date(Date.now() + 10_000).toISOString(),
        runId: 'run-1',
        signal: new AbortController().signal,
      },
    );
    expect(output).toEqual({
      content: [{ source: 'generated', text: 'ok', type: 'text' }],
      structuredContent: { found: true },
    });
    expect(session.calls).toBe(1);

    mcp.invalidate();
    await mcp.discover();
    await mcp.discover({ force: true });
    expect(session.lists).toBe(3);
  });

  it('converts every supported MCP result content type', async () => {
    const session = new FakeSession();
    session.result = {
      content: [
        { data: 'AQI=', mimeType: 'audio/wav', type: 'audio' },
        { data: 'AwQ=', mimeType: 'image/png', type: 'image' },
        { resource: { text: 'resource text', uri: 'memory://one' }, type: 'resource' },
        {
          resource: { blob: 'BQY=', mimeType: 'application/pdf', uri: 'memory://two' },
          type: 'resource',
        },
        {
          mimeType: 'text/csv',
          name: 'report.csv',
          title: 'Report',
          type: 'resource_link',
          uri: 'https://example.test/report.csv',
        },
        {
          resource: { blob: 'Bwg=', uri: 'memory://three' },
          type: 'resource',
        },
        {
          name: 'untitled.bin',
          type: 'resource_link',
          uri: 'https://example.test/untitled.bin',
        },
      ],
    };
    const tool = (await client(session).discover()).tools[0];
    if (tool === undefined) {
      throw new Error('Expected tool.');
    }
    const output = await tool.execute(
      {},
      {
        callId: 'call',
        deadline: new Date(Date.now() + 10_000).toISOString(),
        runId: 'run',
        signal: new AbortController().signal,
      },
    );
    expect(output.content?.map(({ type }) => type)).toEqual([
      'audio',
      'image',
      'text',
      'document',
      'document',
      'document',
      'document',
    ]);
    expect(output.content?.[0]).toMatchObject({ source: { bytes: new Uint8Array([1, 2]) } });
    expect(output.content?.[4]).toMatchObject({ filename: 'report.csv', title: 'Report' });
    expect(output.content?.[5]).toMatchObject({ mimeType: 'application/octet-stream' });
    expect(output.content?.[6]).toMatchObject({
      filename: 'untitled.bin',
      mimeType: 'application/octet-stream',
    });
  });

  it('uses safe defaults and deduplicates concurrent connection attempts', async () => {
    let resolveConnect: (() => void) | undefined;
    const session = new FakeSession();
    session.tools = [{ inputSchema: { type: 'object' }, name: 'minimal' }];
    session.connect = () => {
      session.connects += 1;
      return new Promise<void>((resolve) => {
        resolveConnect = resolve;
      });
    };
    const mcp = new McpToolClient({ namespace: 'minimal', serverId: 'minimal', session });
    const first = mcp.connect();
    const second = mcp.connect();
    expect(mcp.state).toBe('connecting');
    resolveConnect?.();
    await Promise.all([first, second]);
    await mcp.connect();
    expect(session.connects).toBe(1);
    const discovery = await mcp.discover();
    expect(discovery.tools[0]?.definition).toMatchObject({
      description: 'MCP tool minimal from minimal.',
      name: 'minimal__minimal',
    });
    expect(discovery.tools[0]?.definition).not.toHaveProperty('annotations');
    expect(discovery.tools[0]?.definition).not.toHaveProperty('outputSchema');
  });

  it('normalizes reported errors, transport errors, cancellation, and deadlines', async () => {
    const session = new FakeSession();
    session.result = { content: [], isError: true };
    const tool = (await client(session).discover()).tools[0];
    if (tool === undefined) {
      throw new Error('Expected tool.');
    }
    await expect(
      tool.execute(
        {},
        {
          callId: 'call',
          deadline: new Date(Date.now() + 10_000).toISOString(),
          runId: 'run',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'mcp_tool_reported_error' });
    await expect(
      tool.execute(
        {},
        {
          callId: 'call',
          deadline: new Date(Date.now() - 1).toISOString(),
          runId: 'run',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'mcp_tool_deadline_exceeded' });

    const cancelled = new AbortController();
    cancelled.abort('stop');
    await expect(
      tool.execute(
        {},
        {
          callId: 'call',
          deadline: new Date(Date.now() + 10_000).toISOString(),
          runId: 'run',
          signal: cancelled.signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'mcp_concurrency_cancelled' });
  });

  it('rejects duplicate and non-portable tool names and closes idempotently', async () => {
    const session = new FakeSession();
    session.tools = [remoteTool, remoteTool];
    const mcp = client(session);
    await expect(mcp.discover()).rejects.toMatchObject({ code: 'duplicate_mcp_tool' });
    await mcp.close();
    await mcp.close();
    expect(session.closes).toBe(1);
    await expect(mcp.connect()).rejects.toMatchObject({ code: 'mcp_client_closed' });
    expect(() => qualifyMcpToolName('bad space', 'tool')).toThrow(
      expect.objectContaining({ code: 'invalid_mcp_identifier' }),
    );
    expect(() => qualifyMcpToolName('a'.repeat(40), 'b'.repeat(40))).toThrow(
      expect.objectContaining({ code: 'mcp_tool_name_too_long' }),
    );
    expect(
      () =>
        new McpToolClient({
          maxConcurrency: 0,
          namespace: 'valid',
          serverId: 'valid',
          session: new FakeSession(),
        }),
    ).toThrow(expect.objectContaining({ code: 'invalid_mcp_limit' }));
  });

  it('normalizes lifecycle and call failures and rejects invalid binary content', async () => {
    const connectFailure = new FakeSession();
    connectFailure.connect = () => Promise.reject(new Error('offline'));
    const disconnected = client(connectFailure);
    await expect(disconnected.connect()).rejects.toMatchObject({
      code: 'mcp_operation_failed',
      retryable: true,
    });
    expect(disconnected.state).toBe('disconnected');

    const discoveryFailure = new FakeSession();
    discoveryFailure.listTools = () => Promise.reject(new Error('list failed'));
    const failedDiscoveryClient = client(discoveryFailure);
    await expect(failedDiscoveryClient.discover()).rejects.toMatchObject({
      code: 'mcp_operation_failed',
      retryable: true,
    });
    expect(failedDiscoveryClient.state).toBe('disconnected');
    expect(discoveryFailure.closes).toBe(1);

    const callFailure = new FakeSession();
    callFailure.callTool = () => Promise.reject(new Error('call failed'));
    const failingTool = (await client(callFailure).discover()).tools[0];
    if (failingTool === undefined) {
      throw new Error('Expected tool.');
    }
    await expect(
      failingTool.execute(
        {},
        {
          callId: 'call',
          deadline: new Date(Date.now() + 10_000).toISOString(),
          runId: 'run',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'mcp_operation_failed', retryable: false });

    const cancelledCall = new FakeSession();
    const callController = new AbortController();
    cancelledCall.callTool = () => {
      callController.abort('stop');
      return Promise.reject(new Error('cancelled'));
    };
    const cancelledTool = (await client(cancelledCall).discover()).tools[0];
    if (cancelledTool === undefined) {
      throw new Error('Expected tool.');
    }
    await expect(
      cancelledTool.execute(
        {},
        {
          callId: 'call',
          deadline: new Date(Date.now() + 10_000).toISOString(),
          runId: 'run',
          signal: callController.signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'mcp_operation_cancelled' });

    const typedFailure = new FakeSession();
    typedFailure.callTool = () =>
      Promise.reject(new AiError('tool_execution', 'Typed failure.', { code: 'typed_failure' }));
    const typedTool = (await client(typedFailure).discover()).tools[0];
    if (typedTool === undefined) {
      throw new Error('Expected tool.');
    }
    await expect(
      typedTool.execute(
        {},
        {
          callId: 'call',
          deadline: new Date(Date.now() + 10_000).toISOString(),
          runId: 'run',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'typed_failure' });

    const invalidBinary = new FakeSession();
    invalidBinary.result = {
      content: [{ data: 'not base64', mimeType: 'image/png', type: 'image' }],
    };
    const binaryTool = (await client(invalidBinary).discover()).tools[0];
    if (binaryTool === undefined) {
      throw new Error('Expected tool.');
    }
    await expect(
      binaryTool.execute(
        {},
        {
          callId: 'call',
          deadline: new Date(Date.now() + 10_000).toISOString(),
          runId: 'run',
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid_mcp_base64' });

    const closeFailure = new FakeSession();
    closeFailure.close = () => Promise.reject(new Error('close failed'));
    const closing = client(closeFailure);
    await expect(closing.close()).rejects.toMatchObject({ code: 'mcp_operation_failed' });
    expect(closing.state).toBe('closed');
  });

  it('enforces per-server concurrency and cancellation while queued', async () => {
    let active = 0;
    let maximum = 0;
    const releases: (() => void)[] = [];
    const session = new FakeSession();
    session.callTool = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return { content: [] };
    };
    const mcp = new McpToolClient({
      maxConcurrency: 1,
      namespace: 'crm',
      serverId: 'server',
      session,
    });
    const tool = (await mcp.discover()).tools[0];
    if (tool === undefined) {
      throw new Error('Expected tool.');
    }
    const context = {
      callId: 'call',
      deadline: new Date(Date.now() + 10_000).toISOString(),
      runId: 'run',
      signal: new AbortController().signal,
    };
    const first = tool.execute({}, context);
    const second = tool.execute({}, context);
    await expect.poll(() => active).toBe(1);
    releases.shift()?.();
    await first;
    await expect.poll(() => active).toBe(1);
    releases.shift()?.();
    await second;
    expect(maximum).toBe(1);

    const blocked = tool.execute({}, context);
    const controller = new AbortController();
    const cancelled = tool.execute({}, { ...context, signal: controller.signal });
    await Promise.resolve();
    controller.abort('stop');
    await expect(cancelled).rejects.toMatchObject({ code: 'mcp_concurrency_cancelled' });
    releases.shift()?.();
    await blocked;
  });
});

describe('McpToolBroker', () => {
  it('aggregates registries and rejects duplicate servers and qualified names', async () => {
    const first = client(new FakeSession(), 'shared', 'first');
    const second = client(new FakeSession(), 'shared', 'second');
    const broker = new McpToolBroker({ clients: [first] });
    expect((await broker.registry()).definitions).toHaveLength(1);
    broker.invalidate();
    await broker.close();

    expect(() => new McpToolBroker({ clients: [first, first] })).toThrow(
      expect.objectContaining({ code: 'duplicate_mcp_server' }),
    );
    await expect(
      new McpToolBroker({
        clients: [client(new FakeSession(), 'shared', 'third'), second],
      }).discover(),
    ).rejects.toMatchObject({ code: 'duplicate_qualified_mcp_tool' });
  });

  it('attempts every close and reports aggregate failure', async () => {
    const failing = new FakeSession();
    failing.close = () => Promise.reject(new Error('failed'));
    const healthy = new FakeSession();
    const broker = new McpToolBroker({
      clients: [client(failing, 'one', 'one'), client(healthy, 'two', 'two')],
    });
    await expect(broker.close()).rejects.toMatchObject({ code: 'mcp_broker_close_failed' });
    expect(healthy.closes).toBe(1);
  });
});

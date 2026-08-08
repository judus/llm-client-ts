import type * as OpenAIModule from 'openai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenAIRealtimeTransport } from '../src/index.js';
import { OpenAISdkRealtimeTransport } from '../src/realtime-transport.js';

type Listener = (value: unknown) => void;

class FakeRealtimeSocket {
  public readonly closeCalls: { code: number; reason: string }[] = [];
  public readonly sent: string[] = [];
  public sendError: Error | undefined;
  readonly #emitterListeners = new Map<string, Set<Listener>>();
  readonly #socketListeners = new Map<string, Set<Listener>>();

  public readonly socket = {
    addEventListener: (name: string, listener: Listener): void => {
      this.#listeners(this.#socketListeners, name).add(listener);
    },
    removeEventListener: (name: string, listener: Listener): void => {
      this.#socketListeners.get(name)?.delete(listener);
    },
    send: (value: string): void => {
      if (this.sendError !== undefined) {
        throw this.sendError;
      }
      this.sent.push(value);
    },
  };

  public on(name: string, listener: Listener): void {
    this.#listeners(this.#emitterListeners, name).add(listener);
  }

  public off(name: string, listener: Listener): void {
    this.#emitterListeners.get(name)?.delete(listener);
  }

  public close(value: { code: number; reason: string }): void {
    this.closeCalls.push(value);
  }

  public emitEvent(value: unknown): void {
    this.#emit(this.#emitterListeners, 'event', value);
  }

  public emitError(value: unknown): void {
    this.#emit(this.#emitterListeners, 'error', value);
  }

  public emitClose(code: number, reason = ''): void {
    this.#emit(this.#socketListeners, 'close', { code, reason });
  }

  #listeners(map: Map<string, Set<Listener>>, name: string): Set<Listener> {
    const existing = map.get(name);
    if (existing !== undefined) {
      return existing;
    }
    const listeners = new Set<Listener>();
    map.set(name, listeners);
    return listeners;
  }

  #emit(map: Map<string, Set<Listener>>, name: string, value: unknown): void {
    for (const listener of map.get(name) ?? []) {
      listener(value);
    }
  }
}

const mocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  create: vi.fn(),
}));

vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenAIModule>();
  return {
    ...actual,
    default: class MockOpenAI {
      public readonly mocked = true;

      public constructor(options: unknown) {
        mocks.clientOptions.push(options);
      }
    },
  };
});

vi.mock('openai/realtime/websocket', () => ({
  OpenAIRealtimeWebSocket: { create: mocks.create },
}));

describe('OpenAISdkRealtimeTransport', () => {
  beforeEach(() => {
    mocks.clientOptions.length = 0;
    mocks.create.mockReset();
  });

  it('connects with an ephemeral secret and exposes SDK-free wire events', async () => {
    const socket = new FakeRealtimeSocket();
    mocks.create.mockResolvedValue(socket);
    const transport = createOpenAIRealtimeTransport({
      baseUrl: 'https://openai.invalid/v1',
      clientSecret: 'ek_test',
    });

    const connection = await transport.connect({ model: 'gpt-realtime' }, {});
    const iterator = connection.events()[Symbol.asyncIterator]();
    socket.emitEvent({ event_id: 'evt-1', type: 'session.created' });
    socket.emitError(new Error('socket warning'));
    socket.emitClose(1_001, 'going away');

    expect(mocks.clientOptions).toEqual([
      {
        apiKey: 'ek_test',
        baseURL: 'https://openai.invalid/v1',
        dangerouslyAllowBrowser: true,
      },
    ]);
    expect(mocks.create).toHaveBeenCalledWith(expect.anything(), {
      dangerouslyAllowBrowser: true,
      model: 'gpt-realtime',
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        message: { event_id: 'evt-1', type: 'session.created' },
        type: 'message',
      },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { error: { category: 'transport' }, type: 'error' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { code: 1_001, reason: 'going away', type: 'closed' },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('serializes sends and rejects sends after socket closure', async () => {
    const socket = new FakeRealtimeSocket();
    mocks.create.mockResolvedValue(socket);
    const connection = await new OpenAISdkRealtimeTransport({ clientSecret: 'ek_test' }).connect(
      { model: 'gpt-realtime' },
      {},
    );

    connection.send({ audio: 'AQID', type: 'input_audio_buffer.append' });
    expect(socket.sent).toEqual(['{"audio":"AQID","type":"input_audio_buffer.append"}']);

    socket.emitClose(1_000);
    expect(() => {
      connection.send({ type: 'response.create' });
    }).toThrow(expect.objectContaining({ code: 'openai_realtime_connection_closed' }));
  });

  it('normalizes synchronous socket send failures into the event stream', async () => {
    const socket = new FakeRealtimeSocket();
    socket.sendError = new Error('send failed');
    mocks.create.mockResolvedValue(socket);
    const connection = await new OpenAISdkRealtimeTransport({ clientSecret: 'ek_test' }).connect(
      { model: 'gpt-realtime' },
      {},
    );
    const next = connection.events()[Symbol.asyncIterator]().next();

    expect(() => {
      connection.send({ type: 'response.create' });
    }).toThrow(expect.objectContaining({ category: 'transport' }));
    await expect(next).resolves.toMatchObject({
      value: { error: { category: 'transport' }, type: 'error' },
    });
  });

  it('allows one event consumer and makes close idempotent at the transport boundary', async () => {
    const socket = new FakeRealtimeSocket();
    mocks.create.mockResolvedValue(socket);
    const connection = await new OpenAISdkRealtimeTransport({ clientSecret: 'ek_test' }).connect(
      { model: 'gpt-realtime' },
      {},
    );

    connection.events();
    expect(() => connection.events()).toThrow(
      expect.objectContaining({ code: 'openai_realtime_transport_events_claimed' }),
    );
    connection.close();
    connection.close();
    expect(socket.closeCalls).toEqual([{ code: 1_000, reason: 'client closed' }]);
  });

  it('propagates cancellation before and after connection creation', async () => {
    const before = new AbortController();
    before.abort('stop');
    const transport = new OpenAISdkRealtimeTransport({ clientSecret: 'ek_test' });

    await expect(
      transport.connect({ model: 'gpt-realtime' }, { signal: before.signal }),
    ).rejects.toMatchObject({ category: 'cancelled' });
    expect(mocks.create).not.toHaveBeenCalled();

    const socket = new FakeRealtimeSocket();
    mocks.create.mockResolvedValue(socket);
    const after = new AbortController();
    await transport.connect({ model: 'gpt-realtime' }, { signal: after.signal });
    after.abort();
    expect(socket.closeCalls).toEqual([{ code: 1_000, reason: 'cancelled' }]);

    const during = new AbortController();
    const duringSocket = new FakeRealtimeSocket();
    mocks.create.mockImplementationOnce(() => {
      during.abort('during handshake');
      return Promise.resolve(duringSocket);
    });
    await expect(
      transport.connect({ model: 'gpt-realtime' }, { signal: during.signal }),
    ).rejects.toMatchObject({ category: 'cancelled' });
    expect(duringSocket.closeCalls).toEqual([{ code: 1_000, reason: 'cancelled' }]);
  });

  it('settles pending reads when the socket closes', async () => {
    const socket = new FakeRealtimeSocket();
    mocks.create.mockResolvedValue(socket);
    const connection = await new OpenAISdkRealtimeTransport({ clientSecret: 'ek_test' }).connect(
      { model: 'gpt-realtime' },
      {},
    );
    const iterator = connection.events()[Symbol.asyncIterator]();
    const terminal = iterator.next();
    const completion = iterator.next();

    socket.emitClose(1_000);

    await expect(terminal).resolves.toEqual({
      done: false,
      value: { code: 1_000, type: 'closed' },
    });
    await expect(completion).resolves.toEqual({ done: true, value: undefined });
  });

  it('fails closed when unread events exceed the configured bound', async () => {
    const socket = new FakeRealtimeSocket();
    mocks.create.mockResolvedValue(socket);
    const connection = await new OpenAISdkRealtimeTransport({
      clientSecret: 'ek_test',
      maxPendingEvents: 1,
    }).connect({ model: 'gpt-realtime' }, {});
    const iterator = connection.events()[Symbol.asyncIterator]();

    socket.emitEvent({ event_id: 'evt-1', type: 'one' });
    socket.emitEvent({ event_id: 'evt-2', type: 'two' });

    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        error: { code: 'openai_realtime_event_buffer_overflow' },
        type: 'error',
      },
    });
    expect(socket.closeCalls).toEqual([{ code: 1_009, reason: 'event buffer overflow' }]);
  });

  it('fails closed on malformed provider events and ignores duplicate provider errors', async () => {
    const socket = new FakeRealtimeSocket();
    mocks.create.mockResolvedValue(socket);
    const connection = await new OpenAISdkRealtimeTransport({ clientSecret: 'ek_test' }).connect(
      { model: 'gpt-realtime' },
      {},
    );
    const iterator = connection.events()[Symbol.asyncIterator]();

    socket.emitError({ error: { message: 'provider event' } });
    socket.emitEvent(null);

    await expect(iterator.next()).resolves.toMatchObject({
      value: { error: { code: 'openai_realtime_event_malformed' }, type: 'error' },
    });
    expect(socket.closeCalls).toEqual([{ code: 1_007, reason: 'malformed event' }]);
  });

  it('rejects unsafe secrets, empty models, limits, and connection failures', async () => {
    expect(() => new OpenAISdkRealtimeTransport({ clientSecret: 'sk-long-lived' })).toThrow(
      expect.objectContaining({ code: 'openai_realtime_client_secret_invalid' }),
    );
    expect(
      () => new OpenAISdkRealtimeTransport({ clientSecret: 'ek_test', maxPendingEvents: 0 }),
    ).toThrow(expect.objectContaining({ code: 'openai_realtime_event_buffer_limit_invalid' }));

    const transport = new OpenAISdkRealtimeTransport({ clientSecret: 'ek_test' });
    await expect(transport.connect({ model: ' ' }, {})).rejects.toMatchObject({
      code: 'openai_realtime_model_empty',
    });

    mocks.create.mockRejectedValue(new Error('handshake failed'));
    await expect(transport.connect({ model: 'gpt-realtime' }, {})).rejects.toMatchObject({
      category: 'transport',
    });
  });
});

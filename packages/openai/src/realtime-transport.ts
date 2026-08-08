import { AiError, type CallOptions, type JsonObject } from '@maduser/ai-ts';
import OpenAI from 'openai';
import type { RealtimeServerEvent } from 'openai/resources/realtime/realtime';
import { OpenAIRealtimeWebSocket } from 'openai/realtime/websocket';

import { mapOpenAIError } from './error-mapper.js';

export interface OpenAIRealtimeTransportConnectRequest {
  readonly model: string;
}

export type OpenAIRealtimeTransportEvent =
  | { readonly error: AiError; readonly type: 'error' }
  | { readonly code?: number; readonly reason?: string; readonly type: 'closed' }
  | { readonly message: JsonObject; readonly type: 'message' };

export interface OpenAIRealtimeTransportConnection {
  close(code?: number, reason?: string): void;
  events(): AsyncIterable<OpenAIRealtimeTransportEvent>;
  send(event: JsonObject): void;
}

export interface OpenAIRealtimeTransport {
  connect(
    request: OpenAIRealtimeTransportConnectRequest,
    options: CallOptions,
  ): Promise<OpenAIRealtimeTransportConnection>;
}

export interface OpenAIRealtimeTransportOptions {
  /** Short-lived OpenAI client secret. Long-lived API keys are rejected. */
  readonly clientSecret: string;
  /** Alternate OpenAI-compatible API base URL. */
  readonly baseUrl?: string;
  /** Maximum unread socket events before the connection fails closed. Defaults to 1024. */
  readonly maxPendingEvents?: number;
}

export class OpenAISdkRealtimeTransport implements OpenAIRealtimeTransport {
  readonly #client: OpenAI;
  readonly #maxPendingEvents: number;

  public constructor(options: OpenAIRealtimeTransportOptions) {
    this.#maxPendingEvents = positiveInteger(options.maxPendingEvents ?? 1_024);
    this.#client = new OpenAI({
      apiKey: clientSecret(options.clientSecret),
      ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
      dangerouslyAllowBrowser: true,
    });
  }

  public async connect(
    request: OpenAIRealtimeTransportConnectRequest,
    options: CallOptions,
  ): Promise<OpenAIRealtimeTransportConnection> {
    const signal = options.signal;
    if (isAborted(signal)) {
      throw cancelled(signal?.reason);
    }
    try {
      const socket = await OpenAIRealtimeWebSocket.create(this.#client, {
        dangerouslyAllowBrowser: true,
        model: nonEmptyModel(request.model),
      });
      if (isAborted(signal)) {
        socket.close({ code: 1_000, reason: 'cancelled' });
        throw cancelled(signal?.reason);
      }
      return new SdkRealtimeTransportConnection(socket, this.#maxPendingEvents, signal);
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }
}

export function createOpenAIRealtimeTransport(
  options: OpenAIRealtimeTransportOptions,
): OpenAIRealtimeTransport {
  return new OpenAISdkRealtimeTransport(options);
}

class SdkRealtimeTransportConnection implements OpenAIRealtimeTransportConnection {
  readonly #events: BoundedAsyncEventQueue;
  readonly #signal: AbortSignal | undefined;
  readonly #socket: OpenAIRealtimeWebSocket;
  #closeRequested = false;
  #eventsClaimed = false;
  #terminal = false;

  public constructor(
    socket: OpenAIRealtimeWebSocket,
    maxPendingEvents: number,
    signal: AbortSignal | undefined,
  ) {
    this.#socket = socket;
    this.#signal = signal;
    this.#events = new BoundedAsyncEventQueue(maxPendingEvents, () => {
      this.close(1_009, 'event buffer overflow');
    });
    socket.on('event', this.#onMessage);
    socket.on('error', this.#onError);
    socket.socket.addEventListener('close', this.#onClose, { once: true });
    signal?.addEventListener('abort', this.#onAbort, { once: true });
  }

  public send(event: JsonObject): void {
    if (this.#closeRequested || this.#terminal) {
      throw new AiError('invalid_request', 'OpenAI realtime connection is closed.', {
        code: 'openai_realtime_connection_closed',
      });
    }
    try {
      this.#socket.socket.send(JSON.stringify(event));
    } catch (error) {
      const normalized = mapOpenAIError(error);
      this.#events.push({ error: normalized, type: 'error' });
      throw normalized;
    }
  }

  public close(code = 1_000, reason = 'client closed'): void {
    if (this.#closeRequested || this.#terminal) {
      return;
    }
    this.#closeRequested = true;
    this.#socket.close({ code, reason });
  }

  public events(): AsyncIterable<OpenAIRealtimeTransportEvent> {
    if (this.#eventsClaimed) {
      throw new AiError('invalid_request', 'OpenAI realtime events can only be consumed once.', {
        code: 'openai_realtime_transport_events_claimed',
      });
    }
    this.#eventsClaimed = true;
    return this.#events;
  }

  readonly #onMessage = (event: RealtimeServerEvent): void => {
    if (!isJsonObject(event)) {
      this.#events.fail(
        new AiError('malformed_response', 'OpenAI emitted a non-object realtime event.', {
          code: 'openai_realtime_event_malformed',
        }),
      );
      this.close(1_007, 'malformed event');
      return;
    }
    this.#events.push({ message: event, type: 'message' });
  };

  readonly #onError = (error: unknown): void => {
    if (hasProviderEvent(error)) {
      return;
    }
    this.#events.push({ error: mapOpenAIError(error), type: 'error' });
  };

  readonly #onClose = (event: CloseEvent): void => {
    if (this.#terminal) {
      return;
    }
    this.#terminal = true;
    this.#detach();
    this.#events.end({
      code: event.code,
      ...(event.reason.length === 0 ? {} : { reason: event.reason }),
      type: 'closed',
    });
  };

  readonly #onAbort = (): void => {
    this.close(1_000, 'cancelled');
  };

  #detach(): void {
    this.#signal?.removeEventListener('abort', this.#onAbort);
    this.#socket.off('event', this.#onMessage);
    this.#socket.off('error', this.#onError);
    this.#socket.socket.removeEventListener('close', this.#onClose);
  }
}

class BoundedAsyncEventQueue implements AsyncIterable<OpenAIRealtimeTransportEvent> {
  readonly #maxPendingEvents: number;
  readonly #onOverflow: () => void;
  readonly #pending: OpenAIRealtimeTransportEvent[] = [];
  readonly #waiters: ((result: IteratorResult<OpenAIRealtimeTransportEvent>) => void)[] = [];
  #ended = false;

  public constructor(maxPendingEvents: number, onOverflow: () => void) {
    this.#maxPendingEvents = maxPendingEvents;
    this.#onOverflow = onOverflow;
  }

  public push(event: OpenAIRealtimeTransportEvent): void {
    if (this.#ended) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: event });
      return;
    }
    if (this.#pending.length >= this.#maxPendingEvents) {
      this.fail(
        new AiError('transport', 'OpenAI realtime event buffer overflowed.', {
          code: 'openai_realtime_event_buffer_overflow',
        }),
      );
      this.#onOverflow();
      return;
    }
    this.#pending.push(event);
  }

  public fail(error: AiError): void {
    if (this.#ended) {
      return;
    }
    this.#pending.length = 0;
    this.push({ error, type: 'error' });
  }

  public end(event: OpenAIRealtimeTransportEvent): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#pending.push(event);
    } else {
      waiter({ done: false, value: event });
    }
    for (const remaining of this.#waiters.splice(0)) {
      remaining({ done: true, value: undefined });
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<OpenAIRealtimeTransportEvent> {
    return {
      next: () => {
        const event = this.#pending.shift();
        if (event !== undefined) {
          return Promise.resolve({ done: false, value: event });
        }
        if (this.#ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AiError('invalid_request', 'OpenAI realtime event-buffer limit is invalid.', {
      code: 'openai_realtime_event_buffer_limit_invalid',
      details: { maxPendingEvents: value },
    });
  }
  return value;
}

function nonEmptyModel(value: string): string {
  if (value.trim().length === 0) {
    throw new AiError('invalid_request', 'OpenAI realtime model cannot be empty.', {
      code: 'openai_realtime_model_empty',
    });
  }
  return value;
}

function clientSecret(value: string): string {
  if (!value.startsWith('ek_') || value.trim() !== value) {
    throw new AiError('authentication', 'OpenAI realtime requires a short-lived client secret.', {
      code: 'openai_realtime_client_secret_invalid',
    });
  }
  return value;
}

function cancelled(cause: unknown): AiError {
  return new AiError('cancelled', 'OpenAI realtime connection was cancelled.', {
    cause,
    code: 'openai_realtime_connection_cancelled',
  });
}

function hasProviderEvent(error: unknown): boolean {
  return isRecord(error) && isRecord(error['error']);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

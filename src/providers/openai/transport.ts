import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

import type { OpenAIProviderOptions, OpenAIWireEvent, OpenAIWireLogger } from './configuration.js';

export interface OpenAITransportCallOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface OpenAIResponsesTransport {
  create(
    request: ResponseCreateParamsNonStreaming,
    options: OpenAITransportCallOptions,
  ): Promise<Response>;
  stream(
    request: ResponseCreateParamsStreaming,
    options: OpenAITransportCallOptions,
  ): Promise<AsyncIterable<ResponseStreamEvent>>;
}

export class OpenAISdkResponsesTransport implements OpenAIResponsesTransport {
  readonly #client: OpenAI;
  readonly #wireLogger: OpenAIWireLogger | undefined;

  public constructor(options: OpenAIProviderOptions) {
    this.#wireLogger = options.wireLogger;
    this.#client = new OpenAI({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.organization === undefined ? {} : { organization: options.organization }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
  }

  public async create(
    request: ResponseCreateParamsNonStreaming,
    options: OpenAITransportCallOptions,
  ): Promise<Response> {
    const attemptId = randomUUID();
    this.#log({ attemptId, operation: 'create', phase: 'request', payload: request });
    try {
      const response = await this.#client.responses.create(request, sdkCallOptions(options));
      this.#log({ attemptId, operation: 'create', phase: 'response', payload: response });
      return response;
    } catch (error) {
      this.#log({ attemptId, operation: 'create', phase: 'error', payload: error });
      throw error;
    }
  }

  public async stream(
    request: ResponseCreateParamsStreaming,
    options: OpenAITransportCallOptions,
  ): Promise<AsyncIterable<ResponseStreamEvent>> {
    const attemptId = randomUUID();
    this.#log({ attemptId, operation: 'stream', phase: 'request', payload: request });
    try {
      const stream = await this.#client.responses.create(request, sdkCallOptions(options));
      this.#log({
        attemptId,
        operation: 'stream',
        phase: 'response',
        payload: { type: 'stream_opened' },
      });
      return this.#wireLogger === undefined ? stream : this.#logStream(stream, attemptId);
    } catch (error) {
      this.#log({ attemptId, operation: 'stream', phase: 'error', payload: error });
      throw error;
    }
  }

  async *#logStream(
    stream: AsyncIterable<ResponseStreamEvent>,
    attemptId: string,
  ): AsyncGenerator<ResponseStreamEvent, void, void> {
    try {
      for await (const event of stream) {
        this.#log({ attemptId, operation: 'stream', phase: 'stream_event', payload: event });
        yield event;
      }
    } catch (error) {
      this.#log({ attemptId, operation: 'stream', phase: 'error', payload: error });
      throw error;
    }
  }

  #log(event: Omit<OpenAIWireEvent, 'at'>): void {
    if (this.#wireLogger === undefined) return;
    try {
      this.#wireLogger({ ...event, at: new Date().toISOString() });
    } catch {
      // Diagnostics must never prevent an OpenAI request from completing.
    }
  }
}

function sdkCallOptions(options: OpenAITransportCallOptions): {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeout?: number;
} {
  return {
    ...(options.idempotencyKey === undefined
      ? {}
      : { headers: { 'Idempotency-Key': options.idempotencyKey } }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  };
}

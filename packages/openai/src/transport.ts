import OpenAI from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';

import type { OpenAIProviderOptions } from './configuration.js';

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

  public constructor(options: OpenAIProviderOptions) {
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
    return this.#client.responses.create(request, sdkCallOptions(options));
  }

  public async stream(
    request: ResponseCreateParamsStreaming,
    options: OpenAITransportCallOptions,
  ): Promise<AsyncIterable<ResponseStreamEvent>> {
    return this.#client.responses.create(request, sdkCallOptions(options));
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

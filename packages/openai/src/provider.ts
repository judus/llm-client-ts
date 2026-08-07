import { randomUUID } from 'node:crypto';

import {
  AiError,
  serializeAiError,
  type CallOptions,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from '@maduser/ai-ts';

import { defaultOpenAIModelCapabilities, type OpenAIProviderOptions } from './configuration.js';
import { mapOpenAIError } from './error-mapper.js';
import { mapOpenAIRequest, mapOpenAIStreamRequest } from './request-mapper.js';
import { mapOpenAIResponse, mapOpenAIToolCall } from './response-mapper.js';
import {
  OpenAISdkResponsesTransport,
  type OpenAIResponsesTransport,
  type OpenAITransportCallOptions,
} from './transport.js';

type ModelEventPayload<T extends ModelStreamEvent = ModelStreamEvent> = T extends ModelStreamEvent
  ? Omit<T, 'eventId' | 'occurredAt' | 'requestId' | 'sequence'>
  : never;

export interface OpenAIProviderDependencies {
  readonly createId: () => string;
  readonly now: () => Date;
  readonly transport: OpenAIResponsesTransport;
}

export class OpenAIProvider implements ModelProvider {
  public readonly id = 'openai';
  readonly #capabilities: ModelCapabilities;
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #storeResponses: boolean;
  readonly #transport: OpenAIResponsesTransport;

  public constructor(
    options: OpenAIProviderOptions,
    dependencies: OpenAIProviderDependencies = defaultDependencies(options),
  ) {
    this.#capabilities = options.capabilities ?? defaultOpenAIModelCapabilities();
    this.#createId = dependencies.createId;
    this.#now = dependencies.now;
    this.#storeResponses = options.storeResponses ?? false;
    this.#transport = dependencies.transport;
  }

  public capabilities(): Promise<ModelCapabilities> {
    return Promise.resolve(this.#capabilities);
  }

  public async generate(request: ModelRequest, options?: CallOptions): Promise<ModelResponse> {
    try {
      const response = await this.#transport.create(
        mapOpenAIRequest(request, this.#storeResponses),
        transportOptions(options),
      );
      return mapOpenAIResponse(response, request, {
        messageId: this.#createId(),
        responseId: this.#createId(),
      });
    } catch (error) {
      throw mapOpenAIError(error);
    }
  }

  public async *stream(
    request: ModelRequest,
    options?: CallOptions,
  ): AsyncGenerator<ModelStreamEvent, void, void> {
    const requestId = this.#createId();
    let sequence = 0;
    yield this.#event(requestId, sequence, { type: 'model.request.started' });
    sequence += 1;

    try {
      const stream = await this.#transport.stream(
        mapOpenAIStreamRequest(request, this.#storeResponses),
        transportOptions(options),
      );
      for await (const providerEvent of stream) {
        switch (providerEvent.type) {
          case 'response.output_text.delta':
            yield this.#event(requestId, sequence, {
              delta: providerEvent.delta,
              outputIndex: providerEvent.output_index,
              type: 'model.text.delta',
            });
            sequence += 1;
            break;
          case 'response.output_item.done':
            if (providerEvent.item.type === 'function_call') {
              const part = mapOpenAIToolCall(providerEvent.item);
              yield this.#event(requestId, sequence, {
                toolCall: { arguments: part.arguments, id: part.callId, name: part.name },
                type: 'model.tool_call.completed',
              });
              sequence += 1;
            }
            break;
          case 'response.completed':
          case 'response.incomplete':
            yield this.#event(requestId, sequence, {
              response: mapOpenAIResponse(providerEvent.response, request, {
                messageId: this.#createId(),
                responseId: this.#createId(),
              }),
              type: 'model.response.completed',
            });
            return;
          case 'error':
            throw new AiError('provider_unavailable', providerEvent.message, {
              code: providerEvent.code ?? 'openai_stream_error',
              retryable: true,
            });
          case 'response.failed':
            mapOpenAIResponse(providerEvent.response, request, {
              messageId: this.#createId(),
              responseId: this.#createId(),
            });
            throw new AiError('provider_unavailable', 'OpenAI reported a failed response.', {
              code: 'openai_response_failed',
              retryable: true,
            });
          default:
            break;
        }
      }
    } catch (error) {
      yield this.#event(requestId, sequence, {
        error: serializeAiError(mapOpenAIError(error)),
        type: 'model.response.failed',
      });
    }
  }

  #event(requestId: string, sequence: number, event: ModelEventPayload): ModelStreamEvent {
    return {
      ...event,
      eventId: this.#createId(),
      occurredAt: this.#now().toISOString(),
      requestId,
      sequence,
    };
  }
}

/** Creates the OpenAI Responses API adapter without exposing OpenAI SDK objects. */
export function createOpenAIProvider(options: OpenAIProviderOptions = {}): ModelProvider {
  return new OpenAIProvider(options);
}

function defaultDependencies(options: OpenAIProviderOptions): OpenAIProviderDependencies {
  return {
    createId: randomUUID,
    now: (): Date => new Date(),
    transport: new OpenAISdkResponsesTransport(options),
  };
}

function transportOptions(options: CallOptions | undefined): OpenAITransportCallOptions {
  return {
    ...(options?.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

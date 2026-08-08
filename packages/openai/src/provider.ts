import { randomUUID } from 'node:crypto';

import {
  AiError,
  serializeAiError,
  type CallOptions,
  type ConfiguredProvider,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from '@maduser/ai-ts';

import { defaultOpenAIModelCapabilities, type OpenAIProviderOptions } from './configuration.js';
import {
  OpenAISpeechSynthesisProvider,
  OpenAITranscriptionProvider,
  type OpenAISpeechSynthesisProviderOptions,
  type OpenAITranscriptionProviderOptions,
} from './audio-provider.js';
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

export interface OpenAIClientOptions extends OpenAIProviderOptions {
  /** Model used by the fluent client. */
  readonly model: string;
  /** Speech output configuration. Set to false to disable speech synthesis. */
  readonly speechSynthesis?: false | OpenAISpeechSynthesisProviderOptions;
  /** Recorded-audio input configuration. Set to false to disable transcription. */
  readonly transcription?: false | OpenAITranscriptionProviderOptions;
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

class ConfiguredOpenAIProvider extends OpenAIProvider implements ConfiguredProvider {
  public readonly model: string;
  public readonly speechSynthesis?: OpenAISpeechSynthesisProvider;
  public readonly transcription?: OpenAITranscriptionProvider;

  public constructor(options: OpenAIClientOptions) {
    super(options);
    this.model = requireModel(options.model);
    const connection = {
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.organization === undefined ? {} : { organization: options.organization }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
    if (options.transcription !== false) {
      this.transcription = new OpenAITranscriptionProvider({
        ...connection,
        ...options.transcription,
      });
    }
    if (options.speechSynthesis !== false) {
      this.speechSynthesis = new OpenAISpeechSynthesisProvider({
        ...connection,
        ...options.speechSynthesis,
      });
    }
  }
}

/** Creates the OpenAI Responses API adapter without exposing OpenAI SDK objects. */
export function createOpenAIProvider(options: OpenAIProviderOptions = {}): ModelProvider {
  return new OpenAIProvider(options);
}

/** Creates a model-bound OpenAI provider for createAiClient(). */
export function openAI(options: OpenAIClientOptions): ConfiguredProvider {
  requireModel(options.model);
  return new ConfiguredOpenAIProvider(options);
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

function requireModel(value: string): string {
  if (value.trim().length === 0) {
    throw new AiError('invalid_request', 'OpenAI model must not be empty.', {
      code: 'openai_model_empty',
    });
  }
  return value;
}

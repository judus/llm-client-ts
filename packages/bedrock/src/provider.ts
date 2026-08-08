import { randomUUID } from 'node:crypto';

import {
  AiError,
  serializeAiError,
  type CallOptions,
  type JsonObject,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelSelector,
  type ModelStreamEvent,
} from '@maduser/ai-ts';

import { defaultBedrockModelCapabilities, type BedrockProviderOptions } from './configuration.js';
import { mapBedrockError } from './error-mapper.js';
import { mapBedrockRequest } from './request-mapper.js';
import { mapBedrockResponse, mapBedrockUsage } from './response-mapper.js';
import { BedrockSdkRuntimeTransport } from './transport.js';
import type {
  BedrockContentBlock,
  BedrockRuntimeTransport,
  BedrockStopReason,
  BedrockStreamEvent,
  BedrockTokenUsage,
} from './types.js';

type ModelEventPayload<T extends ModelStreamEvent = ModelStreamEvent> = T extends ModelStreamEvent
  ? Omit<T, 'eventId' | 'occurredAt' | 'requestId' | 'sequence'>
  : never;

type StreamBlock =
  | { readonly type: 'text'; text: string }
  | {
      emitted: boolean;
      input: string;
      readonly name: string;
      readonly toolUseId: string;
      readonly type: 'tool';
    };

export interface BedrockProviderDependencies {
  readonly createId: () => string;
  readonly now: () => Date;
  readonly transport: BedrockRuntimeTransport;
}

/** A model provider that owns a Bedrock Runtime client and can release it explicitly. */
export interface BedrockModelProvider extends ModelProvider {
  close(): void;
}

export class BedrockProvider implements BedrockModelProvider {
  public readonly id = 'bedrock';
  readonly #capabilities: ModelCapabilities;
  readonly #capabilityResolver: BedrockProviderOptions['capabilityResolver'];
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #transport: BedrockRuntimeTransport;

  public constructor(
    options: BedrockProviderOptions = {},
    dependencies: BedrockProviderDependencies = defaultDependencies(options),
  ) {
    if (options.capabilities !== undefined && options.capabilityResolver !== undefined) {
      throw new AiError(
        'invalid_request',
        'Configure either static Bedrock capabilities or a capability resolver, not both.',
        { code: 'bedrock_capability_configuration_conflict' },
      );
    }
    this.#capabilities = options.capabilities ?? defaultBedrockModelCapabilities();
    this.#capabilityResolver = options.capabilityResolver;
    this.#createId = dependencies.createId;
    this.#now = dependencies.now;
    this.#transport = dependencies.transport;
  }

  public async capabilities(model: ModelSelector): Promise<ModelCapabilities> {
    const resolved = await this.#capabilityResolver?.resolve(model);
    if (this.#capabilityResolver !== undefined && resolved === undefined) {
      throw new AiError(
        'invalid_request',
        'No Bedrock capabilities are registered for this model.',
        {
          code: 'bedrock_capabilities_unknown',
          details: { model: model.model },
        },
      );
    }
    return resolved ?? this.#capabilities;
  }

  public close(): void {
    this.#transport.close();
  }

  public async generate(request: ModelRequest, options?: CallOptions): Promise<ModelResponse> {
    try {
      rejectIdempotencyKey(options);
      const response = await this.#transport.converse(mapBedrockRequest(request), options ?? {});
      return mapBedrockResponse(response, request, {
        createdAt: this.#now().toISOString(),
        messageId: this.#createId(),
        responseId: this.#createId(),
      });
    } catch (error) {
      throw mapBedrockError(error);
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
      rejectIdempotencyKey(options);
      const stream = await this.#transport.converseStream(
        mapBedrockRequest(request),
        options ?? {},
      );
      const blocks = new Map<number, StreamBlock>();
      let stopReason: BedrockStopReason | undefined;
      let usage: BedrockTokenUsage | undefined;

      for await (const providerEvent of stream) {
        switch (providerEvent.type) {
          case 'text_delta':
            appendText(blocks, providerEvent);
            yield this.#event(requestId, sequence, {
              delta: providerEvent.text,
              outputIndex: providerEvent.contentBlockIndex,
              type: 'model.text.delta',
            });
            sequence += 1;
            break;
          case 'tool_start':
            startTool(blocks, providerEvent);
            break;
          case 'tool_delta':
            appendToolInput(blocks, providerEvent);
            break;
          case 'content_stop': {
            const block = blocks.get(providerEvent.contentBlockIndex);
            if (block?.type === 'tool' && !block.emitted) {
              const toolCall = completeTool(block);
              block.emitted = true;
              yield this.#event(requestId, sequence, {
                toolCall,
                type: 'model.tool_call.completed',
              });
              sequence += 1;
            }
            break;
          }
          case 'metadata':
            usage = providerEvent.usage;
            yield this.#event(requestId, sequence, {
              type: 'model.usage.updated',
              usage: mapBedrockUsage(usage),
            });
            sequence += 1;
            break;
          case 'message_stop':
            stopReason = providerEvent.stopReason;
            break;
          case 'error':
            throw mapBedrockError({
              message: providerEvent.message,
              name: providerEvent.code,
            });
        }
      }

      if (stopReason === undefined) {
        throw new AiError('malformed_response', 'The Bedrock stream ended without a stop event.', {
          code: 'bedrock_stream_stop_missing',
        });
      }
      for (const block of blocks.values()) {
        if (block.type === 'tool' && !block.emitted) {
          throw new AiError(
            'malformed_response',
            'The Bedrock stream ended before a tool call completed.',
            { code: 'bedrock_stream_tool_incomplete', details: { toolUseId: block.toolUseId } },
          );
        }
      }

      const response = mapBedrockResponse(
        {
          message: { content: responseContent(blocks), role: 'assistant' },
          stopReason,
          ...(usage === undefined ? {} : { usage }),
        },
        request,
        {
          createdAt: this.#now().toISOString(),
          messageId: this.#createId(),
          responseId: this.#createId(),
        },
      );
      yield this.#event(requestId, sequence, {
        response,
        type: 'model.response.completed',
      });
    } catch (error) {
      yield this.#event(requestId, sequence, {
        error: serializeAiError(mapBedrockError(error)),
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

/** Creates an Amazon Bedrock Converse adapter without exposing AWS SDK objects. */
export function createBedrockProvider(options: BedrockProviderOptions = {}): BedrockModelProvider {
  return new BedrockProvider(options);
}

function defaultDependencies(options: BedrockProviderOptions): BedrockProviderDependencies {
  return {
    createId: randomUUID,
    now: (): Date => new Date(),
    transport: new BedrockSdkRuntimeTransport(options),
  };
}

function appendText(
  blocks: Map<number, StreamBlock>,
  event: Extract<BedrockStreamEvent, { readonly type: 'text_delta' }>,
): void {
  const block = blocks.get(event.contentBlockIndex);
  if (block === undefined) {
    blocks.set(event.contentBlockIndex, { text: event.text, type: 'text' });
    return;
  }
  if (block.type !== 'text') {
    throw streamBlockConflict(event.contentBlockIndex);
  }
  block.text += event.text;
}

function startTool(
  blocks: Map<number, StreamBlock>,
  event: Extract<BedrockStreamEvent, { readonly type: 'tool_start' }>,
): void {
  if (blocks.has(event.contentBlockIndex)) {
    throw streamBlockConflict(event.contentBlockIndex);
  }
  blocks.set(event.contentBlockIndex, {
    emitted: false,
    input: '',
    name: event.name,
    toolUseId: event.toolUseId,
    type: 'tool',
  });
}

function appendToolInput(
  blocks: Map<number, StreamBlock>,
  event: Extract<BedrockStreamEvent, { readonly type: 'tool_delta' }>,
): void {
  const block = blocks.get(event.contentBlockIndex);
  if (block?.type !== 'tool') {
    throw new AiError(
      'malformed_response',
      'Bedrock streamed tool input before starting the tool call.',
      {
        code: 'bedrock_stream_tool_not_started',
        details: { contentBlockIndex: event.contentBlockIndex },
      },
    );
  }
  if (block.emitted) {
    throw new AiError(
      'malformed_response',
      'Bedrock streamed input after completing the tool call.',
      {
        code: 'bedrock_stream_tool_already_completed',
        details: { contentBlockIndex: event.contentBlockIndex },
      },
    );
  }
  block.input += event.input;
}

function completeTool(block: Extract<StreamBlock, { readonly type: 'tool' }>): {
  readonly arguments: JsonObject;
  readonly id: string;
  readonly name: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.input);
  } catch (cause) {
    throw new AiError('malformed_response', 'Bedrock streamed invalid tool-call JSON.', {
      cause,
      code: 'bedrock_stream_tool_input_invalid_json',
      details: { toolUseId: block.toolUseId },
    });
  }
  if (!isJsonObject(parsed)) {
    throw new AiError('malformed_response', 'Bedrock tool-call input must be a JSON object.', {
      code: 'bedrock_stream_tool_input_not_object',
      details: { toolUseId: block.toolUseId },
    });
  }
  return { arguments: parsed, id: block.toolUseId, name: block.name };
}

function responseContent(blocks: ReadonlyMap<number, StreamBlock>): BedrockContentBlock[] {
  return [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, block]) =>
      block.type === 'text'
        ? { text: block.text }
        : {
            toolUse: {
              input: completeTool(block).arguments,
              name: block.name,
              toolUseId: block.toolUseId,
            },
          },
    );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function streamBlockConflict(contentBlockIndex: number): AiError {
  return new AiError('malformed_response', 'Bedrock reused a streaming content block index.', {
    code: 'bedrock_stream_block_conflict',
    details: { contentBlockIndex },
  });
}

function rejectIdempotencyKey(options: CallOptions | undefined): void {
  if (options?.idempotencyKey !== undefined) {
    throw new AiError(
      'unsupported_capability',
      'Bedrock Converse does not expose an idempotency-key parameter.',
      { code: 'bedrock_idempotency_key_unsupported' },
    );
  }
}

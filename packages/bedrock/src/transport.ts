import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseRequest,
  type ConverseResponse,
  type ConverseStreamOutput,
  type Tool,
  type ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { AiError, type CallOptions, type JsonObject, type JsonValue } from '@maduser/ai-ts';

import type { BedrockProviderOptions } from './configuration.js';
import type {
  BedrockContentBlock,
  BedrockConverseRequest,
  BedrockConverseResponse,
  BedrockMessage,
  BedrockRuntimeTransport,
  BedrockStopReason,
  BedrockStreamEvent,
  BedrockTokenUsage,
  BedrockToolConfiguration,
  BedrockToolResultContent,
} from './types.js';

type SdkJsonValue =
  SdkJsonValue[] | boolean | null | number | string | { [key: string]: SdkJsonValue };

export class BedrockSdkRuntimeTransport implements BedrockRuntimeTransport {
  readonly #client: BedrockRuntimeClient;

  public constructor(options: BedrockProviderOptions = {}) {
    this.#client = new BedrockRuntimeClient({
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.region === undefined ? {} : { region: options.region }),
    });
  }

  public close(): void {
    this.#client.destroy();
  }

  public async converse(
    request: BedrockConverseRequest,
    options: CallOptions,
  ): Promise<BedrockConverseResponse> {
    rejectIdempotencyKey(options);
    const response = await this.#client.send(new ConverseCommand(sdkRequest(request)), {
      ...sdkCallOptions(options),
    });
    return normalizeResponse(response);
  }

  public async converseStream(
    request: BedrockConverseRequest,
    options: CallOptions,
  ): Promise<AsyncIterable<BedrockStreamEvent>> {
    rejectIdempotencyKey(options);
    const response = await this.#client.send(new ConverseStreamCommand(sdkRequest(request)), {
      ...sdkCallOptions(options),
    });
    if (response.stream === undefined) {
      throw malformed('Bedrock returned no output stream.', 'bedrock_stream_missing');
    }
    return normalizeStream(response.stream);
  }
}

function sdkRequest(request: BedrockConverseRequest): ConverseRequest {
  return {
    messages: request.messages.map((message) => ({
      content: message.content.map(sdkContentBlock),
      role: message.role,
    })),
    modelId: request.modelId,
    ...(request.inferenceConfig === undefined
      ? {}
      : { inferenceConfig: { ...request.inferenceConfig } }),
    ...(request.outputConfig === undefined
      ? {}
      : {
          outputConfig: {
            textFormat: {
              structure: {
                jsonSchema: { ...request.outputConfig.textFormat.structure.jsonSchema },
              },
              type: request.outputConfig.textFormat.type,
            },
          },
        }),
    ...(request.system === undefined
      ? {}
      : { system: request.system.map((block) => ({ text: block.text })) }),
    ...(request.toolConfig === undefined
      ? {}
      : {
          toolConfig: {
            ...(request.toolConfig.toolChoice === undefined
              ? {}
              : { toolChoice: { ...request.toolConfig.toolChoice } }),
            tools: request.toolConfig.tools.map(sdkTool),
          },
        }),
  };
}

function sdkContentBlock(block: BedrockContentBlock): ContentBlock {
  if ('text' in block) {
    return { text: block.text };
  }
  if ('image' in block) {
    return { image: { ...block.image, source: { bytes: block.image.source.bytes } } };
  }
  if ('document' in block) {
    return {
      document: { ...block.document, source: { bytes: block.document.source.bytes } },
    };
  }
  if ('toolUse' in block) {
    return { toolUse: { ...block.toolUse, input: mutableJson(block.toolUse.input) } };
  }
  return {
    toolResult: {
      ...block.toolResult,
      content: block.toolResult.content.map(sdkToolResultContent),
    },
  };
}

function sdkToolResultContent(block: BedrockToolResultContent): ToolResultContentBlock {
  if ('text' in block) {
    return { text: block.text };
  }
  if ('json' in block) {
    return { json: mutableJson(block.json) };
  }
  if ('image' in block) {
    return { image: { ...block.image, source: { bytes: block.image.source.bytes } } };
  }
  return {
    document: { ...block.document, source: { bytes: block.document.source.bytes } },
  };
}

function normalizeResponse(response: ConverseResponse): BedrockConverseResponse {
  if (response.output?.message === undefined) {
    throw malformed('Bedrock returned no response message.', 'bedrock_response_message_missing');
  }
  return {
    ...(response.additionalModelResponseFields === undefined
      ? {}
      : {
          additionalModelResponseFields: requireJsonValue(
            response.additionalModelResponseFields,
            'additional model response fields',
          ),
        }),
    ...(response.metrics?.latencyMs === undefined
      ? {}
      : { latencyMs: requireNonNegativeNumber(response.metrics.latencyMs, 'latency') }),
    message: normalizeMessage(response.output.message),
    stopReason: requireStopReason(response.stopReason),
    ...(response.usage === undefined ? {} : { usage: normalizeUsage(response.usage) }),
  };
}

function normalizeMessage(message: {
  readonly content: readonly ContentBlock[] | undefined;
  readonly role: string | undefined;
}): BedrockMessage {
  if (message.role !== 'assistant' && message.role !== 'user') {
    throw malformed('Bedrock returned an invalid message role.', 'bedrock_message_role_invalid');
  }
  if (message.content === undefined) {
    throw malformed(
      'Bedrock returned a message without content.',
      'bedrock_message_content_missing',
    );
  }
  return { content: message.content.map(normalizeContentBlock), role: message.role };
}

function normalizeContentBlock(block: ContentBlock): BedrockContentBlock {
  if (block.text !== undefined) {
    return { text: block.text };
  }
  if (block.toolUse !== undefined) {
    const input = requireJsonValue(block.toolUse.input, 'tool input');
    if (!isJsonObject(input)) {
      throw malformed('Bedrock tool input must be a JSON object.', 'bedrock_tool_input_not_object');
    }
    return {
      toolUse: {
        input,
        name: requireString(block.toolUse.name, 'tool name'),
        toolUseId: requireString(block.toolUse.toolUseId, 'tool use ID'),
      },
    };
  }
  throw malformed(
    'Bedrock returned an unsupported response content block.',
    'bedrock_response_content_unsupported',
  );
}

async function* normalizeStream(
  stream: AsyncIterable<ConverseStreamOutput>,
): AsyncGenerator<BedrockStreamEvent, void, void> {
  for await (const event of stream) {
    const normalized = normalizeStreamEvent(event);
    if (normalized !== undefined) {
      yield normalized;
    }
  }
}

function normalizeStreamEvent(event: ConverseStreamOutput): BedrockStreamEvent | undefined {
  if (event.messageStart !== undefined) {
    if (event.messageStart.role !== 'assistant') {
      throw malformed('Bedrock started a non-assistant stream.', 'bedrock_stream_role_invalid');
    }
    return undefined;
  }
  if (event.contentBlockStart !== undefined) {
    const index = requireIndex(event.contentBlockStart.contentBlockIndex);
    const toolUse = event.contentBlockStart.start?.toolUse;
    if (toolUse === undefined) {
      throw malformed(
        'Bedrock started an unsupported streaming content block.',
        'bedrock_stream_content_unsupported',
      );
    }
    return {
      contentBlockIndex: index,
      name: requireString(toolUse.name, 'tool name'),
      toolUseId: requireString(toolUse.toolUseId, 'tool use ID'),
      type: 'tool_start',
    };
  }
  if (event.contentBlockDelta !== undefined) {
    const index = requireIndex(event.contentBlockDelta.contentBlockIndex);
    const delta = event.contentBlockDelta.delta;
    if (delta?.text !== undefined) {
      return { contentBlockIndex: index, text: delta.text, type: 'text_delta' };
    }
    if (delta?.toolUse?.input !== undefined) {
      return { contentBlockIndex: index, input: delta.toolUse.input, type: 'tool_delta' };
    }
    return undefined;
  }
  if (event.contentBlockStop !== undefined) {
    return {
      contentBlockIndex: requireIndex(event.contentBlockStop.contentBlockIndex),
      type: 'content_stop',
    };
  }
  if (event.messageStop !== undefined) {
    return { stopReason: requireStopReason(event.messageStop.stopReason), type: 'message_stop' };
  }
  if (event.metadata !== undefined) {
    if (event.metadata.usage === undefined) {
      throw malformed('Bedrock stream metadata omitted usage.', 'bedrock_stream_usage_missing');
    }
    return { type: 'metadata', usage: normalizeUsage(event.metadata.usage) };
  }
  if (event.internalServerException !== undefined) {
    return streamError('InternalServerException', event.internalServerException.message, true);
  }
  if (event.modelStreamErrorException !== undefined) {
    return streamError('ModelStreamErrorException', event.modelStreamErrorException.message, true);
  }
  if (event.serviceUnavailableException !== undefined) {
    return streamError(
      'ServiceUnavailableException',
      event.serviceUnavailableException.message,
      true,
    );
  }
  if (event.throttlingException !== undefined) {
    return streamError('ThrottlingException', event.throttlingException.message, true);
  }
  if (event.validationException !== undefined) {
    return streamError('ValidationException', event.validationException.message, false);
  }
  return undefined;
}

function normalizeUsage(usage: {
  readonly cacheReadInputTokens?: number | undefined;
  readonly cacheWriteInputTokens?: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
}): BedrockTokenUsage {
  return {
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : {
          cacheReadInputTokens: requireNonNegativeInteger(
            usage.cacheReadInputTokens,
            'cache-read input tokens',
          ),
        }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : {
          cacheWriteInputTokens: requireNonNegativeInteger(
            usage.cacheWriteInputTokens,
            'cache-write input tokens',
          ),
        }),
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: requireNonNegativeInteger(usage.inputTokens, 'input tokens') }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: requireNonNegativeInteger(usage.outputTokens, 'output tokens') }),
    ...(usage.totalTokens === undefined
      ? {}
      : { totalTokens: requireNonNegativeInteger(usage.totalTokens, 'total tokens') }),
  };
}

function sdkTool(tool: BedrockToolConfiguration['tools'][number]): Tool {
  return {
    toolSpec: {
      ...tool.toolSpec,
      inputSchema: { json: mutableJson(tool.toolSpec.inputSchema.json) },
    },
  };
}

function mutableJson(value: JsonValue): SdkJsonValue {
  if (Array.isArray(value)) {
    return value.map(mutableJson);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, SdkJsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = mutableJson(item);
    }
    return result;
  }
  return value;
}

function requireJsonValue(value: unknown, label: string): JsonValue {
  const normalized = normalizeJsonValue(value);
  if (normalized === undefined) {
    throw malformed(`Bedrock returned invalid JSON for ${label}.`, 'bedrock_invalid_json_value');
  }
  return normalized;
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const normalized = normalizeJsonValue(item);
      if (normalized === undefined) {
        return undefined;
      }
      result.push(normalized);
    }
    return result;
  }
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizeJsonValue(item);
      if (normalized === undefined) {
        return undefined;
      }
      result[key] = normalized;
    }
    return result;
  }
  return undefined;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireStopReason(value: string | undefined): BedrockStopReason {
  switch (value) {
    case 'content_filtered':
    case 'end_turn':
    case 'guardrail_intervened':
    case 'malformed_model_output':
    case 'malformed_tool_use':
    case 'max_tokens':
    case 'model_context_window_exceeded':
    case 'stop_sequence':
    case 'tool_use':
      return value;
    default:
      throw malformed('Bedrock returned an unknown stop reason.', 'bedrock_stop_reason_invalid');
  }
}

function requireString(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw malformed(`Bedrock omitted ${label}.`, 'bedrock_required_string_missing');
  }
  return value;
}

function requireIndex(value: number | undefined): number {
  return requireNonNegativeInteger(value, 'content block index');
}

function requireNonNegativeInteger(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(`Bedrock returned an invalid ${label}.`, 'bedrock_invalid_number');
  }
  return value;
}

function requireNonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw malformed(`Bedrock returned an invalid ${label}.`, 'bedrock_invalid_number');
  }
  return value;
}

function streamError(
  code: string,
  message: string | undefined,
  retryable: boolean,
): BedrockStreamEvent {
  return {
    code,
    message: message ?? 'Bedrock reported a streaming error.',
    retryable,
    type: 'error',
  };
}

function sdkCallOptions(options: CallOptions): { abortSignal?: AbortSignal } {
  const timeoutSignal =
    options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
  const signal =
    options.signal === undefined
      ? timeoutSignal
      : timeoutSignal === undefined
        ? options.signal
        : AbortSignal.any([options.signal, timeoutSignal]);
  return signal === undefined ? {} : { abortSignal: signal };
}

function rejectIdempotencyKey(options: CallOptions): void {
  if (options.idempotencyKey !== undefined) {
    throw new AiError(
      'unsupported_capability',
      'Bedrock Converse does not expose an idempotency-key parameter.',
      { code: 'bedrock_idempotency_key_unsupported' },
    );
  }
}

function malformed(message: string, code: string): AiError {
  return new AiError('malformed_response', message, { code });
}

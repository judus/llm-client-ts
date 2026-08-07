import {
  AiError,
  type ContentPart,
  type FinishReason,
  type JsonObject,
  type ModelRequest,
  type ModelResponse,
  type ToolCallPart,
  type Usage,
} from '@maduser/ai-ts';
import type {
  Response,
  ResponseFunctionToolCall,
  ResponseUsage,
} from 'openai/resources/responses/responses';

export interface OpenAIResponseMappingContext {
  readonly messageId: string;
  readonly responseId: string;
}

export function mapOpenAIResponse(
  response: Response,
  request: ModelRequest,
  context: OpenAIResponseMappingContext,
): ModelResponse {
  if (response.error !== null || response.status === 'failed') {
    throw openAIResponseError(response);
  }

  const content = response.output.flatMap(mapOutputItem);
  const parent = request.messages.at(-1);
  const conversationId = request.messages[0]?.conversationId;
  if (conversationId === undefined) {
    throw new AiError('malformed_response', 'Cannot map a response without a conversation.', {
      code: 'openai_conversation_missing',
    });
  }

  return {
    finishReason: mapFinishReason(response, content),
    id: context.responseId,
    message: {
      content,
      conversationId,
      createdAt: new Date(response.created_at * 1_000).toISOString(),
      id: context.messageId,
      ...(parent === undefined ? {} : { parentId: parent.id }),
      role: 'assistant',
    },
    model: {
      model: response.model,
      provider: 'openai',
    },
    providerMetadata: providerMetadata(response),
    usage: mapOpenAIUsage(response.usage),
  };
}

function mapOutputItem(item: Response['output'][number]): ContentPart[] {
  if (item.type === 'message') {
    return item.content.map((part): ContentPart =>
      part.type === 'output_text'
        ? { source: 'generated', text: part.text, type: 'text' }
        : { reason: part.refusal, type: 'refusal' },
    );
  }
  if (item.type === 'function_call') {
    return [mapOpenAIToolCall(item)];
  }
  return [];
}

export function mapOpenAIToolCall(item: ResponseFunctionToolCall): ToolCallPart {
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.arguments);
  } catch (cause) {
    throw new AiError('malformed_response', 'OpenAI returned invalid tool-call JSON.', {
      cause,
      code: 'openai_tool_arguments_invalid_json',
      details: { callId: item.call_id, tool: item.name },
    });
  }

  if (!isJsonObject(parsed)) {
    throw new AiError('malformed_response', 'OpenAI tool-call arguments must be a JSON object.', {
      code: 'openai_tool_arguments_not_object',
      details: { callId: item.call_id, tool: item.name },
    });
  }

  return {
    arguments: parsed,
    callId: item.call_id,
    name: item.name,
    type: 'tool_call',
  };
}

function mapFinishReason(response: Response, content: readonly ContentPart[]): FinishReason {
  if (response.status === 'cancelled') {
    return 'cancelled';
  }
  if (content.some((part) => part.type === 'refusal')) {
    return 'content_filter';
  }
  if (response.status === 'incomplete') {
    return response.incomplete_details?.reason === 'max_output_tokens'
      ? 'length'
      : response.incomplete_details?.reason === 'content_filter'
        ? 'content_filter'
        : 'unknown';
  }
  if (content.some((part) => part.type === 'tool_call')) {
    return 'tool_calls';
  }
  return response.status === 'completed' ? 'stop' : 'unknown';
}

function mapOpenAIUsage(usage: ResponseUsage | undefined): Usage {
  if (usage === undefined) {
    return {};
  }
  return {
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.output_tokens_details.reasoning_tokens,
  };
}

function providerMetadata(response: Response): JsonObject {
  return {
    providerResponseId: response.id,
    ...(response.service_tier === undefined || response.service_tier === null
      ? {}
      : { serviceTier: response.service_tier }),
    ...(response.status === undefined ? {} : { status: response.status }),
  };
}

function openAIResponseError(response: Response): AiError {
  return new AiError(
    'provider_unavailable',
    response.error?.message ?? 'OpenAI failed to generate a response.',
    {
      code: response.error?.code ?? 'openai_response_failed',
      details: { providerResponseId: response.id },
      retryable: true,
    },
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import {
  AiError,
  type ContentPart,
  type FinishReason,
  type JsonObject,
  type ModelRequest,
  type ModelResponse,
  type Usage,
} from '@maduser/ai-ts';

import type { BedrockConverseResponse, BedrockStopReason, BedrockTokenUsage } from './types.js';

export interface BedrockResponseMappingContext {
  readonly createdAt: string;
  readonly messageId: string;
  readonly responseId: string;
}

export function mapBedrockResponse(
  response: BedrockConverseResponse,
  request: ModelRequest,
  context: BedrockResponseMappingContext,
): ModelResponse {
  if (response.message.role !== 'assistant') {
    throw new AiError('malformed_response', 'Bedrock returned a non-assistant response message.', {
      code: 'bedrock_response_role_invalid',
      details: { role: response.message.role },
    });
  }
  const conversationId = request.messages[0]?.conversationId;
  if (conversationId === undefined) {
    throw new AiError(
      'malformed_response',
      'Cannot map a Bedrock response without a conversation.',
      {
        code: 'bedrock_conversation_missing',
      },
    );
  }
  const parent = request.messages.at(-1);
  const content = response.message.content.map(mapOutputBlock);

  return {
    finishReason: mapBedrockFinishReason(response.stopReason),
    id: context.responseId,
    message: {
      content,
      conversationId,
      createdAt: context.createdAt,
      id: context.messageId,
      ...(parent === undefined ? {} : { parentId: parent.id }),
      role: 'assistant',
    },
    model: { model: request.model.model, provider: 'bedrock' },
    providerMetadata: providerMetadata(response),
    usage: mapBedrockUsage(response.usage),
  };
}

export function mapBedrockUsage(usage: BedrockTokenUsage | undefined): Usage {
  if (usage === undefined) {
    return {};
  }
  return {
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cacheReadInputTokens }),
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheWriteInputTokens === undefined
      ? {}
      : { providerUnits: { cacheWriteInputTokens: usage.cacheWriteInputTokens } }),
  };
}

export function mapBedrockFinishReason(stopReason: BedrockStopReason): FinishReason {
  switch (stopReason) {
    case 'content_filtered':
    case 'guardrail_intervened':
      return 'content_filter';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'malformed_model_output':
    case 'malformed_tool_use':
      return 'error';
  }
}

function mapOutputBlock(block: BedrockConverseResponse['message']['content'][number]): ContentPart {
  if ('text' in block) {
    return { source: 'generated', text: block.text, type: 'text' };
  }
  if ('toolUse' in block) {
    return {
      arguments: block.toolUse.input,
      callId: block.toolUse.toolUseId,
      name: block.toolUse.name,
      type: 'tool_call',
    };
  }
  throw new AiError('malformed_response', 'Bedrock returned an unsupported output content block.', {
    code: 'bedrock_output_block_unsupported',
  });
}

function providerMetadata(response: BedrockConverseResponse): JsonObject {
  return {
    ...(response.additionalModelResponseFields === undefined
      ? {}
      : { additionalModelResponseFields: response.additionalModelResponseFields }),
    ...(response.latencyMs === undefined ? {} : { latencyMs: response.latencyMs }),
    stopReason: response.stopReason,
  };
}

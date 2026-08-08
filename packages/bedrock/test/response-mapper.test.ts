import { describe, expect, it } from 'vitest';

import {
  mapBedrockFinishReason,
  mapBedrockResponse,
  mapBedrockUsage,
} from '../src/response-mapper.js';
import { completedResponse, request } from './fixtures.js';

describe('Bedrock response mapping', () => {
  it('normalizes output, metadata, and cache usage', () => {
    expect(
      mapBedrockResponse(completedResponse, request, {
        createdAt: '2026-08-08T12:00:00.000Z',
        messageId: 'message-out',
        responseId: 'response-out',
      }),
    ).toEqual({
      finishReason: 'tool_calls',
      id: 'response-out',
      message: {
        content: [
          {
            arguments: { place: 'Berlin' },
            callId: 'call-1',
            name: 'get_weather',
            type: 'tool_call',
          },
          { source: 'generated', text: '{"summary":"Sunny"}', type: 'text' },
        ],
        conversationId: 'conversation-1',
        createdAt: '2026-08-08T12:00:00.000Z',
        id: 'message-out',
        parentId: 'message-1',
        role: 'assistant',
      },
      model: { model: 'anthropic.claude-sonnet', provider: 'bedrock' },
      providerMetadata: {
        additionalModelResponseFields: { trace: 'fixture' },
        latencyMs: 321,
        stopReason: 'tool_use',
      },
      usage: {
        cachedInputTokens: 5,
        inputTokens: 17,
        outputTokens: 11,
        providerUnits: { cacheWriteInputTokens: 2 },
      },
    });
  });

  it.each([
    ['content_filtered', 'content_filter'],
    ['guardrail_intervened', 'content_filter'],
    ['max_tokens', 'length'],
    ['model_context_window_exceeded', 'length'],
    ['tool_use', 'tool_calls'],
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['malformed_model_output', 'error'],
    ['malformed_tool_use', 'error'],
  ] as const)('maps %s to %s', (input, expected) => {
    expect(mapBedrockFinishReason(input)).toBe(expected);
  });

  it('preserves unknown usage as absent rather than zero', () => {
    expect(mapBedrockUsage(undefined)).toEqual({});
    expect(mapBedrockUsage({ totalTokens: 10 })).toEqual({});
  });

  it('rejects non-assistant and unsupported provider output', () => {
    expect(() =>
      mapBedrockResponse(
        { ...completedResponse, message: { content: [{ text: 'x' }], role: 'user' } },
        request,
        { createdAt: 'now', messageId: 'm', responseId: 'r' },
      ),
    ).toThrow(expect.objectContaining({ code: 'bedrock_response_role_invalid' }));
    expect(() =>
      mapBedrockResponse(
        {
          ...completedResponse,
          message: {
            content: [{ image: { format: 'png', source: { bytes: new Uint8Array([1]) } } }],
            role: 'assistant',
          },
        },
        request,
        { createdAt: 'now', messageId: 'm', responseId: 'r' },
      ),
    ).toThrow(expect.objectContaining({ code: 'bedrock_output_block_unsupported' }));
  });
});

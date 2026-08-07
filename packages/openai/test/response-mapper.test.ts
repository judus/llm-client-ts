import { describe, expect, it } from 'vitest';

import { AiError, type ModelRequest } from '@maduser/ai-ts';
import type { Response } from 'openai/resources/responses/responses';

import { mapOpenAIResponse, mapOpenAIToolCall } from '../src/response-mapper.js';
import { completedResponse, request } from './fixtures.js';

describe('OpenAI response mapping', () => {
  it('normalizes tool calls, text, usage, and provider identifiers', () => {
    expect(
      mapOpenAIResponse(completedResponse, request, {
        messageId: 'message-generated',
        responseId: 'response-generated',
      }),
    ).toMatchObject({
      finishReason: 'tool_calls',
      id: 'response-generated',
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
        id: 'message-generated',
        parentId: 'message-1',
      },
      providerMetadata: {
        providerResponseId: 'resp_openai_1',
        status: 'completed',
      },
      usage: {
        cachedInputTokens: 5,
        inputTokens: 17,
        outputTokens: 11,
        reasoningTokens: 3,
      },
    });
  });

  it('rejects malformed tool arguments', () => {
    expect(() => {
      mapOpenAIToolCall({
        arguments: 'not-json',
        call_id: 'call-1',
        name: 'get_weather',
        type: 'function_call',
      });
    }).toThrow(AiError);
  });

  it('rejects tool arguments that are valid JSON but not an object', () => {
    expect(() => {
      mapOpenAIToolCall({
        arguments: '[]',
        call_id: 'call-1',
        name: 'get_weather',
        type: 'function_call',
      });
    }).toThrow(expect.objectContaining({ code: 'openai_tool_arguments_not_object' }));
  });

  it('keeps refusals distinct from generated text', () => {
    const refusalResponse: Response = {
      ...completedResponse,
      output: [
        {
          content: [{ refusal: 'I cannot help with that.', type: 'refusal' }],
          id: 'message-refusal',
          role: 'assistant',
          status: 'completed',
          type: 'message',
        },
      ],
      output_text: '',
      service_tier: 'priority',
    };

    expect(map(refusalResponse)).toMatchObject({
      finishReason: 'content_filter',
      message: {
        content: [{ reason: 'I cannot help with that.', type: 'refusal' }],
      },
      providerMetadata: { serviceTier: 'priority' },
    });
  });

  it.each([
    ['max_output_tokens', 'length'],
    ['content_filter', 'content_filter'],
    [undefined, 'unknown'],
  ] as const)('maps incomplete reason %s', (reason, finishReason) => {
    const incomplete: Response = {
      ...completedResponse,
      incomplete_details: reason === undefined ? null : { reason },
      output: [],
      status: 'incomplete',
    };

    expect(map(incomplete).finishReason).toBe(finishReason);
  });

  it('maps cancelled and unclassified statuses without inventing usage', () => {
    const { usage, ...withoutUsage } = completedResponse;
    void usage;
    const cancelled: Response = {
      ...withoutUsage,
      output: [],
      status: 'cancelled',
    };

    expect(map(cancelled)).toMatchObject({ finishReason: 'cancelled', usage: {} });
    expect(map({ ...cancelled, status: 'queued' }).finishReason).toBe('unknown');
  });

  it('rejects failed responses and missing conversation context', () => {
    expect(() => map({ ...completedResponse, status: 'failed' })).toThrow(
      expect.objectContaining({ code: 'openai_response_failed' }),
    );

    const emptyRequest: ModelRequest = { ...request, messages: [] };
    expect(() =>
      mapOpenAIResponse({ ...completedResponse, output: [] }, emptyRequest, {
        messageId: 'message-generated',
        responseId: 'response-generated',
      }),
    ).toThrow(expect.objectContaining({ code: 'openai_conversation_missing' }));
  });
});

function map(response: Response): ReturnType<typeof mapOpenAIResponse> {
  return mapOpenAIResponse(response, request, {
    messageId: 'message-generated',
    responseId: 'response-generated',
  });
}

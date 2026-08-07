import { describe, expect, it } from 'vitest';

import { AiError, type ModelRequest } from '@maduser/ai-ts';

import { mapOpenAIRequest, mapOpenAIStreamRequest } from '../src/request-mapper.js';
import { request } from './fixtures.js';

describe('OpenAI request mapping', () => {
  it('maps portable text, tools, and strict structured output to Responses', () => {
    expect(mapOpenAIRequest(request, false)).toEqual({
      input: [
        {
          content: 'What is the weather?',
          role: 'user',
          type: 'message',
        },
      ],
      max_output_tokens: 512,
      model: 'gpt-5.4',
      store: false,
      stream: false,
      text: {
        format: {
          name: 'weather_answer',
          schema:
            request.responseFormat?.type === 'json_schema' ? request.responseFormat.schema : {},
          strict: true,
          type: 'json_schema',
        },
      },
      tool_choice: 'auto',
      tools: [
        {
          description: 'Get the weather for a place.',
          name: 'get_weather',
          parameters: request.tools?.[0]?.inputSchema,
          strict: true,
          type: 'function',
        },
      ],
    });
  });

  it('changes only the stream discriminator for streaming calls', () => {
    expect(mapOpenAIStreamRequest(request, false)).toEqual({
      ...mapOpenAIRequest(request, false),
      stream: true,
    });
  });

  it('maps prior tool calls and structured tool results as distinct input items', () => {
    const withTools: ModelRequest = {
      messages: [
        ...request.messages,
        {
          content: [
            { reason: 'Cannot provide that.', type: 'refusal' },
            {
              arguments: { place: 'Berlin' },
              callId: 'call-1',
              name: 'get_weather',
              type: 'tool_call',
            },
          ],
          conversationId: 'conversation-1',
          createdAt: '2026-08-07T10:00:01.000Z',
          id: 'message-2',
          role: 'assistant',
        },
        {
          content: [
            {
              callId: 'call-1',
              content: [],
              status: 'success',
              structuredContent: { temperature: 25 },
              type: 'tool_result',
            },
          ],
          conversationId: 'conversation-1',
          createdAt: '2026-08-07T10:00:02.000Z',
          id: 'message-3',
          role: 'tool',
        },
      ],
      model: request.model,
    };

    expect(mapOpenAIRequest(withTools, true).input).toEqual([
      { content: 'What is the weather?', role: 'user', type: 'message' },
      { content: 'Cannot provide that.', role: 'assistant', type: 'message' },
      {
        arguments: '{"place":"Berlin"}',
        call_id: 'call-1',
        name: 'get_weather',
        type: 'function_call',
      },
      {
        call_id: 'call-1',
        output: '{"temperature":25}',
        type: 'function_call_output',
      },
    ]);
    expect(mapOpenAIRequest(withTools, true).store).toBe(true);
  });

  it('serializes failed text tool results safely', () => {
    const toolRequest: ModelRequest = {
      messages: [
        {
          content: [
            {
              callId: 'call-1',
              content: [{ text: 'partial result', type: 'text' }],
              error: { code: 'failed', message: 'No result.', retryable: false },
              status: 'error',
              type: 'tool_result',
            },
          ],
          conversationId: 'conversation-1',
          createdAt: '2026-08-07T10:00:02.000Z',
          id: 'message-3',
          role: 'tool',
        },
      ],
      model: request.model,
    };

    expect(mapOpenAIRequest(toolRequest, false).input).toEqual([
      {
        call_id: 'call-1',
        output:
          '{"error":{"code":"failed","message":"No result.","retryable":false},"text":"partial result"}',
        type: 'function_call_output',
      },
    ]);
  });

  it.each([
    [{ type: 'none' } as const, 'none'],
    [{ type: 'required' } as const, 'required'],
    [
      { name: 'get_weather', type: 'required_tool' } as const,
      {
        name: 'get_weather',
        type: 'function',
      },
    ],
  ])('maps tool choice %j', (toolChoice, expected) => {
    expect(mapOpenAIRequest({ ...request, toolChoice }, false).tool_choice).toEqual(expected);
  });

  it('maps JSON mode, sampling, and output schemas', () => {
    const mapped = mapOpenAIRequest(
      {
        ...request,
        responseFormat: { type: 'json' },
        sampling: { temperature: 0.2, topP: 0.8 },
        tools: [{ ...request.tools![0]!, outputSchema: { type: 'object' } }],
      },
      false,
    );

    expect(mapped).toMatchObject({
      temperature: 0.2,
      text: { format: { type: 'json_object' } },
      top_p: 0.8,
      tools: [{ output_schema: { type: 'object' } }],
    });
  });

  it('rejects binary content until its dedicated mapper is enabled', () => {
    const imageRequest: ModelRequest = {
      messages: [
        {
          ...request.messages[0]!,
          content: [
            {
              mimeType: 'image/png',
              source: { type: 'url', url: 'https://example.test/image.png' },
              type: 'image',
            },
          ],
        },
      ],
      model: request.model,
    };

    expect(() => mapOpenAIRequest(imageRequest, false)).toThrow(AiError);
  });
});

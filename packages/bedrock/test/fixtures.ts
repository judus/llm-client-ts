import type { ModelRequest } from '@maduser/ai-ts';

import type { BedrockConverseResponse, BedrockStreamEvent } from '../src/types.js';

export const request: ModelRequest = {
  limits: { maxOutputTokens: 512 },
  messages: [
    {
      content: [{ source: 'typed', text: 'What is the weather?', type: 'text' }],
      conversationId: 'conversation-1',
      createdAt: '2026-08-08T10:00:00.000Z',
      id: 'message-1',
      role: 'user',
    },
  ],
  model: { model: 'anthropic.claude-sonnet', provider: 'bedrock' },
  responseFormat: {
    name: 'weather_answer',
    schema: {
      additionalProperties: false,
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      type: 'object',
    },
    strict: true,
    type: 'json_schema',
  },
  toolChoice: { type: 'auto' },
  tools: [
    {
      description: 'Get the weather for a place.',
      inputSchema: {
        additionalProperties: false,
        properties: { place: { type: 'string' } },
        required: ['place'],
        type: 'object',
      },
      name: 'get_weather',
    },
  ],
};

export const completedResponse: BedrockConverseResponse = {
  additionalModelResponseFields: { trace: 'fixture' },
  latencyMs: 321,
  message: {
    content: [
      {
        toolUse: {
          input: { place: 'Berlin' },
          name: 'get_weather',
          toolUseId: 'call-1',
        },
      },
      { text: '{"summary":"Sunny"}' },
    ],
    role: 'assistant',
  },
  stopReason: 'tool_use',
  usage: {
    cacheReadInputTokens: 5,
    cacheWriteInputTokens: 2,
    inputTokens: 17,
    outputTokens: 11,
    totalTokens: 28,
  },
};

const completedUsage = completedResponse.usage ?? {};

export const streamEvents: readonly BedrockStreamEvent[] = [
  { contentBlockIndex: 0, text: 'Sunny', type: 'text_delta' },
  { contentBlockIndex: 0, type: 'content_stop' },
  {
    contentBlockIndex: 1,
    name: 'get_weather',
    toolUseId: 'call-1',
    type: 'tool_start',
  },
  { contentBlockIndex: 1, input: '{"place":', type: 'tool_delta' },
  { contentBlockIndex: 1, input: '"Berlin"}', type: 'tool_delta' },
  { contentBlockIndex: 1, type: 'content_stop' },
  { type: 'metadata', usage: completedUsage },
  { stopReason: 'tool_use', type: 'message_stop' },
];

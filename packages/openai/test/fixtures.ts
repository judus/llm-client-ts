import type { ModelRequest } from '@maduser/ai-ts';
import type {
  Response,
  ResponseCompletedEvent,
  ResponseFunctionToolCall,
  ResponseOutputItemDoneEvent,
  ResponseStreamEvent,
  ResponseTextDeltaEvent,
} from 'openai/resources/responses/responses';

export const request: ModelRequest = {
  limits: { maxOutputTokens: 512 },
  messages: [
    {
      content: [{ source: 'typed', text: 'What is the weather?', type: 'text' }],
      conversationId: 'conversation-1',
      createdAt: '2026-08-07T10:00:00.000Z',
      id: 'message-1',
      role: 'user',
    },
  ],
  model: { model: 'gpt-5.4', provider: 'openai' },
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

const functionCall: ResponseFunctionToolCall = {
  arguments: '{"place":"Berlin"}',
  call_id: 'call-1',
  id: 'fc-1',
  name: 'get_weather',
  status: 'completed',
  type: 'function_call',
};

export const completedResponse: Response = {
  created_at: 1_786_099_200,
  error: null,
  id: 'resp_openai_1',
  incomplete_details: null,
  instructions: null,
  metadata: null,
  model: 'gpt-5.4',
  object: 'response',
  output: [
    functionCall,
    {
      content: [{ annotations: [], text: '{"summary":"Sunny"}', type: 'output_text' }],
      id: 'msg-openai-1',
      role: 'assistant',
      status: 'completed',
      type: 'message',
    },
  ],
  output_text: '{"summary":"Sunny"}',
  parallel_tool_calls: true,
  status: 'completed',
  temperature: null,
  tool_choice: 'auto',
  tools: [],
  top_p: null,
  usage: {
    input_tokens: 17,
    input_tokens_details: { cache_write_tokens: 0, cached_tokens: 5 },
    output_tokens: 11,
    output_tokens_details: { reasoning_tokens: 3 },
    total_tokens: 28,
  },
};

export const streamEvents: readonly ResponseStreamEvent[] = [
  {
    response: completedResponse,
    sequence_number: 0,
    type: 'response.created',
  },
  {
    content_index: 0,
    delta: 'Sunny',
    item_id: 'msg-openai-1',
    logprobs: [],
    output_index: 0,
    sequence_number: 1,
    type: 'response.output_text.delta',
  } satisfies ResponseTextDeltaEvent,
  {
    item: functionCall,
    output_index: 1,
    sequence_number: 2,
    type: 'response.output_item.done',
  } satisfies ResponseOutputItemDoneEvent,
  {
    response: completedResponse,
    sequence_number: 3,
    type: 'response.completed',
  } satisfies ResponseCompletedEvent,
];

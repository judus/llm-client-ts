import { AiError, type ContentPart, type ModelRequest, type ToolDefinition } from '@maduser/ai-ts';
import type {
  ResponseCreateParamsBase,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseInputItem,
  ResponseTextConfig,
  Tool,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses';

export function mapOpenAIRequest(
  request: ModelRequest,
  store: boolean,
): ResponseCreateParamsNonStreaming {
  return {
    ...mapBaseRequest(request, store),
    stream: false,
  };
}

export function mapOpenAIStreamRequest(
  request: ModelRequest,
  store: boolean,
): ResponseCreateParamsStreaming {
  return {
    ...mapBaseRequest(request, store),
    stream: true,
  };
}

function mapBaseRequest(request: ModelRequest, store: boolean): ResponseCreateParamsBase {
  return {
    input: request.messages.flatMap(mapMessage),
    model: request.model.model,
    store,
    ...(request.limits?.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: request.limits.maxOutputTokens }),
    ...(request.responseFormat === undefined ? {} : { text: mapResponseFormat(request) }),
    ...(request.sampling?.temperature === undefined
      ? {}
      : { temperature: request.sampling.temperature }),
    ...(request.sampling?.topP === undefined ? {} : { top_p: request.sampling.topP }),
    ...(request.toolChoice === undefined ? {} : { tool_choice: mapToolChoice(request) }),
    ...(request.tools === undefined ? {} : { tools: request.tools.map(mapTool) }),
  };
}

function mapMessage(message: ModelRequest['messages'][number]): ResponseInputItem[] {
  const result: ResponseInputItem[] = [];
  const text = message.content.flatMap((part) =>
    part.type === 'text' ? [part.text] : part.type === 'refusal' ? [part.reason] : [],
  );

  if (text.length > 0 && message.role !== 'tool') {
    result.push({
      content: text.join('\n'),
      role: message.role,
      type: 'message',
    });
  }

  for (const part of message.content) {
    const item = mapNonTextPart(part);
    if (item !== undefined) {
      result.push(item);
    }
  }

  return result;
}

function mapNonTextPart(part: ContentPart): ResponseInputItem | undefined {
  switch (part.type) {
    case 'text':
    case 'refusal':
      return undefined;
    case 'tool_call':
      return {
        arguments: JSON.stringify(part.arguments),
        call_id: part.callId,
        name: part.name,
        type: 'function_call',
      };
    case 'tool_result':
      return {
        call_id: part.callId,
        output: serializeToolResult(part),
        type: 'function_call_output',
      };
    case 'audio':
    case 'document':
    case 'image':
      throw new AiError('unsupported_capability', `OpenAI ${part.type} mapping is not enabled.`, {
        code: `openai_${part.type}_mapping_unavailable`,
      });
  }
}

function serializeToolResult(part: Extract<ContentPart, { readonly type: 'tool_result' }>): string {
  if (part.structuredContent !== undefined) {
    return JSON.stringify(part.structuredContent);
  }

  const text = part.content.flatMap((item) => (item.type === 'text' ? [item.text] : []));
  if (part.error !== undefined) {
    return JSON.stringify({ error: part.error, text: text.join('\n') });
  }
  return text.join('\n');
}

function mapTool(tool: ToolDefinition): Tool {
  return {
    description: tool.description,
    name: tool.name,
    ...(tool.outputSchema === undefined ? {} : { output_schema: tool.outputSchema }),
    parameters: tool.inputSchema,
    strict: true,
    type: 'function',
  };
}

function mapToolChoice(request: ModelRequest): ToolChoiceFunction | ToolChoiceOptions {
  const choice = request.toolChoice;
  if (choice === undefined) {
    return 'auto';
  }
  switch (choice.type) {
    case 'auto':
    case 'none':
    case 'required':
      return choice.type;
    case 'required_tool':
      return { name: choice.name, type: 'function' };
  }
}

function mapResponseFormat(request: ModelRequest): ResponseTextConfig {
  const format = request.responseFormat;
  if (format === undefined || format.type === 'text') {
    return { format: { type: 'text' } };
  }
  if (format.type === 'json') {
    return { format: { type: 'json_object' } };
  }
  return {
    format: {
      name: format.name,
      schema: format.schema,
      ...(format.strict === undefined ? {} : { strict: format.strict }),
      type: 'json_schema',
    },
  };
}

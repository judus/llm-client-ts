import { Buffer } from 'node:buffer';

import {
  AiError,
  type ContentPart,
  type DocumentPart,
  type ImagePart,
  type HostedTool,
  type ModelRequest,
  type ToolDefinition,
} from '../../index.js';
import type {
  ResponseCreateParamsBase,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItem,
  ResponseFunctionCallOutputItemList,
  ResponseInputContent,
  ResponseInputItem,
  ResponseTextConfig,
  Tool,
  ToolChoiceFunction,
  ToolChoiceOptions,
} from 'openai/resources/responses/responses';

const DEFAULT_MAX_INLINE_DOCUMENT_BYTES = 50_000_000;
const DEFAULT_MAX_INLINE_IMAGE_PAYLOAD_BYTES = 512_000_000;
const DEFAULT_MAX_IMAGE_COUNT = 1_500;

export interface OpenAIRequestMappingLimits {
  readonly maxImageCount?: number;
  readonly maxInlineDocumentBytes?: number;
  readonly maxInlineImagePayloadBytes?: number;
}

export function mapOpenAIRequest(
  request: ModelRequest,
  store: boolean,
  limits: OpenAIRequestMappingLimits = {},
): ResponseCreateParamsNonStreaming {
  return {
    ...mapBaseRequest(request, store, limits),
    stream: false,
  };
}

export function mapOpenAIStreamRequest(
  request: ModelRequest,
  store: boolean,
  limits: OpenAIRequestMappingLimits = {},
): ResponseCreateParamsStreaming {
  return {
    ...mapBaseRequest(request, store, limits),
    stream: true,
  };
}

function mapBaseRequest(
  request: ModelRequest,
  store: boolean,
  limits: OpenAIRequestMappingLimits,
): ResponseCreateParamsBase {
  const state = createMappingState(limits);
  return {
    input: request.messages.flatMap((message) => mapMessage(message, state)),
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
    ...(request.tools === undefined && request.hostedTools === undefined
      ? {}
      : {
          tools: [
            ...(request.tools ?? []).map(mapTool),
            ...(request.hostedTools ?? []).map(mapHostedTool),
          ],
        }),
  };
}

function mapMessage(
  message: ModelRequest['messages'][number],
  state: MappingState,
): ResponseInputItem[] {
  const result: ResponseInputItem[] = [];
  const content: ResponseInputContent[] = [];
  let hasBinaryContent = false;

  for (const part of message.content) {
    if (part.type === 'text' || part.type === 'refusal') {
      content.push({
        text: part.type === 'text' ? part.text : part.reason,
        type: 'input_text',
      });
    } else if (part.type === 'document') {
      content.push(mapDocument(part, state));
      hasBinaryContent = true;
    } else if (part.type === 'image') {
      content.push(mapImage(part, state));
      hasBinaryContent = true;
    } else {
      const item = mapStandalonePart(part, state);
      if (item !== undefined) {
        result.push(item);
      }
    }
  }

  if (content.length > 0) {
    if (message.role === 'tool') {
      throw new AiError('invalid_request', 'OpenAI tool messages require tool-result content.', {
        code: 'invalid_openai_tool_message_content',
      });
    }
    result.unshift({
      content: hasBinaryContent
        ? content
        : content.map((part) => ('text' in part ? part.text : '')).join('\n'),
      role: message.role,
      type: 'message',
    });
  }

  return result;
}

function mapStandalonePart(part: ContentPart, state: MappingState): ResponseInputItem | undefined {
  switch (part.type) {
    case 'text':
    case 'refusal':
    case 'document':
    case 'image':
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
        output: mapToolResult(part, state),
        type: 'function_call_output',
      };
    case 'audio':
      throw new AiError('unsupported_capability', `OpenAI ${part.type} mapping is not enabled.`, {
        code: `openai_${part.type}_mapping_unavailable`,
      });
  }
}

function mapDocument(part: DocumentPart, state: MappingState): ResponseInputContent {
  validateMimeType(part.mimeType, 'document');
  switch (part.source.type) {
    case 'provider_file':
      return {
        file_id: validateProviderFile(part.source.provider, part.source.fileId),
        ...(part.filename === undefined ? {} : { filename: validateFilename(part.filename) }),
        type: 'input_file',
      };
    case 'url':
      return {
        file_url: validateExternalUrl(part.source.url, 'document'),
        ...(part.filename === undefined ? {} : { filename: validateFilename(part.filename) }),
        type: 'input_file',
      };
    case 'bytes': {
      const filename = requireFilename(part.filename);
      const bytes = validateBytes(part.source.bytes, 'document');
      state.inlineDocumentBytes += bytes.byteLength;
      if (
        bytes.byteLength >= state.maxInlineDocumentBytes ||
        state.inlineDocumentBytes >= state.maxInlineDocumentBytes
      ) {
        throw new AiError(
          'invalid_request',
          'OpenAI inline documents must remain below the request byte limit.',
          {
            code: 'openai_inline_document_limit_exceeded',
            details: {
              byteLength: bytes.byteLength,
              combinedByteLength: state.inlineDocumentBytes,
              maxBytes: state.maxInlineDocumentBytes,
            },
          },
        );
      }
      return {
        file_data: dataUrl(part.mimeType, bytes),
        filename,
        type: 'input_file',
      };
    }
  }
}

function mapImage(part: ImagePart, state: MappingState): ResponseInputContent {
  const mimeType = validateImageMimeType(part.mimeType);
  state.imageCount += 1;
  if (state.imageCount > state.maxImageCount) {
    throw new AiError('invalid_request', 'OpenAI image count exceeds the request limit.', {
      code: 'openai_image_count_exceeded',
      details: { imageCount: state.imageCount, maxImageCount: state.maxImageCount },
    });
  }
  const detail = part.detail ?? 'auto';
  switch (part.source.type) {
    case 'provider_file':
      return {
        detail,
        file_id: validateProviderFile(part.source.provider, part.source.fileId),
        type: 'input_image',
      };
    case 'url':
      return {
        detail,
        image_url: validateExternalUrl(part.source.url, 'image'),
        type: 'input_image',
      };
    case 'bytes': {
      const bytes = validateBytes(part.source.bytes, 'image');
      const url = dataUrl(mimeType, bytes);
      state.inlineImagePayloadBytes += Buffer.byteLength(url);
      if (state.inlineImagePayloadBytes > state.maxInlineImagePayloadBytes) {
        throw new AiError('invalid_request', 'OpenAI inline images exceed the payload limit.', {
          code: 'openai_inline_image_payload_limit_exceeded',
          details: {
            maxBytes: state.maxInlineImagePayloadBytes,
            payloadBytes: state.inlineImagePayloadBytes,
          },
        });
      }
      return { detail, image_url: url, type: 'input_image' };
    }
  }
}

function mapToolResult(
  part: Extract<ContentPart, { readonly type: 'tool_result' }>,
  state: MappingState,
): string | ResponseFunctionCallOutputItemList {
  const hasBinaryContent = part.content.some((item) => item.type !== 'text');
  if (!hasBinaryContent) {
    if (part.structuredContent !== undefined) {
      return JSON.stringify(part.structuredContent);
    }
    const text = part.content
      .flatMap((item) => (item.type === 'text' ? [item.text] : []))
      .join('\n');
    return part.error === undefined ? text : JSON.stringify({ error: part.error, text });
  }

  const output: ResponseFunctionCallOutputItemList = [];
  if (part.structuredContent !== undefined) {
    output.push({ text: JSON.stringify(part.structuredContent), type: 'input_text' });
  }
  if (part.error !== undefined) {
    output.push({ text: JSON.stringify({ error: part.error }), type: 'input_text' });
  }
  for (const item of part.content) {
    output.push(mapToolResultContent(item, state));
  }
  return output;
}

function mapToolResultContent(
  part: Extract<ContentPart, { readonly type: 'tool_result' }>['content'][number],
  state: MappingState,
): ResponseFunctionCallOutputItem {
  switch (part.type) {
    case 'text':
      return { text: part.text, type: 'input_text' };
    case 'document':
      return mapDocument(part, state);
    case 'image':
      return mapImage(part, state);
    case 'audio':
      throw new AiError('unsupported_capability', 'OpenAI audio mapping is not enabled.', {
        code: 'openai_audio_mapping_unavailable',
      });
  }
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

function mapHostedTool(tool: HostedTool): Tool {
  if (tool.provider !== 'openai' || tool.type !== 'web_search') {
    throw new AiError(
      'unsupported_capability',
      `OpenAI does not support hosted tool ${tool.provider}.${tool.type}.`,
      {
        code: 'openai_hosted_tool_unsupported',
      },
    );
  }

  const configuration = tool.configuration ?? {};
  const allowedDomains = configuration['allowedDomains'];
  const searchContextSize = configuration['searchContextSize'];
  if (allowedDomains !== undefined && !isStringArray(allowedDomains)) {
    throw new AiError(
      'invalid_request',
      'OpenAI web search allowedDomains must be an array of strings.',
      {
        code: 'openai_web_search_domains_invalid',
      },
    );
  }
  if (
    searchContextSize !== undefined &&
    searchContextSize !== 'low' &&
    searchContextSize !== 'medium' &&
    searchContextSize !== 'high'
  ) {
    throw new AiError('invalid_request', 'OpenAI web search searchContextSize is invalid.', {
      code: 'openai_web_search_context_size_invalid',
    });
  }

  return {
    ...(allowedDomains === undefined ? {} : { filters: { allowed_domains: allowedDomains } }),
    ...(searchContextSize === undefined ? {} : { search_context_size: searchContextSize }),
    type: 'web_search',
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
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

interface MappingState {
  imageCount: number;
  inlineDocumentBytes: number;
  inlineImagePayloadBytes: number;
  readonly maxImageCount: number;
  readonly maxInlineDocumentBytes: number;
  readonly maxInlineImagePayloadBytes: number;
}

function createMappingState(limits: OpenAIRequestMappingLimits): MappingState {
  return {
    imageCount: 0,
    inlineDocumentBytes: 0,
    inlineImagePayloadBytes: 0,
    maxImageCount: positiveLimit(limits.maxImageCount ?? DEFAULT_MAX_IMAGE_COUNT, 'maxImageCount'),
    maxInlineDocumentBytes: positiveLimit(
      limits.maxInlineDocumentBytes ?? DEFAULT_MAX_INLINE_DOCUMENT_BYTES,
      'maxInlineDocumentBytes',
    ),
    maxInlineImagePayloadBytes: positiveLimit(
      limits.maxInlineImagePayloadBytes ?? DEFAULT_MAX_INLINE_IMAGE_PAYLOAD_BYTES,
      'maxInlineImagePayloadBytes',
    ),
  };
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AiError('invalid_request', `OpenAI mapping limit ${name} must be positive.`, {
      code: 'invalid_openai_mapping_limit',
      details: { name, value },
    });
  }
  return value;
}

function validateBytes(value: Uint8Array, kind: 'document' | 'image'): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new AiError('invalid_request', `OpenAI ${kind} bytes must not be empty.`, {
      code: `invalid_openai_${kind}_bytes`,
    });
  }
  return value;
}

function validateMimeType(value: string, kind: 'document' | 'image'): string {
  const normalized = value.toLowerCase();
  if (normalized.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)) {
    throw new AiError('invalid_request', `OpenAI ${kind} MIME type is invalid.`, {
      code: `invalid_openai_${kind}_mime_type`,
      details: { mimeType: value },
    });
  }
  return normalized;
}

function validateImageMimeType(value: string): string {
  const normalized = validateMimeType(value, 'image');
  if (
    normalized !== 'image/gif' &&
    normalized !== 'image/jpeg' &&
    normalized !== 'image/png' &&
    normalized !== 'image/webp'
  ) {
    throw new AiError('invalid_request', `Unsupported OpenAI image MIME type: ${value}.`, {
      code: 'unsupported_openai_image_mime_type',
      details: { mimeType: value },
    });
  }
  return normalized;
}

function requireFilename(value: string | undefined): string {
  if (value === undefined) {
    throw new AiError('invalid_request', 'OpenAI inline documents require a filename.', {
      code: 'openai_inline_document_filename_required',
    });
  }
  return validateFilename(value);
}

function validateFilename(value: string): string {
  const byteLength = new TextEncoder().encode(value).byteLength;
  if (
    value === '.' ||
    value === '..' ||
    value.trim().length === 0 ||
    byteLength > 255 ||
    hasUnsafeFilenameCharacter(value)
  ) {
    throw new AiError('invalid_request', 'OpenAI document filename is invalid.', {
      code: 'invalid_openai_document_filename',
      details: { filename: value },
    });
  }
  return value;
}

function hasUnsafeFilenameCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127 || codeUnit === 47 || codeUnit === 92) {
      return true;
    }
  }
  return false;
}

function validateProviderFile(provider: string, fileId: string): string {
  if (provider !== 'openai') {
    throw new AiError('invalid_request', 'Provider file does not belong to OpenAI.', {
      code: 'openai_provider_file_mismatch',
      details: { provider },
    });
  }
  if (fileId.trim().length === 0 || fileId.length > 256) {
    throw new AiError('invalid_request', 'OpenAI provider file ID is invalid.', {
      code: 'invalid_openai_provider_file_id',
    });
  }
  return fileId;
}

function validateExternalUrl(value: string, kind: 'document' | 'image'): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new AiError('invalid_request', `OpenAI ${kind} URL is invalid.`, {
      cause,
      code: `invalid_openai_${kind}_url`,
    });
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    value.length > 8_192
  ) {
    throw new AiError('invalid_request', `OpenAI ${kind} URL is not allowed.`, {
      code: `invalid_openai_${kind}_url`,
    });
  }
  return value;
}

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType.toLowerCase()};base64,${Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString('base64')}`;
}

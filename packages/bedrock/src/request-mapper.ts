import {
  AiError,
  type ContentPart,
  type DocumentPart,
  type ImagePart,
  type ModelRequest,
  type ToolResultPart,
} from '@maduser/ai-ts';

import type {
  BedrockContentBlock,
  BedrockConverseRequest,
  BedrockDocumentBlock,
  BedrockDocumentFormat,
  BedrockImageBlock,
  BedrockImageFormat,
  BedrockToolConfiguration,
  BedrockToolResultContent,
} from './types.js';

const DEFAULT_MAX_DOCUMENT_BYTES = 4_500_000;
const DEFAULT_MAX_DOCUMENT_COUNT = 5;
const DEFAULT_MAX_IMAGE_BYTES = 3_750_000;
const DEFAULT_MAX_IMAGE_COUNT = 20;

const documentFormats: Readonly<Record<string, BedrockDocumentFormat>> = {
  'application/csv': 'csv',
  'application/msword': 'doc',
  'application/pdf': 'pdf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/plain': 'txt',
};

const imageFormats: Readonly<Record<string, BedrockImageFormat>> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface BedrockRequestMappingLimits {
  readonly maxDocumentBytes?: number;
  readonly maxDocumentCount?: number;
  readonly maxImageBytes?: number;
  readonly maxImageCount?: number;
}

interface MappingState {
  documentCount: number;
  imageCount: number;
  readonly maxDocumentBytes: number;
  readonly maxDocumentCount: number;
  readonly maxImageBytes: number;
  readonly maxImageCount: number;
}

export function mapBedrockRequest(
  request: ModelRequest,
  limits: BedrockRequestMappingLimits = {},
): BedrockConverseRequest {
  if (request.model.provider !== 'bedrock') {
    throw new AiError('invalid_request', 'A Bedrock request must select the bedrock provider.', {
      code: 'bedrock_provider_mismatch',
      details: { provider: request.model.provider },
    });
  }
  if (request.sampling?.seed !== undefined) {
    throw new AiError(
      'unsupported_capability',
      'Bedrock Converse does not support sampling seeds.',
      {
        code: 'bedrock_sampling_seed_unsupported',
      },
    );
  }

  const state = mappingState(limits);
  const messages: BedrockConverseRequest['messages'][number][] = [];
  const system: { text: string }[] = [];

  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      for (const part of message.content) {
        if (part.type !== 'text' && part.type !== 'refusal') {
          throw new AiError('invalid_request', 'Bedrock system messages must contain only text.', {
            code: 'invalid_bedrock_system_content',
            details: { contentType: part.type },
          });
        }
        system.push({ text: part.type === 'text' ? part.text : part.reason });
      }
      continue;
    }

    const content = message.content.map((part) => mapContentPart(part, message.role, state));
    if (content.length === 0) {
      throw new AiError('invalid_request', 'Bedrock messages cannot have empty content.', {
        code: 'empty_bedrock_message',
        details: { messageId: message.id },
      });
    }
    if (content.some((block) => 'document' in block) && !hasNonEmptyText(content)) {
      throw new AiError(
        'invalid_request',
        'A Bedrock message containing a document must also contain non-empty text.',
        {
          code: 'bedrock_document_text_required',
          details: { messageId: message.id },
        },
      );
    }
    messages.push({ content, role: message.role === 'assistant' ? 'assistant' : 'user' });
  }

  return {
    messages,
    modelId: request.model.model,
    ...(request.limits?.maxOutputTokens === undefined &&
    request.sampling?.temperature === undefined &&
    request.sampling?.topP === undefined
      ? {}
      : {
          inferenceConfig: {
            ...(request.limits?.maxOutputTokens === undefined
              ? {}
              : { maxTokens: request.limits.maxOutputTokens }),
            ...(request.sampling?.temperature === undefined
              ? {}
              : { temperature: request.sampling.temperature }),
            ...(request.sampling?.topP === undefined ? {} : { topP: request.sampling.topP }),
          },
        }),
    ...(request.responseFormat === undefined || request.responseFormat.type === 'text'
      ? {}
      : { outputConfig: mapResponseFormat(request.responseFormat) }),
    ...(system.length === 0 ? {} : { system }),
    ...mapToolConfig(request),
  };
}

function mapContentPart(
  part: ContentPart,
  role: ModelRequest['messages'][number]['role'],
  state: MappingState,
): BedrockContentBlock {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'refusal':
      return { text: part.reason };
    case 'image':
      requireUserRole(role, 'image');
      return { image: mapImage(part, state) };
    case 'document':
      requireUserRole(role, 'document');
      return { document: mapDocument(part, state) };
    case 'tool_call':
      if (role !== 'assistant') {
        throw invalidRole('tool_call', role);
      }
      return {
        toolUse: { input: part.arguments, name: part.name, toolUseId: part.callId },
      };
    case 'tool_result':
      if (role !== 'tool') {
        throw invalidRole('tool_result', role);
      }
      return mapToolResult(part, state);
    case 'audio':
      throw new AiError('unsupported_capability', 'Bedrock audio input is not enabled.', {
        code: 'bedrock_audio_mapping_unavailable',
      });
  }
}

function mapImage(part: ImagePart, state: MappingState): BedrockImageBlock {
  state.imageCount += 1;
  if (state.imageCount > state.maxImageCount) {
    throw limitError('image', state.imageCount, state.maxImageCount);
  }
  const format = imageFormats[part.mimeType.toLowerCase()];
  if (format === undefined) {
    throw unsupportedMimeType('image', part.mimeType);
  }
  const bytes = inlineBytes(part.source, 'image');
  validateByteLength(bytes, 'image', state.maxImageBytes);
  return { format, source: { bytes } };
}

function mapDocument(part: DocumentPart, state: MappingState): BedrockDocumentBlock {
  state.documentCount += 1;
  if (state.documentCount > state.maxDocumentCount) {
    throw limitError('document', state.documentCount, state.maxDocumentCount);
  }
  const format = documentFormats[part.mimeType.toLowerCase()];
  if (format === undefined) {
    throw unsupportedMimeType('document', part.mimeType);
  }
  const bytes = inlineBytes(part.source, 'document');
  validateByteLength(bytes, 'document', state.maxDocumentBytes);
  return {
    format,
    name: documentName(part.filename),
    source: { bytes },
  };
}

function mapToolResult(part: ToolResultPart, state: MappingState): BedrockContentBlock {
  const content: BedrockToolResultContent[] = [];
  if (part.structuredContent !== undefined) {
    content.push({ json: part.structuredContent });
  }
  if (part.error !== undefined) {
    content.push({
      json: {
        error: {
          code: part.error.code,
          message: part.error.message,
          retryable: part.error.retryable,
        },
      },
    });
  }
  for (const item of part.content) {
    switch (item.type) {
      case 'text':
        content.push({ text: item.text });
        break;
      case 'image':
        content.push({ image: mapImage(item, state) });
        break;
      case 'document':
        content.push({ document: mapDocument(item, state) });
        break;
      case 'audio':
        throw new AiError('unsupported_capability', 'Bedrock tool results cannot contain audio.', {
          code: 'bedrock_tool_result_audio_unsupported',
        });
    }
  }
  if (content.length === 0) {
    content.push({ text: '' });
  }
  return {
    toolResult: {
      content,
      status: part.status === 'success' ? 'success' : 'error',
      toolUseId: part.callId,
    },
  };
}

function mapToolConfig(request: ModelRequest): { toolConfig?: BedrockToolConfiguration } {
  if (request.toolChoice?.type === 'none') {
    return {};
  }
  if (request.tools === undefined || request.tools.length === 0) {
    if (request.toolChoice?.type === 'required' || request.toolChoice?.type === 'required_tool') {
      throw new AiError(
        'invalid_request',
        'A required Bedrock tool choice needs tool definitions.',
        {
          code: 'bedrock_required_tool_missing',
        },
      );
    }
    return {};
  }

  const toolChoice: BedrockToolConfiguration['toolChoice'] =
    request.toolChoice === undefined || request.toolChoice.type === 'auto'
      ? { auto: {} }
      : request.toolChoice.type === 'required'
        ? { any: {} }
        : { tool: { name: request.toolChoice.name } };
  const requiredToolName =
    request.toolChoice?.type === 'required_tool' ? request.toolChoice.name : undefined;
  if (
    requiredToolName !== undefined &&
    !request.tools.some((tool) => tool.name === requiredToolName)
  ) {
    throw new AiError('invalid_request', 'The required Bedrock tool is not defined.', {
      code: 'bedrock_required_tool_not_defined',
      details: { tool: requiredToolName },
    });
  }
  return {
    toolConfig: {
      toolChoice,
      tools: request.tools.map((tool) => ({
        toolSpec: {
          description: tool.description,
          inputSchema: { json: tool.inputSchema },
          name: tool.name,
          strict: true,
        },
      })),
    },
  };
}

function mapResponseFormat(
  format: Exclude<ModelRequest['responseFormat'], undefined | { readonly type: 'text' }>,
): NonNullable<BedrockConverseRequest['outputConfig']> {
  const name = format.type === 'json_schema' ? format.name : 'response';
  const schema = format.type === 'json_schema' ? format.schema : { type: 'object' };
  return {
    textFormat: {
      structure: { jsonSchema: { name, schema: JSON.stringify(schema) } },
      type: 'json_schema',
    },
  };
}

function inlineBytes(source: ImagePart['source'], kind: 'document' | 'image'): Uint8Array {
  if (source.type === 'bytes') {
    return source.bytes;
  }
  throw new AiError(
    'unsupported_capability',
    `Bedrock ${kind} inputs currently require inline bytes.`,
    {
      code: `bedrock_${kind}_${source.type}_unsupported`,
      details: { sourceType: source.type },
    },
  );
}

function documentName(filename: string | undefined): string {
  if (filename === undefined || filename.length === 0) {
    throw new AiError('invalid_request', 'Bedrock inline documents require a filename.', {
      code: 'bedrock_document_filename_required',
    });
  }
  const basename = filename.replace(/^.*[\\/]/u, '');
  const lastDot = basename.lastIndexOf('.');
  const name = lastDot > 0 ? basename.slice(0, lastDot) : basename;
  if (name.length === 0 || !/^[A-Za-z0-9()[\]-]+(?: [A-Za-z0-9()[\]-]+)*$/u.test(name)) {
    throw new AiError(
      'invalid_request',
      'Bedrock document names must be neutral and use only letters, numbers, single spaces, hyphens, parentheses, or square brackets.',
      { code: 'invalid_bedrock_document_name', details: { filename } },
    );
  }
  return name;
}

function validateByteLength(bytes: Uint8Array, kind: 'document' | 'image', maxBytes: number): void {
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
    throw new AiError('invalid_request', `Bedrock ${kind} byte length is outside its limit.`, {
      code: `bedrock_${kind}_byte_limit_exceeded`,
      details: { byteLength: bytes.byteLength, maxBytes },
    });
  }
}

function mappingState(limits: BedrockRequestMappingLimits): MappingState {
  return {
    documentCount: 0,
    imageCount: 0,
    maxDocumentBytes: limits.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
    maxDocumentCount: limits.maxDocumentCount ?? DEFAULT_MAX_DOCUMENT_COUNT,
    maxImageBytes: limits.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
    maxImageCount: limits.maxImageCount ?? DEFAULT_MAX_IMAGE_COUNT,
  };
}

function hasNonEmptyText(content: readonly BedrockContentBlock[]): boolean {
  return content.some((block) => 'text' in block && block.text.trim().length > 0);
}

function requireUserRole(role: ModelRequest['messages'][number]['role'], kind: string): void {
  if (role !== 'user') {
    throw invalidRole(kind, role);
  }
}

function invalidRole(kind: string, role: ModelRequest['messages'][number]['role']): AiError {
  return new AiError(
    'invalid_request',
    `Bedrock ${kind} content is invalid for the ${role} role.`,
    {
      code: 'invalid_bedrock_content_role',
      details: { contentType: kind, role },
    },
  );
}

function unsupportedMimeType(kind: 'document' | 'image', mimeType: string): AiError {
  return new AiError('invalid_request', `Bedrock does not support this ${kind} MIME type.`, {
    code: `unsupported_bedrock_${kind}_mime_type`,
    details: { mimeType },
  });
}

function limitError(kind: 'document' | 'image', count: number, maxCount: number): AiError {
  return new AiError('invalid_request', `Bedrock ${kind} count exceeds the request limit.`, {
    code: `bedrock_${kind}_count_exceeded`,
    details: { count, maxCount },
  });
}

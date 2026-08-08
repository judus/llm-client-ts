import { describe, expect, it } from 'vitest';

import { AiError, type DocumentPart, type ModelRequest } from '../../../src/index.js';

import {
  mapOpenAIRequest,
  mapOpenAIStreamRequest,
} from '../../../src/providers/openai/request-mapper.js';
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

  it('preserves multimodal tool results as function output content', () => {
    const toolRequest: ModelRequest = {
      messages: [
        {
          content: [
            {
              callId: 'call-1',
              content: [
                { text: 'Generated files:', type: 'text' },
                {
                  detail: 'low',
                  mimeType: 'image/png',
                  source: { bytes: new Uint8Array([1]), type: 'bytes' },
                  type: 'image',
                },
                {
                  mimeType: 'application/pdf',
                  source: { fileId: 'file-report', provider: 'openai', type: 'provider_file' },
                  type: 'document',
                },
              ],
              error: { code: 'partial', message: 'One item failed.', retryable: true },
              status: 'error',
              structuredContent: { generated: 2 },
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
        output: [
          { text: '{"generated":2}', type: 'input_text' },
          {
            text: '{"error":{"code":"partial","message":"One item failed.","retryable":true}}',
            type: 'input_text',
          },
          { text: 'Generated files:', type: 'input_text' },
          {
            detail: 'low',
            image_url: 'data:image/png;base64,AQ==',
            type: 'input_image',
          },
          { file_id: 'file-report', type: 'input_file' },
        ],
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

  it('maps inline, URL, and provider-file documents and images in message order', () => {
    const multimodalRequest: ModelRequest = {
      messages: [
        {
          ...request.messages[0]!,
          content: [
            { text: 'Inspect these inputs.', type: 'text' },
            {
              mimeType: 'image/png',
              source: { type: 'url', url: 'https://example.test/image.png' },
              type: 'image',
            },
            {
              detail: 'high',
              mimeType: 'IMAGE/JPEG',
              source: { bytes: new Uint8Array([255]), type: 'bytes' },
              type: 'image',
            },
            {
              mimeType: 'image/webp',
              source: { fileId: 'file-image', provider: 'openai', type: 'provider_file' },
              type: 'image',
            },
            {
              filename: 'inline.pdf',
              mimeType: 'application/pdf',
              source: { bytes: new Uint8Array([1, 2, 3]), type: 'bytes' },
              type: 'document',
            },
            {
              filename: 'remote.txt',
              mimeType: 'text/plain',
              source: { type: 'url', url: 'https://example.test/report.txt' },
              type: 'document',
            },
            {
              mimeType: 'application/pdf',
              source: { fileId: 'file-document', provider: 'openai', type: 'provider_file' },
              type: 'document',
            },
          ],
        },
      ],
      model: request.model,
    };

    expect(mapOpenAIRequest(multimodalRequest, false).input).toEqual([
      {
        content: [
          { text: 'Inspect these inputs.', type: 'input_text' },
          {
            detail: 'auto',
            image_url: 'https://example.test/image.png',
            type: 'input_image',
          },
          {
            detail: 'high',
            image_url: 'data:image/jpeg;base64,/w==',
            type: 'input_image',
          },
          { detail: 'auto', file_id: 'file-image', type: 'input_image' },
          {
            file_data: 'data:application/pdf;base64,AQID',
            filename: 'inline.pdf',
            type: 'input_file',
          },
          {
            file_url: 'https://example.test/report.txt',
            filename: 'remote.txt',
            type: 'input_file',
          },
          { file_id: 'file-document', type: 'input_file' },
        ],
        role: 'user',
        type: 'message',
      },
    ]);
  });

  it('rejects foreign files, unsafe URLs, and unsupported audio', () => {
    const binaryRequest = (content: ModelRequest['messages'][number]['content']): ModelRequest => ({
      messages: [{ ...request.messages[0]!, content }],
      model: request.model,
    });

    expect(() =>
      mapOpenAIRequest(
        binaryRequest([
          {
            mimeType: 'image/png',
            source: { fileId: 'file-1', provider: 'bedrock', type: 'provider_file' },
            type: 'image',
          },
        ]),
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'openai_provider_file_mismatch' }));
    expect(() =>
      mapOpenAIRequest(
        binaryRequest([
          {
            mimeType: 'image/png',
            source: { type: 'url', url: 'file:///private/image.png' },
            type: 'image',
          },
        ]),
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_openai_image_url' }));
    expect(() =>
      mapOpenAIRequest(
        binaryRequest([
          {
            mimeType: 'image/png',
            source: { type: 'url', url: 'not a URL' },
            type: 'image',
          },
        ]),
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_openai_image_url' }));
    expect(() =>
      mapOpenAIRequest(
        binaryRequest([
          {
            mimeType: 'image/png',
            source: { fileId: ' ', provider: 'openai', type: 'provider_file' },
            type: 'image',
          },
        ]),
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_openai_provider_file_id' }));
    expect(() =>
      mapOpenAIRequest(
        binaryRequest([
          {
            mimeType: 'audio/wav',
            source: { bytes: new Uint8Array([1]), type: 'bytes' },
            type: 'audio',
          },
        ]),
        false,
      ),
    ).toThrow(AiError);
  });

  it('enforces binary validation and bounded inline mapping', () => {
    const binaryRequest = (content: ModelRequest['messages'][number]['content']): ModelRequest => ({
      messages: [{ ...request.messages[0]!, content }],
      model: request.model,
    });
    const document = (bytes: Uint8Array): DocumentPart => ({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      source: { bytes, type: 'bytes' as const },
      type: 'document' as const,
    });
    const image = {
      mimeType: 'image/png',
      source: { bytes: new Uint8Array([1]), type: 'bytes' as const },
      type: 'image' as const,
    };

    expect(() =>
      mapOpenAIRequest(binaryRequest([document(new Uint8Array([1, 2]))]), false, {
        maxInlineDocumentBytes: 2,
      }),
    ).toThrow(expect.objectContaining({ code: 'openai_inline_document_limit_exceeded' }));
    expect(() =>
      mapOpenAIRequest(
        binaryRequest([document(new Uint8Array([1])), document(new Uint8Array([2]))]),
        false,
        { maxInlineDocumentBytes: 2 },
      ),
    ).toThrow(expect.objectContaining({ code: 'openai_inline_document_limit_exceeded' }));
    expect(() =>
      mapOpenAIRequest(binaryRequest([image]), false, { maxInlineImagePayloadBytes: 1 }),
    ).toThrow(expect.objectContaining({ code: 'openai_inline_image_payload_limit_exceeded' }));
    expect(() =>
      mapOpenAIRequest(binaryRequest([image, image]), false, { maxImageCount: 1 }),
    ).toThrow(expect.objectContaining({ code: 'openai_image_count_exceeded' }));
    expect(() => mapOpenAIRequest(binaryRequest([image]), false, { maxImageCount: 0 })).toThrow(
      expect.objectContaining({ code: 'invalid_openai_mapping_limit' }),
    );
    expect(() =>
      mapOpenAIRequest(
        binaryRequest([
          {
            mimeType: 'image/svg+xml',
            source: { bytes: new Uint8Array([1]), type: 'bytes' },
            type: 'image',
          },
        ]),
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'unsupported_openai_image_mime_type' }));
    expect(() =>
      mapOpenAIRequest(
        binaryRequest([
          {
            mimeType: 'application/pdf',
            source: { bytes: new Uint8Array([1]), type: 'bytes' },
            type: 'document',
          },
        ]),
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'openai_inline_document_filename_required' }));
    expect(() =>
      mapOpenAIRequest(
        binaryRequest([
          {
            filename: '../report.pdf',
            mimeType: 'application/pdf',
            source: { bytes: new Uint8Array([1]), type: 'bytes' },
            type: 'document',
          },
        ]),
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_openai_document_filename' }));
    expect(() =>
      mapOpenAIRequest(
        binaryRequest([
          {
            filename: 'report.pdf',
            mimeType: 'not-a-mime-type',
            source: { bytes: new Uint8Array([1]), type: 'bytes' },
            type: 'document',
          },
        ]),
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_openai_document_mime_type' }));
    expect(() => mapOpenAIRequest(binaryRequest([document(new Uint8Array())]), false)).toThrow(
      expect.objectContaining({ code: 'invalid_openai_document_bytes' }),
    );
    expect(() =>
      mapOpenAIRequest(
        {
          messages: [
            {
              ...request.messages[0]!,
              content: [{ text: 'invalid direct tool content', type: 'text' }],
              role: 'tool',
            },
          ],
          model: request.model,
        },
        false,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_openai_tool_message_content' }));
  });
});

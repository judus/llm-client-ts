import { describe, expect, it } from 'vitest';

import type { ContentPart, ModelRequest } from '@maduser/ai-ts';

import { mapBedrockRequest } from '../src/request-mapper.js';
import { request } from './fixtures.js';

describe('Bedrock request mapping', () => {
  it('maps Converse text, tools, inference settings, and structured output', () => {
    expect(mapBedrockRequest(request)).toEqual({
      inferenceConfig: { maxTokens: 512 },
      messages: [{ content: [{ text: 'What is the weather?' }], role: 'user' }],
      modelId: 'anthropic.claude-sonnet',
      outputConfig: {
        textFormat: {
          structure: {
            jsonSchema: {
              name: 'weather_answer',
              schema: JSON.stringify(
                request.responseFormat?.type === 'json_schema' ? request.responseFormat.schema : {},
              ),
            },
          },
          type: 'json_schema',
        },
      },
      toolConfig: {
        toolChoice: { auto: {} },
        tools: [
          {
            toolSpec: {
              description: 'Get the weather for a place.',
              inputSchema: { json: request.tools?.[0]?.inputSchema },
              name: 'get_weather',
              strict: true,
            },
          },
        ],
      },
    });
  });

  it('maps system instructions, sampling, JSON mode, and explicit tool choices', () => {
    const mapped = mapBedrockRequest({
      ...request,
      messages: [
        {
          ...request.messages[0]!,
          content: [{ text: 'Be concise.', type: 'text' }],
          role: 'system',
        },
        ...request.messages,
      ],
      responseFormat: { type: 'json' },
      sampling: { temperature: 0.2, topP: 0.8 },
      toolChoice: { name: 'get_weather', type: 'required_tool' },
    });

    expect(mapped).toMatchObject({
      inferenceConfig: { maxTokens: 512, temperature: 0.2, topP: 0.8 },
      outputConfig: {
        textFormat: {
          structure: { jsonSchema: { name: 'response', schema: '{"type":"object"}' } },
        },
      },
      system: [{ text: 'Be concise.' }],
      toolConfig: { toolChoice: { tool: { name: 'get_weather' } } },
    });
    expect(
      mapBedrockRequest({ ...request, toolChoice: { type: 'required' } }).toolConfig,
    ).toMatchObject({ toolChoice: { any: {} } });
    expect(
      mapBedrockRequest({ ...request, toolChoice: { type: 'none' } }).toolConfig,
    ).toBeUndefined();
  });

  it('maps inline images and documents without base64 conversion', () => {
    const imageBytes = new Uint8Array([1, 2]);
    const documentBytes = new Uint8Array([3, 4]);
    const mapped = mapBedrockRequest({
      messages: [
        {
          ...request.messages[0]!,
          content: [
            { text: 'Inspect these.', type: 'text' },
            { mimeType: 'image/png', source: { bytes: imageBytes, type: 'bytes' }, type: 'image' },
            {
              filename: 'Quarterly Report.pdf',
              mimeType: 'application/pdf',
              source: { bytes: documentBytes, type: 'bytes' },
              type: 'document',
            },
          ],
        },
      ],
      model: request.model,
    });

    expect(mapped.messages[0]?.content).toEqual([
      { text: 'Inspect these.' },
      { image: { format: 'png', source: { bytes: imageBytes } } },
      {
        document: { format: 'pdf', name: 'Quarterly Report', source: { bytes: documentBytes } },
      },
    ]);
  });

  it('maps prior tool calls and multimodal tool results', () => {
    const mapped = mapBedrockRequest({
      messages: [
        {
          ...request.messages[0]!,
          content: [
            {
              arguments: { place: 'Berlin' },
              callId: 'call-1',
              name: 'get_weather',
              type: 'tool_call',
            },
          ],
          role: 'assistant',
        },
        {
          ...request.messages[0]!,
          content: [
            {
              callId: 'call-1',
              content: [
                { text: 'partial', type: 'text' },
                {
                  mimeType: 'image/jpeg',
                  source: { bytes: new Uint8Array([1]), type: 'bytes' },
                  type: 'image',
                },
              ],
              error: { code: 'partial', message: 'Partial result.', retryable: true },
              status: 'error',
              structuredContent: { temperature: 25 },
              type: 'tool_result',
            },
          ],
          role: 'tool',
        },
      ],
      model: request.model,
    });

    expect(mapped.messages).toMatchObject([
      {
        content: [
          { toolUse: { input: { place: 'Berlin' }, name: 'get_weather', toolUseId: 'call-1' } },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            toolResult: {
              content: [
                { json: { temperature: 25 } },
                {
                  json: { error: { code: 'partial', message: 'Partial result.', retryable: true } },
                },
                { text: 'partial' },
                { image: { format: 'jpeg' } },
              ],
              status: 'error',
              toolUseId: 'call-1',
            },
          },
        ],
        role: 'user',
      },
    ]);
  });

  it.each([
    [
      {
        mimeType: 'image/png',
        source: { type: 'url', url: 'https://example.test/a.png' },
        type: 'image',
      },
      'bedrock_image_url_unsupported',
    ],
    [
      {
        filename: 'unsafe name!.pdf',
        mimeType: 'application/pdf',
        source: { bytes: new Uint8Array([1]), type: 'bytes' },
        type: 'document',
      },
      'invalid_bedrock_document_name',
    ],
    [
      {
        mimeType: 'audio/wav',
        source: { bytes: new Uint8Array([1]), type: 'bytes' },
        type: 'audio',
      },
      'bedrock_audio_mapping_unavailable',
    ],
  ] satisfies readonly [ContentPart, string][])('rejects unsupported content %#', (part, code) => {
    expect(() =>
      mapBedrockRequest({
        messages: [{ ...request.messages[0]!, content: [part] }],
        model: request.model,
      }),
    ).toThrow(expect.objectContaining({ code }));
  });

  it('enforces document companion text, byte/count limits, roles, and sampling support', () => {
    const document: ContentPart = {
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      source: { bytes: new Uint8Array([1, 2]), type: 'bytes' },
      type: 'document',
    };
    expect(() => mapWith([document])).toThrow(
      expect.objectContaining({ code: 'bedrock_document_text_required' }),
    );
    expect(() =>
      mapWith([{ text: 'read', type: 'text' }, document], { maxDocumentBytes: 1 }),
    ).toThrow(expect.objectContaining({ code: 'bedrock_document_byte_limit_exceeded' }));
    expect(() =>
      mapWith([{ text: 'read', type: 'text' }, document, document], { maxDocumentCount: 1 }),
    ).toThrow(expect.objectContaining({ code: 'bedrock_document_count_exceeded' }));
    expect(() =>
      mapBedrockRequest({
        messages: [{ ...request.messages[0]!, content: [{ ...document }], role: 'assistant' }],
        model: request.model,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_bedrock_content_role' }));
    expect(() => mapBedrockRequest({ ...request, sampling: { seed: 1 } })).toThrow(
      expect.objectContaining({ code: 'bedrock_sampling_seed_unsupported' }),
    );
  });

  it('rejects invalid provider, message, binary, MIME, and tool combinations', () => {
    expect(() =>
      mapBedrockRequest({ ...request, model: { ...request.model, provider: 'openai' } }),
    ).toThrow(expect.objectContaining({ code: 'bedrock_provider_mismatch' }));
    expect(() =>
      mapBedrockRequest({
        messages: [{ ...request.messages[0]!, content: [], role: 'user' }],
        model: request.model,
      }),
    ).toThrow(expect.objectContaining({ code: 'empty_bedrock_message' }));
    expect(() =>
      mapBedrockRequest({
        messages: [
          {
            ...request.messages[0]!,
            content: [
              {
                arguments: {},
                callId: 'call',
                name: 'tool',
                type: 'tool_call',
              },
            ],
            role: 'system',
          },
        ],
        model: request.model,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_bedrock_system_content' }));
    expect(() =>
      mapWith([
        {
          mimeType: 'image/svg+xml',
          source: { bytes: new Uint8Array([1]), type: 'bytes' },
          type: 'image',
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'unsupported_bedrock_image_mime_type' }));
    expect(() =>
      mapWith(
        [
          {
            mimeType: 'image/png',
            source: { bytes: new Uint8Array([1]), type: 'bytes' },
            type: 'image',
          },
          {
            mimeType: 'image/png',
            source: { bytes: new Uint8Array([2]), type: 'bytes' },
            type: 'image',
          },
        ],
        { maxImageCount: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: 'bedrock_image_count_exceeded' }));
    expect(() =>
      mapWith(
        [
          {
            mimeType: 'image/png',
            source: { bytes: new Uint8Array(), type: 'bytes' },
            type: 'image',
          },
        ],
        { maxImageBytes: 1 },
      ),
    ).toThrow(expect.objectContaining({ code: 'bedrock_image_byte_limit_exceeded' }));
    expect(() =>
      mapWith([
        { text: 'read', type: 'text' },
        {
          filename: 'report.zip',
          mimeType: 'application/zip',
          source: { bytes: new Uint8Array([1]), type: 'bytes' },
          type: 'document',
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'unsupported_bedrock_document_mime_type' }));
    expect(() =>
      mapWith([
        { text: 'read', type: 'text' },
        {
          mimeType: 'application/pdf',
          source: { bytes: new Uint8Array([1]), type: 'bytes' },
          type: 'document',
        },
      ]),
    ).toThrow(expect.objectContaining({ code: 'bedrock_document_filename_required' }));
    expect(() =>
      mapBedrockRequest({ ...request, tools: [], toolChoice: { type: 'required' } }),
    ).toThrow(expect.objectContaining({ code: 'bedrock_required_tool_missing' }));
    expect(() =>
      mapBedrockRequest({
        ...request,
        toolChoice: { name: 'missing', type: 'required_tool' },
      }),
    ).toThrow(expect.objectContaining({ code: 'bedrock_required_tool_not_defined' }));
  });

  it('maps empty successful tool results and plain text mode without optional configuration', () => {
    const mapped = mapBedrockRequest({
      messages: [
        {
          ...request.messages[0]!,
          content: [
            {
              callId: 'call-1',
              content: [],
              status: 'success',
              type: 'tool_result',
            },
          ],
          role: 'tool',
        },
      ],
      model: request.model,
      responseFormat: { type: 'text' },
      toolChoice: { type: 'auto' },
    });

    expect(mapped).toEqual({
      messages: [
        {
          content: [
            {
              toolResult: {
                content: [{ text: '' }],
                status: 'success',
                toolUseId: 'call-1',
              },
            },
          ],
          role: 'user',
        },
      ],
      modelId: request.model.model,
    });
  });
});

function mapWith(
  content: readonly ContentPart[],
  limits: Parameters<typeof mapBedrockRequest>[1] = {},
): ReturnType<typeof mapBedrockRequest> {
  const value: ModelRequest = {
    messages: [{ ...request.messages[0]!, content }],
    model: request.model,
  };
  return mapBedrockRequest(value, limits);
}

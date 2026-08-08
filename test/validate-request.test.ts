import { describe, expect, it } from 'vitest';

import { validateModelRequest, type ModelCapabilities, type ModelRequest } from '../src/index.js';
import { capabilities, userMessage } from './fixtures.js';

const baseRequest: ModelRequest = {
  messages: [userMessage],
  model: { model: 'test-model', provider: 'test' },
};

describe('validateModelRequest', () => {
  it('accepts a supported request', () => {
    expect(() => {
      validateModelRequest(baseRequest, capabilities, 'test', true);
    }).not.toThrow();
  });

  it('requires at least one message', () => {
    expect(() => {
      validateModelRequest({ ...baseRequest, messages: [] }, capabilities, 'test', false);
    }).toThrow(expect.objectContaining({ code: 'messages_empty' }));
  });

  it('rejects unsupported image content', () => {
    const imageRequest: ModelRequest = {
      ...baseRequest,
      messages: [
        {
          ...userMessage,
          content: [
            {
              mimeType: 'image/png',
              source: { type: 'url', url: 'https://example.test/image.png' },
              type: 'image',
            },
          ],
        },
      ],
    };

    expect(() => {
      validateModelRequest(imageRequest, capabilities, 'test', false);
    }).toThrow(expect.objectContaining({ category: 'unsupported_capability' }));
  });

  it('rejects strict schema output when strict schemas are unavailable', () => {
    const withoutStrictSchema: ModelCapabilities = {
      ...capabilities,
      tools: { ...capabilities.tools, strictSchemas: false },
    };
    const structuredRequest: ModelRequest = {
      ...baseRequest,
      responseFormat: {
        name: 'answer',
        schema: { additionalProperties: false, type: 'object' },
        strict: true,
        type: 'json_schema',
      },
    };

    expect(() => {
      validateModelRequest(structuredRequest, withoutStrictSchema, 'test', false);
    }).toThrow(expect.objectContaining({ category: 'unsupported_capability' }));
  });

  it('rejects streaming, tools, and structured output when unavailable', () => {
    const unavailable: ModelCapabilities = {
      ...capabilities,
      output: { ...capabilities.output, structured: false },
      streaming: false,
      tools: { ...capabilities.tools, calls: false },
    };

    expect(() => {
      validateModelRequest(baseRequest, unavailable, 'test', true);
    }).toThrow(expect.objectContaining({ category: 'unsupported_capability' }));

    expect(() => {
      validateModelRequest(
        {
          ...baseRequest,
          tools: [
            {
              description: 'Test.',
              inputSchema: { type: 'object' },
              name: 'test',
            },
          ],
        },
        unavailable,
        'test',
        false,
      );
    }).toThrow(expect.objectContaining({ category: 'unsupported_capability' }));

    expect(() => {
      validateModelRequest(
        { ...baseRequest, responseFormat: { type: 'json' } },
        unavailable,
        'test',
        false,
      );
    }).toThrow(expect.objectContaining({ category: 'unsupported_capability' }));
  });
});

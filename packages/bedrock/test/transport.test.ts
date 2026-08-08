import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  configs: [] as unknown[],
  destroyed: 0,
  options: [] as unknown[],
  requests: [] as unknown[],
  responses: [] as unknown[],
}));

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class {
    public constructor(config: unknown) {
      sdk.configs.push(config);
    }

    public destroy(): void {
      sdk.destroyed += 1;
    }

    public send(command: { readonly input: unknown }, options: unknown): Promise<unknown> {
      sdk.requests.push(command.input);
      sdk.options.push(options);
      return Promise.resolve(sdk.responses.shift());
    }
  },
  ConverseCommand: class {
    public constructor(public readonly input: unknown) {}
  },
  ConverseStreamCommand: class {
    public constructor(public readonly input: unknown) {}
  },
}));

import { BedrockSdkRuntimeTransport } from '../src/transport.js';
import type { BedrockConverseRequest } from '../src/types.js';

const request: BedrockConverseRequest = {
  inferenceConfig: { maxTokens: 10, temperature: 0.2, topP: 0.8 },
  messages: [
    {
      content: [
        { text: 'inspect' },
        { image: { format: 'png', source: { bytes: new Uint8Array([1]) } } },
        {
          document: {
            format: 'pdf',
            name: 'report',
            source: { bytes: new Uint8Array([2]) },
          },
        },
        { toolUse: { input: { place: 'Berlin' }, name: 'weather', toolUseId: 'call-1' } },
        {
          toolResult: {
            content: [
              { json: { temperature: 25 } },
              { text: 'sunny' },
              { image: { format: 'jpeg', source: { bytes: new Uint8Array([3]) } } },
              {
                document: {
                  format: 'txt',
                  name: 'result',
                  source: { bytes: new Uint8Array([4]) },
                },
              },
            ],
            status: 'success',
            toolUseId: 'call-1',
          },
        },
      ],
      role: 'user',
    },
  ],
  modelId: 'model-1',
  outputConfig: {
    textFormat: {
      structure: { jsonSchema: { name: 'answer', schema: '{"type":"object"}' } },
      type: 'json_schema',
    },
  },
  system: [{ text: 'Be concise.' }],
  toolConfig: {
    toolChoice: { auto: {} },
    tools: [
      {
        toolSpec: {
          description: 'Weather.',
          inputSchema: { json: { type: 'object' } },
          name: 'weather',
          strict: true,
        },
      },
    ],
  },
};

describe('BedrockSdkRuntimeTransport', () => {
  beforeEach(() => {
    sdk.configs.length = 0;
    sdk.destroyed = 0;
    sdk.options.length = 0;
    sdk.requests.length = 0;
    sdk.responses.length = 0;
  });

  it('keeps SDK configuration and command values behind the transport boundary', async () => {
    sdk.responses.push({
      additionalModelResponseFields: { routing: 'profile' },
      metrics: { latencyMs: 42 },
      output: {
        message: {
          content: [
            { text: 'Hello' },
            { toolUse: { input: { place: 'Berlin' }, name: 'weather', toolUseId: 'call-1' } },
          ],
          role: 'assistant',
        },
      },
      stopReason: 'tool_use',
      usage: {
        cacheReadInputTokens: 2,
        cacheWriteInputTokens: 3,
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
      },
    });
    const transport = new BedrockSdkRuntimeTransport({
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret', sessionToken: 'session' },
      endpoint: 'https://bedrock.example.test',
      maxAttempts: 2,
      region: 'eu-central-1',
    });
    const signal = new AbortController().signal;

    await expect(transport.converse(request, { signal })).resolves.toMatchObject({
      additionalModelResponseFields: { routing: 'profile' },
      latencyMs: 42,
      message: {
        content: [
          { text: 'Hello' },
          { toolUse: { input: { place: 'Berlin' }, name: 'weather', toolUseId: 'call-1' } },
        ],
        role: 'assistant',
      },
      stopReason: 'tool_use',
      usage: { cacheReadInputTokens: 2, cacheWriteInputTokens: 3 },
    });
    expect(sdk.configs[0]).toMatchObject({
      endpoint: 'https://bedrock.example.test',
      maxAttempts: 2,
      region: 'eu-central-1',
    });
    expect(sdk.requests[0]).toMatchObject({
      inferenceConfig: request.inferenceConfig,
      messages: [
        {
          content: [
            { text: 'inspect' },
            { image: { format: 'png' } },
            { document: { format: 'pdf', name: 'report' } },
            { toolUse: { input: { place: 'Berlin' } } },
            {
              toolResult: {
                content: [
                  { json: { temperature: 25 } },
                  { text: 'sunny' },
                  { image: { format: 'jpeg', source: { bytes: new Uint8Array([3]) } } },
                  {
                    document: {
                      format: 'txt',
                      name: 'result',
                      source: { bytes: new Uint8Array([4]) },
                    },
                  },
                ],
                status: 'success',
                toolUseId: 'call-1',
              },
            },
          ],
        },
      ],
      outputConfig: request.outputConfig,
      system: request.system,
      toolConfig: request.toolConfig,
    });
    expect(sdk.options).toEqual([{ abortSignal: signal }]);
    transport.close();
    expect(sdk.destroyed).toBe(1);
  });

  it('normalizes ConverseStream events and embedded failures', async () => {
    sdk.responses.push({
      stream: iterate([
        { messageStart: { role: 'assistant' } },
        {
          contentBlockStart: {
            contentBlockIndex: 1,
            start: { toolUse: { name: 'weather', toolUseId: 'call-1' } },
          },
        },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hi' } } },
        { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{}' } } } },
        { contentBlockDelta: { contentBlockIndex: 2, delta: { citation: {} } } },
        { contentBlockStop: { contentBlockIndex: 1 } },
        {
          metadata: {
            metrics: { latencyMs: 10 },
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          },
        },
        { messageStop: { stopReason: 'end_turn' } },
        { internalServerException: { message: 'Internal.' } },
        { modelStreamErrorException: { message: 'Stream failed.' } },
        { serviceUnavailableException: { message: 'Unavailable.' } },
        { throttlingException: { message: 'Slow down.' } },
        { validationException: { message: 'Invalid.' } },
      ]),
    });
    const transport = new BedrockSdkRuntimeTransport();
    const events = await collect(
      await transport.converseStream(request, {
        signal: new AbortController().signal,
        timeoutMs: 1_000,
      }),
    );

    expect(events).toEqual([
      { contentBlockIndex: 1, name: 'weather', toolUseId: 'call-1', type: 'tool_start' },
      { contentBlockIndex: 0, text: 'Hi', type: 'text_delta' },
      { contentBlockIndex: 1, input: '{}', type: 'tool_delta' },
      { contentBlockIndex: 1, type: 'content_stop' },
      {
        type: 'metadata',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
      { stopReason: 'end_turn', type: 'message_stop' },
      { code: 'InternalServerException', message: 'Internal.', retryable: true, type: 'error' },
      {
        code: 'ModelStreamErrorException',
        message: 'Stream failed.',
        retryable: true,
        type: 'error',
      },
      {
        code: 'ServiceUnavailableException',
        message: 'Unavailable.',
        retryable: true,
        type: 'error',
      },
      { code: 'ThrottlingException', message: 'Slow down.', retryable: true, type: 'error' },
      { code: 'ValidationException', message: 'Invalid.', retryable: false, type: 'error' },
    ]);
    expect(hasAbortSignal(sdk.options[0])).toBe(true);
  });

  it('rejects missing provider output and unsupported transport options', async () => {
    const transport = new BedrockSdkRuntimeTransport();
    sdk.responses.push({ output: undefined });
    await expect(transport.converse(request, {})).rejects.toMatchObject({
      code: 'bedrock_response_message_missing',
    });
    await expect(transport.converse(request, { idempotencyKey: 'idem' })).rejects.toMatchObject({
      code: 'bedrock_idempotency_key_unsupported',
    });
    sdk.responses.push({ stream: undefined });
    await expect(transport.converseStream(request, {})).rejects.toMatchObject({
      code: 'bedrock_stream_missing',
    });
  });

  it.each([
    [
      {
        output: { message: { content: [{ text: 'x' }], role: 'system' } },
        stopReason: 'end_turn',
      },
      'bedrock_message_role_invalid',
    ],
    [
      { output: { message: { content: undefined, role: 'assistant' } }, stopReason: 'end_turn' },
      'bedrock_message_content_missing',
    ],
    [
      {
        output: {
          message: {
            content: [{ image: { format: 'png', source: { bytes: new Uint8Array([1]) } } }],
            role: 'assistant',
          },
        },
        stopReason: 'end_turn',
      },
      'bedrock_response_content_unsupported',
    ],
    [
      {
        output: {
          message: {
            content: [{ toolUse: { input: [], name: 'weather', toolUseId: 'call-1' } }],
            role: 'assistant',
          },
        },
        stopReason: 'tool_use',
      },
      'bedrock_tool_input_not_object',
    ],
    [
      {
        output: {
          message: {
            content: [{ toolUse: { input: {}, name: '', toolUseId: 'call-1' } }],
            role: 'assistant',
          },
        },
        stopReason: 'tool_use',
      },
      'bedrock_required_string_missing',
    ],
    [
      { output: { message: { content: [{ text: 'x' }], role: 'assistant' } }, stopReason: 'new' },
      'bedrock_stop_reason_invalid',
    ],
    [
      {
        metrics: { latencyMs: -1 },
        output: { message: { content: [{ text: 'x' }], role: 'assistant' } },
        stopReason: 'end_turn',
      },
      'bedrock_invalid_number',
    ],
    [
      {
        output: { message: { content: [{ text: 'x' }], role: 'assistant' } },
        stopReason: 'end_turn',
        usage: { inputTokens: -1, outputTokens: 1, totalTokens: 0 },
      },
      'bedrock_invalid_number',
    ],
    [
      {
        additionalModelResponseFields: { bad: Number.NaN },
        output: { message: { content: [{ text: 'x' }], role: 'assistant' } },
        stopReason: 'end_turn',
      },
      'bedrock_invalid_json_value',
    ],
  ] as const)('rejects malformed Converse response %#', async (response, code) => {
    sdk.responses.push(response);
    const transport = new BedrockSdkRuntimeTransport();
    await expect(transport.converse(request, {})).rejects.toMatchObject({ code });
  });

  it('rejects malformed streaming metadata and stop values', async () => {
    const transport = new BedrockSdkRuntimeTransport();
    sdk.responses.push({ stream: iterate([{ metadata: { usage: undefined } }]) });
    await expect(collect(await transport.converseStream(request, {}))).rejects.toMatchObject({
      code: 'bedrock_stream_usage_missing',
    });
    sdk.responses.push({ stream: iterate([{ messageStop: { stopReason: 'future_reason' } }]) });
    await expect(collect(await transport.converseStream(request, {}))).rejects.toMatchObject({
      code: 'bedrock_stop_reason_invalid',
    });
    sdk.responses.push({ stream: iterate([{ messageStart: { role: 'user' } }]) });
    await expect(collect(await transport.converseStream(request, {}))).rejects.toMatchObject({
      code: 'bedrock_stream_role_invalid',
    });
    sdk.responses.push({
      stream: iterate([
        { contentBlockStart: { contentBlockIndex: 0, start: { image: { format: 'png' } } } },
      ]),
    });
    await expect(collect(await transport.converseStream(request, {}))).rejects.toMatchObject({
      code: 'bedrock_stream_content_unsupported',
    });
  });
});

async function* iterate(events: readonly unknown[]): AsyncGenerator<unknown, void, void> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

function hasAbortSignal(value: unknown): value is { readonly abortSignal: AbortSignal } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'abortSignal' in value &&
    value.abortSignal instanceof AbortSignal
  );
}

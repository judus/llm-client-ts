import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenAISdkAudioTransport } from '../../../src/providers/openai/audio-transport.js';

const mocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  speechCreate: vi.fn<(request: unknown, options: unknown) => unknown>(),
  toFile: vi.fn(),
  transcriptionCreate: vi.fn<(request: unknown, options: unknown) => unknown>(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    public readonly audio = {
      speech: { create: mocks.speechCreate },
      transcriptions: { create: mocks.transcriptionCreate },
    };

    public constructor(options: unknown) {
      mocks.clientOptions.push(options);
    }
  },
  toFile: mocks.toFile,
}));

describe('OpenAISdkAudioTransport', () => {
  beforeEach(() => {
    mocks.clientOptions.length = 0;
    mocks.speechCreate.mockReset();
    mocks.toFile.mockReset();
    mocks.transcriptionCreate.mockReset();
    mocks.toFile.mockResolvedValue({ upload: 'audio-file' });
  });

  it('maps streaming transcription requests and normalizes SDK events', async () => {
    const providerEvents = iterate([
      { delta: 'Hello', type: 'transcript.text.delta' as const },
      {
        end: 1,
        id: 'segment-1',
        speaker: 'A',
        start: 0,
        text: 'Hello',
        type: 'transcript.text.segment' as const,
      },
      {
        languages: [{ code: 'en' }],
        text: 'Hello.',
        type: 'transcript.text.done' as const,
        usage: {
          input_token_details: { audio_tokens: 5 },
          input_tokens: 6,
          output_tokens: 2,
          total_tokens: 8,
          type: 'tokens' as const,
        },
      },
    ]);
    mocks.transcriptionCreate.mockReturnValue(
      withResponse({ data: providerEvents, request_id: 'transcription-request' }),
    );
    const transport = new OpenAISdkAudioTransport({
      apiKey: 'test-key',
      baseUrl: 'https://openai.example.test/v1',
      maxRetries: 1,
      timeoutMs: 5_000,
    });
    const signal = new AbortController().signal;

    const result = await transport.transcribe(
      {
        audio: new Uint8Array([1, 2]),
        filename: 'audio.webm',
        language: 'en',
        mimeType: 'audio/webm',
        model: 'gpt-transcribe',
        prompt: 'Names',
        stream: true,
      },
      { idempotencyKey: 'idem-1', signal, timeoutMs: 2_000 },
    );

    expect(mocks.clientOptions).toEqual([
      {
        apiKey: 'test-key',
        baseURL: 'https://openai.example.test/v1',
        maxRetries: 1,
        timeout: 5_000,
      },
    ]);
    expect(mocks.toFile).toHaveBeenCalledWith(new Uint8Array([1, 2]), 'audio.webm', {
      type: 'audio/webm',
    });
    expect(mocks.transcriptionCreate).toHaveBeenCalledWith(
      {
        file: { upload: 'audio-file' },
        language: 'en',
        model: 'gpt-transcribe',
        prompt: 'Names',
        response_format: 'json',
        stream: true,
      },
      {
        headers: { 'Idempotency-Key': 'idem-1' },
        signal,
        timeout: 2_000,
      },
    );
    expect(result.requestId).toBe('transcription-request');
    await expect(collect(result.events)).resolves.toEqual([
      { delta: 'Hello', type: 'text_delta' },
      {
        languages: ['en'],
        text: 'Hello.',
        type: 'completed',
        usage: { audioInputTokens: 5, inputTokens: 6, outputTokens: 2 },
      },
    ]);
  });

  it('normalizes final-only duration transcription without optional settings', async () => {
    mocks.transcriptionCreate.mockReturnValue(
      withResponse({
        data: { text: 'Hello.', usage: { seconds: 1.234, type: 'duration' as const } },
        request_id: null,
      }),
    );
    const transport = new OpenAISdkAudioTransport({});

    const result = await transport.transcribe(
      {
        audio: new Uint8Array([1]),
        filename: 'audio.wav',
        mimeType: 'audio/wav',
        model: 'whisper-1',
        stream: false,
      },
      {},
    );

    expect(mocks.transcriptionCreate).toHaveBeenCalledWith(
      {
        file: { upload: 'audio-file' },
        model: 'whisper-1',
        response_format: 'json',
        stream: false,
      },
      {},
    );
    expect(result).not.toHaveProperty('requestId');
    await expect(collect(result.events)).resolves.toEqual([
      { text: 'Hello.', type: 'completed', usage: { durationMs: 1_234 } },
    ]);
  });

  it('maps speech requests and returns copied response bytes', async () => {
    mocks.speechCreate.mockReturnValue(
      withResponse({
        data: new Response(new Uint8Array([4, 5, 6])),
        request_id: 'speech-request',
      }),
    );
    const transport = new OpenAISdkAudioTransport({ organization: 'org-1', project: 'project-1' });

    const result = await transport.synthesize(
      {
        format: 'wav',
        instructions: 'Speak clearly',
        model: 'gpt-4o-mini-tts',
        speed: 1.2,
        text: 'Hello',
        voice: 'coral',
      },
      {},
    );

    expect(mocks.clientOptions).toEqual([{ organization: 'org-1', project: 'project-1' }]);
    expect(mocks.speechCreate).toHaveBeenCalledWith(
      {
        input: 'Hello',
        instructions: 'Speak clearly',
        model: 'gpt-4o-mini-tts',
        response_format: 'wav',
        speed: 1.2,
        voice: 'coral',
      },
      {},
    );
    expect(result).toEqual({
      audio: new Uint8Array([4, 5, 6]),
      requestId: 'speech-request',
    });
  });
});

function withResponse(value: unknown): { readonly withResponse: () => Promise<unknown> } {
  return { withResponse: () => Promise.resolve(value) };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const value of values) {
    collected.push(value);
  }
  return collected;
}

async function* iterate<T>(values: readonly T[]): AsyncGenerator<T> {
  for (const value of values) {
    await Promise.resolve();
    yield value;
  }
}

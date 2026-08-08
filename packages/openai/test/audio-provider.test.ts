import { describe, expect, it } from 'vitest';

import type { AudioPart, TranscriptionEvent, VoiceOperationOptions } from '@maduser/ai-ts';

import {
  OpenAISpeechSynthesisProvider,
  OpenAITranscriptionProvider,
  type OpenAISpeechTransport,
  type OpenAISpeechTransportRequest,
  type OpenAITranscriptionTransport,
  type OpenAITranscriptionTransportEvent,
  type OpenAITranscriptionTransportRequest,
} from '../src/index.js';

const audio: AudioPart = {
  durationMs: 1_500,
  mimeType: 'audio/webm',
  source: { bytes: new Uint8Array([1, 2, 3]), type: 'bytes' },
  type: 'audio',
};

function transcriptionTransport(
  events: readonly OpenAITranscriptionTransportEvent[],
  requestId = 'request-1',
): OpenAITranscriptionTransport & {
  readonly requests: OpenAITranscriptionTransportRequest[];
  readonly options: VoiceOperationOptions[];
} {
  const requests: OpenAITranscriptionTransportRequest[] = [];
  const options: VoiceOperationOptions[] = [];
  return {
    options,
    requests,
    transcribe(request, callOptions) {
      requests.push(request);
      options.push(callOptions);
      return Promise.resolve({ events: iterate(events), requestId });
    },
  };
}

function speechTransport(audioBytes = new Uint8Array([8, 9])): OpenAISpeechTransport & {
  readonly requests: OpenAISpeechTransportRequest[];
  readonly options: VoiceOperationOptions[];
} {
  const requests: OpenAISpeechTransportRequest[] = [];
  const options: VoiceOperationOptions[] = [];
  return {
    options,
    requests,
    synthesize(request, callOptions) {
      requests.push(request);
      options.push(callOptions);
      return Promise.resolve({ audio: audioBytes, requestId: 'speech-request-1' });
    },
  };
}

async function collect(events: AsyncIterable<TranscriptionEvent>): Promise<TranscriptionEvent[]> {
  const collected: TranscriptionEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('OpenAITranscriptionProvider', () => {
  it('maps bounded audio and normalized streaming events without leaking SDK values', async () => {
    const transport = transcriptionTransport([
      { delta: 'Hello ', type: 'text_delta' },
      {
        languages: ['de', 'en'],
        text: 'Hello world.',
        type: 'completed',
        usage: { audioInputTokens: 7, inputTokens: 9, outputTokens: 3 },
      },
    ]);
    const provider = new OpenAITranscriptionProvider(
      { model: 'gpt-transcribe', stream: true },
      { transport },
    );
    const signal = new AbortController().signal;

    const events = await collect(
      provider.transcribe({ audio, language: 'de', prompt: 'Commander names' }, { signal }),
    );

    expect(transport.requests).toEqual([
      {
        audio: new Uint8Array([1, 2, 3]),
        filename: 'audio.webm',
        language: 'de',
        mimeType: 'audio/webm',
        model: 'gpt-transcribe',
        prompt: 'Commander names',
        stream: true,
      },
    ]);
    expect(transport.options).toEqual([{ signal }]);
    expect(events).toEqual([
      { delta: 'Hello ', type: 'transcription.text.delta' },
      {
        transcription: {
          durationMs: 1_500,
          language: 'de',
          providerMetadata: {
            detectedLanguages: ['de', 'en'],
            model: 'gpt-transcribe',
            requestId: 'request-1',
          },
          text: 'Hello world.',
          usage: { audioInputTokens: 7, inputTokens: 9, outputTokens: 3 },
        },
        type: 'transcription.completed',
      },
    ]);
  });

  it('prefers provider duration usage and supports final-only transcription', async () => {
    const transport = transcriptionTransport([
      { text: 'Final.', type: 'completed', usage: { durationMs: 2_250 } },
    ]);
    const provider = new OpenAITranscriptionProvider({ stream: false }, { transport });

    const events = await collect(provider.transcribe({ audio }));

    expect(transport.requests[0]).toMatchObject({ model: 'gpt-transcribe', stream: false });
    expect(events.at(-1)).toMatchObject({
      transcription: { durationMs: 2_250, usage: { audioInputMs: 2_250 } },
    });
  });

  it.each([
    {
      audio: { ...audio, source: { artifactId: 'audio-1', type: 'artifact' as const } },
      code: 'openai_transcription_audio_not_materialized',
      options: {},
    },
    {
      audio: { ...audio, source: { bytes: new Uint8Array(), type: 'bytes' as const } },
      code: 'openai_transcription_audio_empty',
      options: {},
    },
    {
      audio: { ...audio, source: { bytes: new Uint8Array([1, 2]), type: 'bytes' as const } },
      code: 'openai_transcription_audio_too_large',
      options: { maxInputBytes: 1 },
    },
    {
      audio: { ...audio, mimeType: 'audio/unknown' },
      code: 'openai_transcription_mime_type_unsupported',
      options: {},
    },
  ])('rejects invalid audio before transport', async (fixture) => {
    const transport = transcriptionTransport([]);
    const provider = new OpenAITranscriptionProvider(fixture.options, { transport });

    await expect(collect(provider.transcribe({ audio: fixture.audio }))).rejects.toMatchObject({
      code: fixture.code,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it.each([
    {
      code: 'openai_transcription_delta_empty',
      events: [{ delta: '', type: 'text_delta' as const }],
    },
    {
      code: 'openai_transcription_completion_missing',
      events: [{ delta: 'partial', type: 'text_delta' as const }],
    },
    {
      code: 'openai_transcription_event_after_completion',
      events: [
        { text: 'done', type: 'completed' as const },
        { delta: 'late', type: 'text_delta' as const },
      ],
    },
  ])('rejects malformed transport event sequences', async (fixture) => {
    const provider = new OpenAITranscriptionProvider(
      {},
      { transport: transcriptionTransport(fixture.events) },
    );

    await expect(collect(provider.transcribe({ audio }))).rejects.toMatchObject({
      category: 'malformed_response',
      code: fixture.code,
    });
  });

  it('validates constructor and request settings', async () => {
    expect(
      () =>
        new OpenAITranscriptionProvider(
          { maxInputBytes: 25 * 1_024 * 1_024 + 1 },
          { transport: transcriptionTransport([]) },
        ),
    ).toThrow(expect.objectContaining({ code: 'openai_transcription_byte_limit_invalid' }));
    const provider = new OpenAITranscriptionProvider({}, { transport: transcriptionTransport([]) });
    await expect(
      collect(provider.transcribe({ audio, language: 'english' })),
    ).rejects.toMatchObject({ code: 'openai_transcription_language_invalid' });
  });
});

describe('OpenAISpeechSynthesisProvider', () => {
  it('maps request overrides, returns playable bytes, and records deterministic usage', async () => {
    const transport = speechTransport();
    const provider = new OpenAISpeechSynthesisProvider(
      {
        instructions: 'Default style',
        model: 'gpt-4o-mini-tts',
        outputMimeType: 'audio/mpeg',
        speed: 1,
        voice: 'alloy',
      },
      { transport },
    );
    const signal = new AbortController().signal;

    const result = await provider.synthesize(
      {
        instructions: 'Sound excited',
        outputMimeType: 'audio/wav',
        speed: 1.25,
        text: 'Hello commander.',
        voice: 'nova',
      },
      { signal },
    );

    expect(transport.requests).toEqual([
      {
        format: 'wav',
        instructions: 'Sound excited',
        model: 'gpt-4o-mini-tts',
        speed: 1.25,
        text: 'Hello commander.',
        voice: 'nova',
      },
    ]);
    expect(transport.options).toEqual([{ signal }]);
    expect(result).toEqual({
      audio: {
        mimeType: 'audio/wav',
        source: { bytes: new Uint8Array([8, 9]), type: 'bytes' },
        type: 'audio',
      },
      providerMetadata: {
        format: 'wav',
        model: 'gpt-4o-mini-tts',
        requestId: 'speech-request-1',
        voice: 'nova',
      },
      usage: { characters: 16 },
    });
  });

  it('uses safe defaults and maps opus aliases', async () => {
    const transport = speechTransport();
    const provider = new OpenAISpeechSynthesisProvider({}, { transport });

    await provider.synthesize({ outputMimeType: 'audio/ogg', text: 'Hi' });

    expect(transport.requests).toEqual([
      {
        format: 'opus',
        model: 'gpt-4o-mini-tts',
        text: 'Hi',
        voice: 'alloy',
      },
    ]);
  });

  it.each([
    { code: 'openai_audio_text_empty', request: { text: ' ' } },
    { code: 'openai_speech_speed_invalid', request: { speed: 4.1, text: 'Hi' } },
    {
      code: 'openai_speech_mime_type_unsupported',
      request: { outputMimeType: 'audio/webm', text: 'Hi' },
    },
    { code: 'openai_speech_input_too_long', request: { text: 'a'.repeat(4_097) } },
  ])('rejects invalid speech requests before transport', async (fixture) => {
    const transport = speechTransport();
    const provider = new OpenAISpeechSynthesisProvider({}, { transport });

    await expect(provider.synthesize(fixture.request)).rejects.toMatchObject({
      code: fixture.code,
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('rejects empty provider audio as malformed', async () => {
    const provider = new OpenAISpeechSynthesisProvider(
      {},
      { transport: speechTransport(new Uint8Array()) },
    );

    await expect(provider.synthesize({ text: 'Hi' })).rejects.toMatchObject({
      category: 'malformed_response',
      code: 'openai_speech_audio_empty',
    });
  });
});

async function* iterate<T>(values: readonly T[]): AsyncGenerator<T> {
  for (const value of values) {
    await Promise.resolve();
    yield value;
  }
}

import { AiError, type AudioPart, type SpeechSynthesis } from '@maduser/ai-ts';
import { describe, expect, it } from 'vitest';

import {
  exerciseSpeechSynthesisProvider,
  exerciseTranscriptionProvider,
  ScriptedSpeechSynthesisProvider,
  ScriptedTranscriptionProvider,
} from '../src/index.js';

const audio: AudioPart = {
  mimeType: 'audio/webm',
  source: { bytes: new Uint8Array([1]), type: 'bytes' },
  type: 'audio',
};

const synthesis: SpeechSynthesis = {
  audio: {
    mimeType: 'audio/mpeg',
    source: { bytes: new Uint8Array([2]), type: 'bytes' },
    type: 'audio',
  },
  usage: { characters: 5 },
};

describe('voice provider conformance fixtures', () => {
  it('exercises and records a valid transcription protocol', async () => {
    const provider = new ScriptedTranscriptionProvider([
      {
        events: [
          { delta: 'Hel', type: 'transcription.text.delta' },
          {
            transcription: { text: 'Hello', usage: { audioInputMs: 100 } },
            type: 'transcription.completed',
          },
        ],
        type: 'transcribe',
      },
    ]);
    const signal = new AbortController().signal;

    await expect(
      exerciseTranscriptionProvider(provider, { audio, language: 'en' }, { signal }),
    ).resolves.toEqual({
      deltas: ['Hel'],
      transcription: { text: 'Hello', usage: { audioInputMs: 100 } },
    });
    expect(provider.requests).toEqual([{ audio, language: 'en' }]);
    expect(provider.options).toEqual([{ signal }]);
    expect(provider.remainingSteps).toBe(0);
  });

  it.each([
    {
      events: [{ delta: '', type: 'transcription.text.delta' as const }],
      violation: 'transcription_delta_empty',
    },
    {
      events: [
        {
          transcription: { text: ' ', usage: {} },
          type: 'transcription.completed' as const,
        },
      ],
      violation: 'transcription_text_empty',
    },
    {
      events: [{ delta: 'partial', type: 'transcription.text.delta' as const }],
      violation: 'transcription_completion_missing',
    },
    {
      events: [
        {
          transcription: { text: 'done', usage: {} },
          type: 'transcription.completed' as const,
        },
        { delta: 'late', type: 'transcription.text.delta' as const },
      ],
      violation: 'transcription_event_after_completion',
    },
  ])('identifies transcription protocol violations', async (fixture) => {
    const provider = new ScriptedTranscriptionProvider([
      { events: fixture.events, type: 'transcribe' },
    ]);

    await expect(exerciseTranscriptionProvider(provider, { audio })).rejects.toMatchObject({
      code: 'voice_provider_conformance_failed',
      details: { violation: fixture.violation },
    });
  });

  it('exercises and records a valid speech result', async () => {
    const provider = new ScriptedSpeechSynthesisProvider([{ synthesis, type: 'synthesize' }]);

    await expect(
      exerciseSpeechSynthesisProvider(provider, { text: 'Hello', voice: 'nova' }),
    ).resolves.toBe(synthesis);
    expect(provider.requests).toEqual([{ text: 'Hello', voice: 'nova' }]);
    expect(provider.remainingSteps).toBe(0);
  });

  it.each([
    {
      synthesis: { ...synthesis, audio: { ...synthesis.audio, mimeType: ' ' } },
      violation: 'speech_mime_type_empty',
    },
    {
      synthesis: {
        ...synthesis,
        audio: {
          ...synthesis.audio,
          source: { bytes: new Uint8Array(), type: 'bytes' as const },
        },
      },
      violation: 'speech_audio_empty',
    },
  ])('identifies speech protocol violations', async (fixture) => {
    const provider = new ScriptedSpeechSynthesisProvider([
      { synthesis: fixture.synthesis, type: 'synthesize' },
    ]);

    await expect(
      exerciseSpeechSynthesisProvider(provider, { text: 'Hello' }),
    ).rejects.toMatchObject({
      code: 'voice_provider_conformance_failed',
      details: { violation: fixture.violation },
    });
  });

  it('supports scripted provider failures, exhaustion, and cancellation', async () => {
    const error = new AiError('provider_unavailable', 'Unavailable.', { code: 'unavailable' });
    const failedTranscription = new ScriptedTranscriptionProvider([{ error, type: 'throw' }]);
    const failedSpeech = new ScriptedSpeechSynthesisProvider([{ error, type: 'throw' }]);
    await expect(exerciseTranscriptionProvider(failedTranscription, { audio })).rejects.toBe(error);
    await expect(failedSpeech.synthesize({ text: 'Hello' })).rejects.toBe(error);

    await expect(
      exerciseTranscriptionProvider(new ScriptedTranscriptionProvider([]), { audio }),
    ).rejects.toMatchObject({ code: 'voice_script_exhausted' });
    await expect(
      new ScriptedSpeechSynthesisProvider([]).synthesize({ text: 'Hello' }),
    ).rejects.toMatchObject({ code: 'voice_script_exhausted' });

    const controller = new AbortController();
    controller.abort();
    await expect(
      exerciseTranscriptionProvider(
        new ScriptedTranscriptionProvider([{ events: [], type: 'transcribe' }]),
        { audio },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    await expect(
      Promise.resolve().then(() =>
        new ScriptedSpeechSynthesisProvider([{ synthesis, type: 'synthesize' }]).synthesize(
          { text: 'Hello' },
          { signal: controller.signal },
        ),
      ),
    ).rejects.toThrow();
  });
});

import {
  AiError,
  type SpeechSynthesis,
  type SpeechSynthesisProvider,
  type SpeechSynthesisRequest,
  type Transcription,
  type TranscriptionEvent,
  type TranscriptionProvider,
  type TranscriptionRequest,
  type VoiceOperationOptions,
} from '@maduser/ai-ts';

export interface TranscriptionConformanceResult {
  readonly deltas: readonly string[];
  readonly transcription: Transcription;
}

/** Consumes one provider call and verifies the portable transcription event protocol. */
export async function exerciseTranscriptionProvider(
  provider: TranscriptionProvider,
  request: TranscriptionRequest,
  options: VoiceOperationOptions = {},
): Promise<TranscriptionConformanceResult> {
  const deltas: string[] = [];
  let transcription: Transcription | undefined;
  for await (const event of provider.transcribe(request, options)) {
    if (transcription !== undefined) {
      throw conformanceError(
        'Transcription emitted an event after completion.',
        'transcription_event_after_completion',
      );
    }
    if (event.type === 'transcription.text.delta') {
      if (event.delta.length === 0) {
        throw conformanceError(
          'Transcription emitted an empty delta.',
          'transcription_delta_empty',
        );
      }
      deltas.push(event.delta);
    } else {
      if (event.transcription.text.trim().length === 0) {
        throw conformanceError(
          'Transcription completed with empty text.',
          'transcription_text_empty',
        );
      }
      transcription = event.transcription;
    }
  }
  if (transcription === undefined) {
    throw conformanceError(
      'Transcription ended without completion.',
      'transcription_completion_missing',
    );
  }
  return { deltas, transcription };
}

/** Executes one speech call and verifies the portable synthesized-audio contract. */
export async function exerciseSpeechSynthesisProvider(
  provider: SpeechSynthesisProvider,
  request: SpeechSynthesisRequest,
  options: VoiceOperationOptions = {},
): Promise<SpeechSynthesis> {
  const synthesis = await provider.synthesize(request, options);
  if (synthesis.audio.mimeType.trim().length === 0) {
    throw conformanceError('Speech synthesis returned no MIME type.', 'speech_mime_type_empty');
  }
  if (synthesis.audio.source.type === 'bytes' && synthesis.audio.source.bytes.byteLength === 0) {
    throw conformanceError('Speech synthesis returned empty bytes.', 'speech_audio_empty');
  }
  return synthesis;
}

export type ScriptedTranscriptionStep =
  | { readonly error: AiError; readonly type: 'throw' }
  | { readonly events: readonly TranscriptionEvent[]; readonly type: 'transcribe' };

/** Deterministic transcription provider for composed-voice and provider tests. */
export class ScriptedTranscriptionProvider implements TranscriptionProvider {
  readonly #options: VoiceOperationOptions[] = [];
  readonly #requests: TranscriptionRequest[] = [];
  readonly #steps: ScriptedTranscriptionStep[];

  public constructor(steps: readonly ScriptedTranscriptionStep[]) {
    this.#steps = [...steps];
  }

  public get options(): readonly VoiceOperationOptions[] {
    return [...this.#options];
  }

  public get remainingSteps(): number {
    return this.#steps.length;
  }

  public get requests(): readonly TranscriptionRequest[] {
    return [...this.#requests];
  }

  public async *transcribe(
    request: TranscriptionRequest,
    options: VoiceOperationOptions = {},
  ): AsyncGenerator<TranscriptionEvent> {
    options.signal?.throwIfAborted();
    this.#requests.push(request);
    this.#options.push(options);
    const step = this.#steps.shift();
    if (step === undefined) {
      throw scriptExhausted('transcription');
    }
    if (step.type === 'throw') {
      throw step.error;
    }
    for (const event of step.events) {
      await Promise.resolve();
      options.signal?.throwIfAborted();
      yield event;
    }
  }
}

export type ScriptedSpeechSynthesisStep =
  | { readonly error: AiError; readonly type: 'throw' }
  | { readonly synthesis: SpeechSynthesis; readonly type: 'synthesize' };

/** Deterministic speech-synthesis provider for composed-voice and provider tests. */
export class ScriptedSpeechSynthesisProvider implements SpeechSynthesisProvider {
  readonly #options: VoiceOperationOptions[] = [];
  readonly #requests: SpeechSynthesisRequest[] = [];
  readonly #steps: ScriptedSpeechSynthesisStep[];

  public constructor(steps: readonly ScriptedSpeechSynthesisStep[]) {
    this.#steps = [...steps];
  }

  public get options(): readonly VoiceOperationOptions[] {
    return [...this.#options];
  }

  public get remainingSteps(): number {
    return this.#steps.length;
  }

  public get requests(): readonly SpeechSynthesisRequest[] {
    return [...this.#requests];
  }

  public synthesize(
    request: SpeechSynthesisRequest,
    options: VoiceOperationOptions = {},
  ): Promise<SpeechSynthesis> {
    options.signal?.throwIfAborted();
    this.#requests.push(request);
    this.#options.push(options);
    const step = this.#steps.shift();
    if (step === undefined) {
      return Promise.reject(scriptExhausted('speech synthesis'));
    }
    return step.type === 'throw' ? Promise.reject(step.error) : Promise.resolve(step.synthesis);
  }
}

function conformanceError(message: string, violation: string): AiError {
  return new AiError('malformed_response', message, {
    code: 'voice_provider_conformance_failed',
    details: { violation },
  });
}

function scriptExhausted(operation: string): AiError {
  return new AiError('malformed_response', `No scripted ${operation} step remains.`, {
    code: 'voice_script_exhausted',
    details: { operation },
  });
}

import type { AgentRunOptions, AgentRunRequest, AgentResult } from './agent-types.js';
import type { ArtifactStore } from './artifact-store.js';
import type { AudioPart, ContentPart } from './content.js';
import { AiError, serializeAiError, type SerializedAiError } from './error.js';
import type { RunEvent, TerminalRunEvent } from './run-event.js';
import { addUsage, type Usage } from './usage.js';
import type {
  ComposedVoiceTurnRequest,
  ComposedVoiceTurnResult,
  SpeechSynthesis,
  SpeechSynthesisProvider,
  TerminalVoiceTurnEvent,
  Transcription,
  TranscriptionEvent,
  TranscriptionProvider,
  VoiceRetentionOptions,
  VoiceTurnTimings,
  VoiceTurnEvent,
  VoiceTurnEventBase,
} from './voice-types.js';

export interface AgentRunStream {
  stream(request: AgentRunRequest, options?: AgentRunOptions): AsyncIterable<RunEvent>;
}

export interface ComposedVoiceRuntimeOptions {
  readonly agent: AgentRunStream;
  readonly artifacts?: ArtifactStore;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly monotonicClock?: () => number;
  readonly retention?: Partial<VoiceRetentionOptions>;
  readonly synthesizer?: SpeechSynthesisProvider;
  readonly transcriber: TranscriptionProvider;
}

const defaultRetention: VoiceRetentionOptions = { inputAudio: false, outputAudio: false };

/** Runs transcription, a bounded agent turn, and synthesis in one canonical conversation. */
export class ComposedVoiceRuntime {
  readonly #agent: AgentRunStream;
  readonly #artifacts: ArtifactStore | undefined;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #monotonicClock: () => number;
  readonly #retention: VoiceRetentionOptions;
  readonly #synthesizer: SpeechSynthesisProvider | undefined;
  readonly #transcriber: TranscriptionProvider;

  public constructor(options: ComposedVoiceRuntimeOptions) {
    this.#agent = options.agent;
    this.#artifacts = options.artifacts;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#monotonicClock = options.monotonicClock ?? (() => globalThis.performance.now());
    this.#retention = { ...defaultRetention, ...options.retention };
    this.#synthesizer = options.synthesizer;
    this.#transcriber = options.transcriber;
    if (
      (this.#retention.inputAudio || this.#retention.outputAudio) &&
      this.#artifacts === undefined
    ) {
      throw new AiError('invalid_request', 'Voice audio retention requires an artifact store.', {
        code: 'voice_artifact_store_required',
      });
    }
  }

  public async run(
    request: ComposedVoiceTurnRequest,
    options: AgentRunOptions = {},
  ): Promise<ComposedVoiceTurnResult> {
    let terminal: TerminalVoiceTurnEvent | undefined;
    for await (const event of this.stream(request, options)) {
      if (event.type === 'voice.turn.completed' || event.type === 'voice.turn.failed') {
        terminal = event;
      }
    }
    if (terminal === undefined) {
      throw new AiError('malformed_response', 'The voice turn ended without a terminal event.', {
        code: 'voice_terminal_event_missing',
      });
    }
    return terminal.result;
  }

  public async *stream(
    request: ComposedVoiceTurnRequest,
    options: AgentRunOptions = {},
  ): AsyncGenerator<VoiceTurnEvent, void, void> {
    const turnId = this.#idGenerator();
    const events = new VoiceEventSequencer(turnId, this.#clock, this.#idGenerator);
    const timings = new VoiceTimingRecorder(this.#monotonicClock);
    let transcription: Transcription | undefined;
    let inputAudioArtifactId: string | undefined;
    let agentResult: AgentResult | undefined;
    let usage: Usage = {};

    yield { ...events.next(), type: 'voice.turn.started' };

    timings.start('transcription');
    try {
      for await (const event of this.#transcriber.transcribe(
        {
          audio: request.audio,
          ...(request.language === undefined ? {} : { language: request.language }),
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
        },
        options,
      )) {
        if (transcription !== undefined) {
          throw malformedTranscription('The transcription provider emitted data after completion.');
        }
        if (event.type === 'transcription.text.delta') {
          validateDelta(event);
          yield { ...events.next(), delta: event.delta, type: 'voice.transcript.delta' };
        } else {
          transcription = validateTranscription(event.transcription);
          usage = addUsage(usage, transcription.usage);
          yield {
            ...events.next(),
            latencyMs: timings.finish('transcription'),
            transcription,
            type: 'voice.transcript.completed',
          };
        }
      }
      if (transcription === undefined) {
        throw malformedTranscription('The transcription provider did not complete.');
      }
    } catch (error) {
      timings.finishIfStarted('transcription');
      const normalized = normalizeVoiceError(error, 'transcription');
      yield failedEvent(events, {
        error: serializeAiError(normalized),
        status: 'transcription_failed',
        timings: timings.snapshot(),
        turnId,
        usage,
      });
      return;
    }

    if (this.#retention.inputAudio) {
      timings.start('inputPersistence');
    }
    try {
      inputAudioArtifactId = await this.#retainAudio(
        request.audio,
        'voice_input',
        turnId,
        options.signal,
      );
      timings.finishIfStarted('inputPersistence');
    } catch (error) {
      timings.finishIfStarted('inputPersistence');
      const normalized = normalizeVoiceError(error, 'persistence');
      yield failedEvent(events, {
        error: serializeAiError(normalized),
        status: 'persistence_failed',
        timings: timings.snapshot(),
        transcription,
        turnId,
        usage,
      });
      return;
    }

    let terminalRun: TerminalRunEvent | undefined;
    timings.start('agent');
    try {
      for await (const event of this.#agent.stream(agentRequest(request, transcription), options)) {
        if (terminalRun !== undefined) {
          throw new AiError(
            'malformed_response',
            'The agent emitted data after its terminal result.',
            {
              code: 'voice_agent_event_after_terminal',
            },
          );
        }
        if (isTerminalRunEvent(event)) {
          terminalRun = event;
        }
        yield { ...events.next(), event, type: 'voice.agent.event' };
      }
      if (terminalRun === undefined) {
        throw new AiError('malformed_response', 'The agent emitted no terminal result.', {
          code: 'voice_agent_terminal_missing',
        });
      }
      agentResult = terminalRun.result;
      usage = addUsage(usage, agentResult.usage);
      timings.finish('agent');
    } catch (error) {
      timings.finishIfStarted('agent');
      const normalized = normalizeVoiceError(error, 'agent');
      yield failedEvent(events, {
        error: serializeAiError(normalized),
        ...(inputAudioArtifactId === undefined ? {} : { inputAudioArtifactId }),
        status: 'agent_failed',
        timings: timings.snapshot(),
        transcription,
        turnId,
        usage,
      });
      return;
    }

    if (agentResult.status !== 'completed' || agentResult.output === undefined) {
      const error =
        agentResult.error ??
        serializeAiError(
          new AiError('provider_unavailable', 'The agent did not complete the voice turn.', {
            code: 'voice_agent_failed',
          }),
        );
      yield failedEvent(events, {
        agentResult,
        error,
        ...(inputAudioArtifactId === undefined ? {} : { inputAudioArtifactId }),
        status: 'agent_failed',
        timings: timings.snapshot(),
        transcription,
        turnId,
        usage,
      });
      return;
    }

    const assistantTranscript = displayText(agentResult.output.content);
    if (assistantTranscript.length === 0) {
      const error = serializeAiError(
        new AiError('malformed_response', 'The agent completed without displayable text.', {
          code: 'voice_assistant_transcript_missing',
        }),
      );
      yield failedEvent(events, {
        agentResult,
        error,
        ...(inputAudioArtifactId === undefined ? {} : { inputAudioArtifactId }),
        status: 'agent_failed',
        timings: timings.snapshot(),
        transcription,
        turnId,
        usage,
      });
      return;
    }

    if (request.synthesis === false || this.#synthesizer === undefined) {
      yield {
        ...events.next(),
        result: {
          agentResult,
          assistantTranscript,
          ...(inputAudioArtifactId === undefined ? {} : { inputAudioArtifactId }),
          status: 'completed',
          timings: timings.snapshot(),
          transcription,
          turnId,
          usage,
        },
        type: 'voice.turn.completed',
      };
      return;
    }

    let synthesis: SpeechSynthesis;
    let synthesisLatencyMs: number;
    timings.start('synthesis');
    try {
      synthesis = await this.#synthesizer.synthesize(
        {
          text: assistantTranscript,
          ...(request.synthesis?.instructions === undefined
            ? {}
            : { instructions: request.synthesis.instructions }),
          ...(request.synthesis?.outputMimeType === undefined
            ? {}
            : { outputMimeType: request.synthesis.outputMimeType }),
          ...(request.synthesis?.speed === undefined ? {} : { speed: request.synthesis.speed }),
          ...(request.synthesis?.voice === undefined ? {} : { voice: request.synthesis.voice }),
        },
        options,
      );
      validateSynthesis(synthesis);
      usage = addUsage(usage, synthesis.usage);
      synthesisLatencyMs = timings.finish('synthesis');
    } catch (error) {
      timings.finishIfStarted('synthesis');
      const normalized = normalizeVoiceError(error, 'synthesis');
      yield failedEvent(events, {
        agentResult,
        assistantTranscript,
        error: serializeAiError(normalized),
        ...(inputAudioArtifactId === undefined ? {} : { inputAudioArtifactId }),
        status: 'synthesis_failed',
        timings: timings.snapshot(),
        transcription,
        turnId,
        usage,
      });
      return;
    }

    let outputAudioArtifactId: string | undefined;
    if (this.#retention.outputAudio) {
      timings.start('outputPersistence');
    }
    try {
      outputAudioArtifactId = await this.#retainAudio(
        synthesis.audio,
        'voice_output',
        turnId,
        options.signal,
      );
      timings.finishIfStarted('outputPersistence');
    } catch (error) {
      timings.finishIfStarted('outputPersistence');
      const normalized = normalizeVoiceError(error, 'persistence');
      yield failedEvent(events, {
        agentResult,
        assistantTranscript,
        error: serializeAiError(normalized),
        ...(inputAudioArtifactId === undefined ? {} : { inputAudioArtifactId }),
        status: 'persistence_failed',
        synthesis,
        timings: timings.snapshot(),
        transcription,
        turnId,
        usage,
      });
      return;
    }

    yield {
      ...events.next(),
      ...(outputAudioArtifactId === undefined ? {} : { artifactId: outputAudioArtifactId }),
      ...(synthesis.audio.durationMs === undefined
        ? {}
        : { durationMs: synthesis.audio.durationMs }),
      latencyMs: synthesisLatencyMs,
      mimeType: synthesis.audio.mimeType,
      type: 'voice.synthesis.completed',
    };
    yield {
      ...events.next(),
      result: {
        agentResult,
        assistantTranscript,
        ...(inputAudioArtifactId === undefined ? {} : { inputAudioArtifactId }),
        ...(outputAudioArtifactId === undefined ? {} : { outputAudioArtifactId }),
        status: 'completed',
        synthesis,
        timings: timings.snapshot(),
        transcription,
        turnId,
        usage,
      },
      type: 'voice.turn.completed',
    };
  }

  async #retainAudio(
    audio: AudioPart,
    kind: 'voice_input' | 'voice_output',
    turnId: string,
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const enabled =
      kind === 'voice_input' ? this.#retention.inputAudio : this.#retention.outputAudio;
    if (!enabled) {
      return undefined;
    }
    if (audio.source.type === 'artifact') {
      return audio.source.artifactId;
    }
    if (audio.source.type !== 'bytes') {
      throw new AiError(
        'invalid_request',
        'Retained voice audio must be materialized as bytes or an artifact.',
        {
          code: 'voice_audio_not_materialized',
          details: { kind, sourceType: audio.source.type },
        },
      );
    }
    const artifact = await this.#artifacts?.put(
      {
        metadata: { kind, turnId },
        mimeType: audio.mimeType,
        source: audio.source.bytes,
      },
      signal === undefined ? {} : { signal },
    );
    if (artifact === undefined) {
      throw new AiError('persistence_conflict', 'The voice artifact store was unavailable.', {
        code: 'voice_artifact_store_unavailable',
      });
    }
    return artifact.id;
  }
}

function agentRequest(
  request: ComposedVoiceTurnRequest,
  transcription: Transcription,
): AgentRunRequest {
  return {
    agent: request.agent,
    ...(request.context === undefined ? {} : { context: request.context }),
    ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
    input: [{ source: 'transcribed', text: transcription.text, type: 'text' }],
    ...(request.limits === undefined ? {} : { limits: request.limits }),
  };
}

function validateDelta(
  event: Extract<TranscriptionEvent, { readonly type: 'transcription.text.delta' }>,
): void {
  if (event.delta.length === 0) {
    throw malformedTranscription('Transcription deltas cannot be empty.');
  }
}

function validateTranscription(value: Transcription): Transcription {
  if (value.text.trim().length === 0) {
    throw new AiError('invalid_request', 'The completed transcription is empty.', {
      code: 'voice_transcription_empty',
    });
  }
  return value;
}

function validateSynthesis(value: SpeechSynthesis): void {
  if (value.audio.mimeType.trim().length === 0) {
    throw new AiError('malformed_response', 'Speech synthesis returned an empty MIME type.', {
      code: 'voice_synthesis_mime_type_empty',
    });
  }
  if (value.audio.source.type === 'bytes' && value.audio.source.bytes.byteLength === 0) {
    throw new AiError('malformed_response', 'Speech synthesis returned empty audio.', {
      code: 'voice_synthesis_audio_empty',
    });
  }
}

function displayText(content: readonly ContentPart[]): string {
  return content
    .flatMap((part) => {
      if (part.type === 'text') {
        return [part.text];
      }
      if (part.type === 'refusal') {
        return [part.reason];
      }
      return [];
    })
    .join('\n')
    .trim();
}

function isTerminalRunEvent(event: RunEvent): event is TerminalRunEvent {
  return (
    event.type === 'run.completed' ||
    event.type === 'run.failed' ||
    event.type === 'run.cancelled' ||
    event.type === 'run.limit_exceeded'
  );
}

function failedEvent(
  events: VoiceEventSequencer,
  result: ComposedVoiceTurnResult & { readonly error: SerializedAiError },
): VoiceTurnEvent {
  return {
    ...events.next(),
    error: result.error,
    result,
    type: 'voice.turn.failed',
  };
}

function malformedTranscription(message: string): AiError {
  return new AiError('malformed_response', message, {
    code: 'voice_transcription_event_sequence_invalid',
  });
}

function normalizeVoiceError(error: unknown, stage: string): AiError {
  return error instanceof AiError
    ? error
    : new AiError('transport', `The voice ${stage} stage failed.`, {
        cause: error,
        code: `voice_${stage}_failed`,
      });
}

class VoiceEventSequencer {
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #turnId: string;
  #sequence = 0;

  public constructor(turnId: string, clock: () => Date, idGenerator: () => string) {
    this.#clock = clock;
    this.#idGenerator = idGenerator;
    this.#turnId = turnId;
  }

  public next(): VoiceTurnEventBase {
    const event = {
      eventId: this.#idGenerator(),
      occurredAt: this.#clock().toISOString(),
      sequence: this.#sequence,
      turnId: this.#turnId,
    };
    this.#sequence += 1;
    return event;
  }
}

type VoiceTimingStage =
  'agent' | 'inputPersistence' | 'outputPersistence' | 'synthesis' | 'transcription';

class VoiceTimingRecorder {
  readonly #durations = new Map<VoiceTimingStage, number>();
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #stageStarts = new Map<VoiceTimingStage, number>();

  public constructor(now: () => number) {
    this.#now = now;
    this.#startedAt = this.#readTime();
  }

  public start(stage: VoiceTimingStage): void {
    if (this.#stageStarts.has(stage) || this.#durations.has(stage)) {
      throw new AiError('invalid_request', `Voice timing stage ${stage} started twice.`, {
        code: 'voice_timing_stage_invalid',
      });
    }
    this.#stageStarts.set(stage, this.#readTime());
  }

  public finish(stage: VoiceTimingStage): number {
    const startedAt = this.#stageStarts.get(stage);
    if (startedAt === undefined) {
      throw new AiError('invalid_request', `Voice timing stage ${stage} was not started.`, {
        code: 'voice_timing_stage_invalid',
      });
    }
    const duration = Math.max(0, this.#readTime() - startedAt);
    this.#stageStarts.delete(stage);
    this.#durations.set(stage, duration);
    return duration;
  }

  public finishIfStarted(stage: VoiceTimingStage): void {
    if (this.#stageStarts.has(stage)) {
      this.finish(stage);
    }
  }

  public snapshot(): VoiceTurnTimings {
    const agentMs = this.#durations.get('agent');
    const inputPersistenceMs = this.#durations.get('inputPersistence');
    const outputPersistenceMs = this.#durations.get('outputPersistence');
    const synthesisMs = this.#durations.get('synthesis');
    const transcriptionMs = this.#durations.get('transcription');
    return {
      ...(agentMs === undefined ? {} : { agentMs }),
      ...(inputPersistenceMs === undefined ? {} : { inputPersistenceMs }),
      ...(outputPersistenceMs === undefined ? {} : { outputPersistenceMs }),
      ...(synthesisMs === undefined ? {} : { synthesisMs }),
      totalMs: Math.max(0, this.#readTime() - this.#startedAt),
      ...(transcriptionMs === undefined ? {} : { transcriptionMs }),
    };
  }

  #readTime(): number {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      throw new AiError('invalid_request', 'Voice monotonic clock returned an invalid value.', {
        code: 'voice_monotonic_clock_invalid',
      });
    }
    return value;
  }
}

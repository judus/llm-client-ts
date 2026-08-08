import { describe, expect, it, vi } from 'vitest';

import {
  AiClient,
  BoundedAgentRuntime,
  ComposedVoiceRuntime,
  InMemoryArtifactStore,
  InMemoryConversationStore,
  type AgentDefinition,
  type AgentRunRequest,
  type AgentRunStream,
  type AgentResult,
  type AiError,
  type AudioPart,
  type CallOptions,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type RunEvent,
  type SpeechSynthesisProvider,
  type TranscriptionEvent,
  type TranscriptionProvider,
  type VoiceTurnEvent,
} from '../src/index.js';

const agent: AgentDefinition = {
  id: 'voice-assistant',
  model: { model: 'test-model', provider: 'scripted' },
};

const inputAudio: AudioPart = {
  mimeType: 'audio/webm',
  source: { bytes: new Uint8Array([1, 2, 3]), type: 'bytes' },
  type: 'audio',
};

class ScriptedTranscriber implements TranscriptionProvider {
  public readonly calls: { readonly options?: unknown; readonly request: unknown }[] = [];
  readonly #events: readonly TranscriptionEvent[];
  readonly #failure: Error | undefined;

  public constructor(events: readonly TranscriptionEvent[], failure?: Error) {
    this.#events = events;
    this.#failure = failure;
  }

  public async *transcribe(
    request: unknown,
    options?: unknown,
  ): AsyncGenerator<TranscriptionEvent> {
    await Promise.resolve();
    this.calls.push({ ...(options === undefined ? {} : { options }), request });
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    yield* this.#events;
  }
}

function completedTranscription(text = 'What is the answer?'): TranscriptionEvent {
  return {
    transcription: { language: 'en', text, usage: { audioInputMs: 1_200 } },
    type: 'transcription.completed',
  };
}

class ScriptedAgent implements AgentRunStream {
  public readonly requests: AgentRunRequest[] = [];
  readonly #events: readonly RunEvent[];

  public constructor(events: readonly RunEvent[]) {
    this.#events = events;
  }

  public async *stream(request: AgentRunRequest): AsyncGenerator<RunEvent> {
    await Promise.resolve();
    this.requests.push(request);
    yield* this.#events;
  }
}

function completedResult(text = 'The answer is 42.'): AgentResult {
  return {
    conversationId: 'conversation-1',
    messages: [],
    modelSteps: 1,
    output: {
      content: [{ source: 'generated', text, type: 'text' }],
      conversationId: 'conversation-1',
      createdAt: '2026-08-08T12:00:00.000Z',
      id: 'assistant-message',
      role: 'assistant',
    },
    runId: 'agent-run',
    status: 'completed',
    toolCalls: 0,
    usage: { inputTokens: 5, outputTokens: 4 },
  };
}

function completedRunEvent(result = completedResult()): RunEvent {
  return {
    eventId: 'agent-event',
    occurredAt: '2026-08-08T12:00:00.000Z',
    result,
    runId: result.runId,
    sequence: 0,
    type: 'run.completed',
  };
}

async function collect(stream: AsyncIterable<VoiceTurnEvent>): Promise<VoiceTurnEvent[]> {
  const events: VoiceTurnEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('ComposedVoiceRuntime', () => {
  it('orchestrates transcription, the canonical agent turn, synthesis, and bounded retention', async () => {
    const transcriber = new ScriptedTranscriber([
      { delta: 'What is ', type: 'transcription.text.delta' },
      { delta: 'the answer?', type: 'transcription.text.delta' },
      completedTranscription(),
    ]);
    const scriptedAgent = new ScriptedAgent([completedRunEvent()]);
    const synthesize = vi.fn(() =>
      Promise.resolve({
        audio: {
          durationMs: 900,
          mimeType: 'audio/mpeg',
          source: { bytes: new Uint8Array([4, 5]), type: 'bytes' as const },
          type: 'audio' as const,
        },
        usage: { audioOutputMs: 900, characters: 17 },
      }),
    );
    const synthesizer: SpeechSynthesisProvider = { synthesize };
    let artifactSequence = 0;
    const artifacts = new InMemoryArtifactStore({
      idGenerator: () => `artifact-${String(artifactSequence++)}`,
    });
    let voiceSequence = 0;
    const runtime = new ComposedVoiceRuntime({
      agent: scriptedAgent,
      artifacts,
      clock: () => new Date('2026-08-08T12:00:00.000Z'),
      idGenerator: () => `voice-${String(voiceSequence++)}`,
      retention: { inputAudio: true, outputAudio: true },
      synthesizer,
      transcriber,
    });

    const events = await collect(
      runtime.stream({
        agent,
        audio: inputAudio,
        context: { commander: 'Ada' },
        conversationId: 'conversation-1',
        language: 'en',
        prompt: 'Elite Dangerous vocabulary',
        synthesis: { outputMimeType: 'audio/mpeg', speed: 1.1, voice: 'nova' },
      }),
    );

    expect(events.map(({ type }) => type)).toEqual([
      'voice.turn.started',
      'voice.transcript.delta',
      'voice.transcript.delta',
      'voice.transcript.completed',
      'voice.agent.event',
      'voice.synthesis.completed',
      'voice.turn.completed',
    ]);
    expect(events.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(scriptedAgent.requests).toEqual([
      {
        agent,
        context: { commander: 'Ada' },
        conversationId: 'conversation-1',
        input: [{ source: 'transcribed', text: 'What is the answer?', type: 'text' }],
      },
    ]);
    expect(synthesize).toHaveBeenCalledWith(
      {
        outputMimeType: 'audio/mpeg',
        speed: 1.1,
        text: 'The answer is 42.',
        voice: 'nova',
      },
      {},
    );
    const synthesisEvent = events.at(-2);
    expect(synthesisEvent).toMatchObject({
      artifactId: 'artifact-1',
      durationMs: 900,
      mimeType: 'audio/mpeg',
      type: 'voice.synthesis.completed',
    });
    expect(synthesisEvent).not.toHaveProperty('audio');
    expect(events.at(-1)).toMatchObject({
      result: {
        assistantTranscript: 'The answer is 42.',
        inputAudioArtifactId: 'artifact-0',
        outputAudioArtifactId: 'artifact-1',
        status: 'completed',
        usage: {
          audioInputMs: 1_200,
          audioOutputMs: 900,
          characters: 17,
          inputTokens: 5,
          outputTokens: 4,
        },
      },
      type: 'voice.turn.completed',
    });
    await expect(artifacts.get('artifact-0')).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
      metadata: { kind: 'voice_input', turnId: 'voice-0' },
    });
    await expect(artifacts.get('artifact-1')).resolves.toMatchObject({
      bytes: new Uint8Array([4, 5]),
      metadata: { kind: 'voice_output', turnId: 'voice-0' },
    });
  });

  it('persists a voice transcript in the same conversation consumed by a later typed turn', async () => {
    const conversations = new InMemoryConversationStore();
    const provider = new QueueProvider(['Voice answer.', 'Typed answer.']);
    let id = 0;
    const boundedAgent = new BoundedAgentRuntime({
      client: new AiClient(provider),
      conversations,
      idGenerator: () => `id-${String(id++)}`,
    });
    const runtime = new ComposedVoiceRuntime({
      agent: boundedAgent,
      transcriber: new ScriptedTranscriber([completedTranscription('Voice question.')]),
    });

    const voiceResult = await runtime.run({
      agent,
      audio: inputAudio,
      conversationId: 'shared-conversation',
      synthesis: false,
    });
    await boundedAgent.run({
      agent,
      conversationId: 'shared-conversation',
      input: [{ source: 'typed', text: 'Follow-up question.', type: 'text' }],
    });

    expect(voiceResult).toMatchObject({
      assistantTranscript: 'Voice answer.',
      status: 'completed',
    });
    expect(provider.requests[0]?.messages.at(-1)?.content).toEqual([
      { source: 'transcribed', text: 'Voice question.', type: 'text' },
    ]);
    expect(provider.requests[1]?.messages.map(({ content }) => content)).toEqual([
      [{ source: 'transcribed', text: 'Voice question.', type: 'text' }],
      [{ source: 'generated', text: 'Voice answer.', type: 'text' }],
      [{ source: 'typed', text: 'Follow-up question.', type: 'text' }],
    ]);
    await expect(conversations.listMessages('shared-conversation')).resolves.toHaveLength(4);
  });

  it('supports transcript-only completion when synthesis is disabled', async () => {
    const runtime = new ComposedVoiceRuntime({
      agent: new ScriptedAgent([completedRunEvent()]),
      synthesizer: { synthesize: vi.fn() },
      transcriber: new ScriptedTranscriber([completedTranscription()]),
    });

    await expect(
      runtime.run({ agent, audio: inputAudio, synthesis: false }),
    ).resolves.toMatchObject({
      assistantTranscript: 'The answer is 42.',
      status: 'completed',
    });
  });

  it.each<{ readonly events: readonly TranscriptionEvent[]; readonly expectedCode: string }>([
    { events: [], expectedCode: 'voice_transcription_event_sequence_invalid' },
    {
      events: [completedTranscription(), { delta: 'late', type: 'transcription.text.delta' }],
      expectedCode: 'voice_transcription_event_sequence_invalid',
    },
    {
      events: [{ delta: '', type: 'transcription.text.delta' }],
      expectedCode: 'voice_transcription_event_sequence_invalid',
    },
    {
      events: [completedTranscription('   ')],
      expectedCode: 'voice_transcription_empty',
    },
  ])('normalizes invalid transcription protocols into a terminal failure', async (fixture) => {
    const runtime = new ComposedVoiceRuntime({
      agent: new ScriptedAgent([]),
      transcriber: new ScriptedTranscriber(fixture.events),
    });

    const result = await runtime.run({ agent, audio: inputAudio });

    expect(result).toMatchObject({
      error: { code: fixture.expectedCode },
      status: 'transcription_failed',
    });
  });

  it('normalizes thrown transcription failures without invoking the agent', async () => {
    const scriptedAgent = new ScriptedAgent([]);
    const runtime = new ComposedVoiceRuntime({
      agent: scriptedAgent,
      transcriber: new ScriptedTranscriber([], new Error('socket closed')),
    });

    await expect(runtime.run({ agent, audio: inputAudio })).resolves.toMatchObject({
      error: { category: 'transport', code: 'voice_transcription_failed' },
      status: 'transcription_failed',
    });
    expect(scriptedAgent.requests).toHaveLength(0);
  });

  it('preserves the completed agent result when synthesis fails', async () => {
    const runtime = new ComposedVoiceRuntime({
      agent: new ScriptedAgent([completedRunEvent()]),
      synthesizer: {
        synthesize: () => Promise.reject(new Error('speaker unavailable')),
      },
      transcriber: new ScriptedTranscriber([completedTranscription()]),
    });

    await expect(runtime.run({ agent, audio: inputAudio })).resolves.toMatchObject({
      agentResult: { status: 'completed' },
      assistantTranscript: 'The answer is 42.',
      error: { category: 'transport', code: 'voice_synthesis_failed' },
      status: 'synthesis_failed',
      transcription: { text: 'What is the answer?' },
    });
  });

  it('fails safely when audio retention is requested without materialized audio', async () => {
    const artifacts = new InMemoryArtifactStore();
    const runtime = new ComposedVoiceRuntime({
      agent: new ScriptedAgent([completedRunEvent()]),
      artifacts,
      retention: { inputAudio: true },
      transcriber: new ScriptedTranscriber([completedTranscription()]),
    });

    const result = await runtime.run({
      agent,
      audio: {
        mimeType: 'audio/webm',
        source: { type: 'url', url: 'https://example.test/input.webm' },
        type: 'audio',
      },
    });

    expect(result).toMatchObject({
      error: { code: 'voice_audio_not_materialized' },
      status: 'persistence_failed',
      transcription: { text: 'What is the answer?' },
    });
  });

  it('requires an artifact store when either retention policy is enabled', () => {
    expect(
      () =>
        new ComposedVoiceRuntime({
          agent: new ScriptedAgent([]),
          retention: { outputAudio: true },
          transcriber: new ScriptedTranscriber([]),
        }),
    ).toThrow(expect.objectContaining<Partial<AiError>>({ code: 'voice_artifact_store_required' }));
  });

  it('reports malformed agent and synthesis outputs as stage-specific failures', async () => {
    const noTerminal = new ComposedVoiceRuntime({
      agent: new ScriptedAgent([]),
      transcriber: new ScriptedTranscriber([completedTranscription()]),
    });
    const emptyAudio = new ComposedVoiceRuntime({
      agent: new ScriptedAgent([completedRunEvent()]),
      synthesizer: {
        synthesize: () =>
          Promise.resolve({
            audio: {
              mimeType: 'audio/mpeg',
              source: { bytes: new Uint8Array(), type: 'bytes' },
              type: 'audio',
            },
            usage: {},
          }),
      },
      transcriber: new ScriptedTranscriber([completedTranscription()]),
    });

    await expect(noTerminal.run({ agent, audio: inputAudio })).resolves.toMatchObject({
      error: { code: 'voice_agent_terminal_missing' },
      status: 'agent_failed',
    });
    await expect(emptyAudio.run({ agent, audio: inputAudio })).resolves.toMatchObject({
      error: { code: 'voice_synthesis_audio_empty' },
      status: 'synthesis_failed',
    });
  });
});

const capabilities: ModelCapabilities = {
  input: { audio: false, documents: false, images: false, text: true },
  output: { audio: false, structured: true, text: true },
  realtime: false,
  speechSynthesis: false,
  streaming: false,
  tools: { calls: false, parallelCalls: false, strictSchemas: false },
  transcription: false,
};

class QueueProvider implements ModelProvider {
  public readonly id = 'scripted';
  public readonly requests: ModelRequest[] = [];
  readonly #responses: string[];

  public constructor(responses: readonly string[]) {
    this.#responses = [...responses];
  }

  public capabilities(): Promise<ModelCapabilities> {
    return Promise.resolve(capabilities);
  }

  public generate(request: ModelRequest, options?: CallOptions): Promise<ModelResponse> {
    options?.signal?.throwIfAborted();
    this.requests.push(request);
    const text = this.#responses.shift();
    if (text === undefined) {
      return Promise.reject(new Error('Script exhausted.'));
    }
    return Promise.resolve({
      finishReason: 'stop',
      id: `response-${String(this.requests.length)}`,
      message: {
        content: [{ source: 'generated', text, type: 'text' }],
        conversationId: 'provider-conversation',
        createdAt: '2026-08-08T12:00:00.000Z',
        id: `provider-message-${String(this.requests.length)}`,
        role: 'assistant',
      },
      model: { model: 'test-model', provider: 'scripted' },
      usage: { inputTokens: 2, outputTokens: 2 },
    });
  }

  public async *stream(): AsyncGenerator<ModelStreamEvent> {
    yield await Promise.reject(new Error('Streaming is not used by this provider.'));
  }
}

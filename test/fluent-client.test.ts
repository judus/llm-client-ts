import { describe, expect, it, vi } from 'vitest';

import {
  createAiClient,
  InMemoryConversationStore,
  type AiChat,
  type AiStreamEvent,
  type ConfiguredProvider,
  type ConversationMessage,
  type ModelCapabilities,
  type ModelResponse,
  type ModelStreamEvent,
  type SerializedAiError,
  type SpeechSynthesisProvider,
  type ToolCall,
  type TranscriptionProvider,
} from '../src/index.js';
import { ScriptedProvider } from '../src/testing/index.js';

describe('createAiClient', () => {
  it('runs a direct text turn through the fluent API', async () => {
    const provider = configuredProvider([
      { response: response('chat-1', 'answer-1', text('Hello back.')), type: 'generate' },
    ]);
    const ai = createAiClient({ provider });

    const result = await ai.chat('chat-1').user('Hello.').run();

    expect(result).toMatchObject({
      chatId: 'chat-1',
      text: 'Hello back.',
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    expect(provider.requests[0]?.messages[0]?.content).toEqual([
      { source: 'typed', text: 'Hello.', type: 'text' },
    ]);
  });

  it('supports independent generated chat IDs and constructor instructions', async () => {
    const provider = configuredProvider([
      { response: response('provider-chat', 'answer', text('Done.')), type: 'generate' },
    ]);
    const result = await createAiClient({ instructions: 'Be concise.', provider })
      .user('Hello.')
      .run();

    expect(result.chatId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(provider.requests[0]?.messages.map(({ role }) => role)).toEqual(['developer', 'user']);
  });

  it('streams text deltas and persists the completed response', async () => {
    const repository = new InMemoryConversationStore();
    const finalResponse = response('streamed', 'answer', text('Hello back.'));
    const provider = configuredProvider([
      {
        events: [
          streamEvent(0, { type: 'model.request.started' }),
          streamEvent(1, { delta: 'Hello ', outputIndex: 0, type: 'model.text.delta' }),
          streamEvent(2, { delta: 'back.', outputIndex: 0, type: 'model.text.delta' }),
          streamEvent(3, { response: finalResponse, type: 'model.response.completed' }),
        ],
        type: 'stream',
      },
    ]);
    const events = [];
    for await (const event of createAiClient({ history: { repository }, provider })
      .chat('streamed')
      .user('Hello.')
      .stream()) {
      events.push(event);
    }

    expect(events.map(({ type }) => type)).toEqual([
      'run.started',
      'text.delta',
      'text.delta',
      'run.completed',
    ]);
    expect(events.filter(isTextDelta).map(({ delta }) => delta)).toEqual(['Hello ', 'back.']);
    await expect(repository.snapshot('streamed')).resolves.toMatchObject({
      messages: [{ role: 'user' }, { role: 'assistant' }],
    });
  });

  it('falls back to buffered generation after an abruptly ended stream', async () => {
    const repository = new InMemoryConversationStore();
    const finalResponse = response('retry-stream', 'answer', text('Complete answer.'));
    const provider = configuredProvider([
      {
        events: [
          streamEvent(0, { type: 'model.request.started' }),
          streamEvent(1, { delta: 'Partial ', outputIndex: 0, type: 'model.text.delta' }),
        ],
        type: 'stream',
      },
      {
        response: finalResponse,
        type: 'generate',
      },
    ]);
    const events = [];
    for await (const event of createAiClient({ history: { repository }, provider })
      .chat('retry-stream')
      .user('Retry this.')
      .stream()) {
      events.push(event);
    }

    expect(events.map(({ type }) => type)).toEqual([
      'run.started',
      'text.delta',
      'text.reset',
      'run.retrying',
      'text.delta',
      'run.completed',
    ]);
    expect(events.filter(isTextDelta).map(({ delta }) => delta)).toEqual([
      'Partial ',
      'Complete answer.',
    ]);
    await expect(repository.snapshot('retry-stream')).resolves.toMatchObject({
      messages: [{ role: 'user' }, { content: text('Complete answer.'), role: 'assistant' }],
    });
  });

  it('retries an empty abrupt stream without emitting a text reset', async () => {
    const provider = configuredProvider([
      {
        events: [streamEvent(0, { type: 'model.request.started' })],
        type: 'stream',
      },
      {
        response: response('empty-retry-stream', 'answer', []),
        type: 'generate',
      },
    ]);

    const events = await collectEvents(
      createAiClient({ provider }).chat('empty-retry-stream').user('Retry.').stream(),
    );

    expect(events.map(({ type }) => type)).toEqual([
      'run.started',
      'run.retrying',
      'run.completed',
    ]);
  });

  it('preserves a provider stream failure instead of reporting a missing response', async () => {
    const provider = configuredProvider([
      {
        events: [
          streamEvent(0, { type: 'model.request.started' }),
          streamEvent(1, {
            error: {
              category: 'invalid_request',
              code: 'invalid_tool_schema',
              message: 'The tool schema is invalid.',
              retryable: false,
            },
            type: 'model.response.failed',
          }),
        ],
        type: 'stream',
      },
    ]);

    await expect(
      collectEvents(createAiClient({ provider }).chat('failed-stream').user('Hello.').stream()),
    ).rejects.toMatchObject({
      category: 'invalid_request',
      code: 'invalid_tool_schema',
      message: 'The tool schema is invalid.',
    });
  });

  it('streams transcribed input and synthesizes the completed answer', async () => {
    const transcribe = vi.fn<TranscriptionProvider['transcribe']>(async function* () {
      await Promise.resolve();
      yield {
        transcription: { text: 'Report.', usage: { audioInputTokens: 4 } },
        type: 'transcription.completed',
      };
    });
    const synthesize = vi.fn<SpeechSynthesisProvider['synthesize']>(async () => {
      await Promise.resolve();
      return {
        audio: {
          mimeType: 'audio/mpeg',
          source: { bytes: new Uint8Array([1]), type: 'bytes' },
          type: 'audio',
        },
        usage: { characters: 6 },
      };
    });
    const finalResponse = response('voice-stream', 'answer', text('Clear.'));
    const provider = configuredProvider(
      [
        {
          events: [
            streamEvent(0, { type: 'model.request.started' }),
            streamEvent(1, { delta: 'Clear.', outputIndex: 0, type: 'model.text.delta' }),
            streamEvent(2, { response: finalResponse, type: 'model.response.completed' }),
          ],
          type: 'stream',
        },
      ],
      capabilities(),
      { speechSynthesis: { synthesize }, transcription: { transcribe } },
    );

    const events = [];
    const signal = new AbortController().signal;
    for await (const event of createAiClient({ provider })
      .chat('voice-stream')
      .audio({ bytes: new Uint8Array([7]), mimeType: 'audio/webm' })
      .speak({ voice: 'ash' })
      .stream({ signal })) {
      events.push(event);
    }

    expect(events.at(-1)).toMatchObject({
      result: {
        audio: { audio: { mimeType: 'audio/mpeg' } },
        transcript: { text: 'Report.' },
        usage: { audioInputTokens: 4, characters: 6, inputTokens: 2, outputTokens: 3 },
      },
      type: 'run.completed',
    });
    expect(provider.requests[0]?.messages[0]?.content).toEqual([
      { source: 'transcribed', text: 'Report.', type: 'text' },
    ]);
  });

  it('fails clearly when stream media services are unavailable', async () => {
    const noMediaProvider = configuredProvider([]);
    await expect(
      collectEvents(
        createAiClient({ provider: noMediaProvider })
          .audio({ bytes: new Uint8Array([1]), mimeType: 'audio/wav' })
          .stream(),
      ),
    ).rejects.toMatchObject({ category: 'unsupported_capability' });

    const finalResponse = response('speech-stream-missing', 'answer', text('No voice.'));
    const noSpeechProvider = configuredProvider([
      {
        events: [
          streamEvent(0, { type: 'model.request.started' }),
          streamEvent(1, { response: finalResponse, type: 'model.response.completed' }),
        ],
        type: 'stream',
      },
    ]);
    await expect(
      collectEvents(
        createAiClient({ provider: noSpeechProvider })
          .chat('speech-stream-missing')
          .user('Speak.')
          .speak()
          .stream(),
      ),
    ).rejects.toMatchObject({ category: 'unsupported_capability' });
  });

  it('streams MCP calls, results, and the following model answer', async () => {
    const received: string[] = [];
    const toolCall: ToolCall = {
      arguments: { system: 'Sol' },
      id: 'call-stream',
      name: 'elite__lookup',
    };
    const toolResponse = response(
      'tool-stream',
      'tool-call',
      [
        {
          arguments: toolCall.arguments,
          callId: toolCall.id,
          name: toolCall.name,
          type: 'tool_call',
        },
      ],
      'tool_calls',
    );
    const finalResponse = response('tool-stream', 'answer', text('Sol found.'));
    const provider = configuredProvider(
      [
        {
          events: [
            streamEvent(0, { type: 'model.request.started' }),
            streamEvent(1, { toolCall, type: 'model.tool_call.completed' }),
            streamEvent(2, { response: toolResponse, type: 'model.response.completed' }),
          ],
          type: 'stream',
        },
        {
          events: [
            streamEvent(0, { type: 'model.request.started' }),
            streamEvent(1, { delta: 'Sol found.', outputIndex: 0, type: 'model.text.delta' }),
            streamEvent(2, { response: finalResponse, type: 'model.response.completed' }),
          ],
          type: 'stream',
        },
      ],
      capabilities({ tools: true }),
    );

    const events = [];
    for await (const event of createAiClient({
      mcp: [{ fetch: mcpFetchFixture(received), name: 'elite', url: 'https://mcp.test/mcp' }],
      provider,
    })
      .chat('tool-stream')
      .user('Find Sol.')
      .stream()) {
      events.push(event);
    }

    expect(events.map(({ type }) => type)).toEqual([
      'run.started',
      'tool.call',
      'tool.result',
      'text.delta',
      'run.completed',
    ]);
    expect(received).toContain('tools/call');
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool' });
  });

  it('supports request-local MCP overrides and every document source', async () => {
    const provider = configuredProvider(
      [{ response: response('sources', 'answer', text('Read.')), type: 'generate' }],
      capabilities({ documents: true }),
    );
    const request = createAiClient({ mcp: ['https://unused.test/mcp'], provider })
      .chat('sources')
      .user('Read these.')
      .addMcp([])
      .mcp([])
      .tools([])
      .document({ filename: 'remote.txt', mimeType: 'text/plain', url: 'https://example.test/a' })
      .document({
        fileId: 'file-1',
        mimeType: 'application/pdf',
        provider: 'scripted',
        title: 'Uploaded',
      });

    await request.run();
    await expect(request.run()).rejects.toMatchObject({ code: 'request_already_started' });
    expect(provider.requests[0]?.messages[0]?.content).toEqual([
      { source: 'typed', text: 'Read these.', type: 'text' },
      {
        filename: 'remote.txt',
        mimeType: 'text/plain',
        source: { type: 'url', url: 'https://example.test/a' },
        type: 'document',
      },
      {
        mimeType: 'application/pdf',
        source: { fileId: 'file-1', provider: 'scripted', type: 'provider_file' },
        title: 'Uploaded',
        type: 'document',
      },
    ]);
  });

  it('validates client, text, audio, and document builder input', () => {
    const provider = configuredProvider([]);
    expect(() => createAiClient({ maxToolSteps: 0, provider })).toThrow(
      expect.objectContaining({ code: 'invalid_positive_integer' }),
    );
    expect(() => createAiClient({ provider, toolTimeoutMs: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'invalid_positive_integer' }),
    );
    expect(() => createAiClient({ instructions: ' ', provider })).toThrow(
      expect.objectContaining({ code: 'empty_value' }),
    );
    const blankModel = Object.assign(new ScriptedProvider([]), { model: ' ' });
    expect(() => createAiClient({ provider: blankModel })).toThrow(
      expect.objectContaining({ code: 'empty_value' }),
    );
    const ai = createAiClient({ provider });
    expect(() => ai.chat(' ')).toThrow(expect.objectContaining({ code: 'empty_value' }));
    expect(() => ai.user(' ')).toThrow(expect.objectContaining({ code: 'empty_value' }));
    expect(() => ai.audio({ bytes: new Uint8Array(), mimeType: 'audio/wav' })).toThrow(
      expect.objectContaining({ code: 'audio_input_empty' }),
    );
    expect(() => ai.audio({ bytes: new Uint8Array([1]), mimeType: ' ' })).toThrow(
      expect.objectContaining({ code: 'empty_value' }),
    );
    const turn = ai.user('test');
    expect(() =>
      turn.document({ bytes: new Uint8Array(), filename: 'empty.txt', mimeType: 'text/plain' }),
    ).toThrow(expect.objectContaining({ code: 'document_input_empty' }));
    expect(() =>
      turn.document({ fileId: ' ', mimeType: 'text/plain', provider: 'scripted' }),
    ).toThrow(expect.objectContaining({ code: 'empty_value' }));
    expect(() => turn.tools([' '])).toThrow(expect.objectContaining({ code: 'empty_value' }));
  });

  it('fails clearly when configured media services are unavailable or malformed', async () => {
    const provider = configuredProvider([
      { response: response('speech-missing', 'answer', text('No voice.')), type: 'generate' },
    ]);
    await expect(
      createAiClient({ provider })
        .chat('transcription-missing')
        .audio({ bytes: new Uint8Array([1]), mimeType: 'audio/wav' })
        .run(),
    ).rejects.toMatchObject({ category: 'unsupported_capability' });
    await expect(
      createAiClient({ provider }).chat('speech-missing').user('Speak.').speak().run(),
    ).rejects.toMatchObject({ category: 'unsupported_capability' });

    const transcription: TranscriptionProvider = {
      transcribe: async function* () {
        await Promise.resolve();
        yield { delta: 'partial', type: 'transcription.text.delta' };
      },
    };
    await expect(
      createAiClient({ provider: Object.assign(provider, { transcription }) })
        .audio({ bytes: new Uint8Array([1]), mimeType: 'audio/wav' })
        .run(),
    ).rejects.toMatchObject({ code: 'transcription_completion_missing' });
  });

  it('loads and appends repository-backed chat history', async () => {
    const repository = new InMemoryConversationStore();
    const provider = configuredProvider([
      { response: response('remembered', 'answer-1', text('Sol is a star.')), type: 'generate' },
      {
        response: response('remembered', 'answer-2', text('It is in the Bubble.')),
        type: 'generate',
      },
    ]);
    const chat = createAiClient({ history: { repository }, provider }).chat('remembered');

    await chat.user('What is Sol?').run();
    await chat.user('Where is it?').run();

    expect(provider.requests[1]?.messages.map(({ role }) => role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    await expect(repository.snapshot('remembered')).resolves.toMatchObject({
      conversation: { revision: 2 },
      messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }],
    });
  });

  it('creates a rolling summary when stored history crosses the token trigger', async () => {
    const repository = new InMemoryConversationStore();
    await repository.create({ id: 'compressed' });
    await repository.append(
      'compressed',
      [
        storedMessage('compressed', 'old-user', 'user', `Question ${'x'.repeat(180)}`),
        storedMessage('compressed', 'old-answer', 'assistant', `Answer ${'y'.repeat(180)}`),
        storedMessage('compressed', 'recent-user', 'user', 'Remember Sol.'),
        storedMessage('compressed', 'recent-answer', 'assistant', 'Sol remembered.'),
      ],
      { expectedRevision: 0 },
    );
    const provider = configuredProvider([
      {
        response: response('compressed', 'summary', text('The user discussed Sol.')),
        type: 'generate',
      },
      {
        response: response('compressed', 'answer', text('Sol is still remembered.')),
        type: 'generate',
      },
    ]);
    const chat = createAiClient({
      history: {
        maxContextTokens: 400,
        repository,
        reserveOutputTokens: 40,
        reserveToolResultTokens: 40,
      },
      provider,
    }).chat('compressed');

    const result = await chat.user('What did we discuss?').run();

    expect(provider.requests).toHaveLength(2);
    const summaryPart = provider.requests[1]?.messages
      .flatMap(({ content }) => content)
      .find((part) => part.type === 'text' && part.source === 'summarized');
    expect(summaryPart).toMatchObject({ source: 'summarized', type: 'text' });
    expect(summaryPart?.type === 'text' ? summaryPart.text : undefined).toContain('Sol');
    expect(result.usage).toEqual({ inputTokens: 4, outputTokens: 6 });
    const snapshot = await repository.snapshot('compressed');
    expect(snapshot?.messages).toHaveLength(7);
    expect(snapshot?.messages[4]).toMatchObject({
      metadata: { historySummary: { sourceMessagesRetained: true } },
      role: 'developer',
    });
  });

  it('validates compression capacity, windows, and generated summary content', async () => {
    const emptyRepository = new InMemoryConversationStore();
    await expect(
      createAiClient({
        history: {
          maxContextTokens: 100,
          repository: emptyRepository,
          reserveOutputTokens: 60,
          reserveToolResultTokens: 60,
        },
        provider: configuredProvider([]),
      })
        .chat('no-capacity')
        .user('Hello.')
        .run(),
    ).rejects.toMatchObject({ code: 'history_context_capacity_empty' });

    const invalidWindowRepository = await repositoryWithLongHistory('invalid-window');
    await expect(
      createAiClient({
        history: {
          compression: { keepRecentTokens: 320, triggerTokens: 1 },
          maxContextTokens: 400,
          repository: invalidWindowRepository,
          reserveOutputTokens: 40,
          reserveToolResultTokens: 40,
        },
        provider: configuredProvider([]),
      })
        .chat('invalid-window')
        .user('Continue.')
        .run(),
    ).rejects.toMatchObject({ code: 'history_compression_window_invalid' });

    const toolSummaryRepository = await repositoryWithLongHistory('tool-summary');
    const toolSummaryProvider = configuredProvider(
      [
        {
          response: response(
            'tool-summary',
            'summary',
            [{ arguments: {}, callId: 'summary-call', name: 'unexpected', type: 'tool_call' }],
            'tool_calls',
          ),
          type: 'generate',
        },
      ],
      capabilities({ tools: true }),
    );
    await expect(
      compressedChat(toolSummaryRepository, toolSummaryProvider, 'tool-summary')
        .user('Continue.')
        .run(),
    ).rejects.toMatchObject({ code: 'history_summary_tool_call' });

    const emptySummaryRepository = await repositoryWithLongHistory('empty-summary');
    const emptySummaryProvider = configuredProvider([
      { response: response('empty-summary', 'summary', []), type: 'generate' },
    ]);
    await expect(
      compressedChat(emptySummaryRepository, emptySummaryProvider, 'empty-summary')
        .user('Continue.')
        .run(),
    ).rejects.toMatchObject({ code: 'history_summary_empty' });
  });

  it('uses only the latest rolling summary and messages appended after it', async () => {
    const repository = new InMemoryConversationStore();
    await repository.create({ id: 'existing-summary' });
    await repository.append(
      'existing-summary',
      [
        storedMessage('existing-summary', 'raw-old', 'user', 'Old raw message.'),
        {
          ...storedMessage('existing-summary', 'summary-old', 'assistant', 'Old summary.'),
          metadata: {
            historySummary: { lastSourceMessageId: 'raw-old', sourceMessagesRetained: true },
          },
          role: 'developer',
        },
        {
          content: [{ source: 'typed', text: 'Not a summary marker.', type: 'text' }],
          conversationId: 'existing-summary',
          createdAt: '2026-08-08T09:00:00.000Z',
          id: 'invalid-summary-marker',
          metadata: { historySummary: [] },
          role: 'developer',
        },
        storedMessage('existing-summary', 'new-user', 'user', 'New fact.'),
        storedMessage('existing-summary', 'new-answer', 'assistant', 'New fact retained.'),
      ],
      { expectedRevision: 0 },
    );
    const provider = configuredProvider([
      { response: response('existing-summary', 'answer', text('Continued.')), type: 'generate' },
    ]);

    await createAiClient({
      history: { compression: false, maxContextTokens: 10_000, repository },
      provider,
    })
      .chat('existing-summary')
      .user('Continue.')
      .run();

    const requestIds = provider.requests[0]?.messages.map(({ id }) => id) ?? [];
    expect(requestIds).not.toContain('raw-old');
    expect(requestIds).toContain('summary-old');
    expect(requestIds).toContain('new-user');
    expect(requestIds).toContain('new-answer');
  });

  it('attaches document bytes to the user turn', async () => {
    const provider = configuredProvider(
      [
        {
          response: response('documents', 'answer', text('The document says hi.')),
          type: 'generate',
        },
      ],
      capabilities({ documents: true }),
    );

    await createAiClient({ provider })
      .chat('documents')
      .user('Summarize this.')
      .document({
        bytes: new TextEncoder().encode('hello'),
        filename: 'note.txt',
        mimeType: 'text/plain',
      })
      .run();

    expect(provider.requests[0]?.messages[0]?.content).toEqual([
      { source: 'typed', text: 'Summarize this.', type: 'text' },
      {
        filename: 'note.txt',
        mimeType: 'text/plain',
        source: { bytes: new Uint8Array([104, 101, 108, 108, 111]), type: 'bytes' },
        type: 'document',
      },
    ]);
  });

  it('transcribes audio, stores the transcript, and optionally synthesizes the answer', async () => {
    const transcribe = vi.fn<TranscriptionProvider['transcribe']>(async function* () {
      await Promise.resolve();
      yield {
        transcription: { text: 'Where is Sol?', usage: { audioInputTokens: 5 } },
        type: 'transcription.completed',
      };
    });
    const synthesize = vi.fn<SpeechSynthesisProvider['synthesize']>(async () => {
      await Promise.resolve();
      return {
        audio: {
          mimeType: 'audio/mpeg',
          source: { bytes: new Uint8Array([1, 2]), type: 'bytes' },
          type: 'audio',
        },
        usage: { characters: 12 },
      };
    });
    const provider = configuredProvider(
      [{ response: response('voice', 'answer', text('In the Bubble.')), type: 'generate' }],
      capabilities(),
      { speechSynthesis: { synthesize }, transcription: { transcribe } },
    );

    const result = await createAiClient({ provider })
      .chat('voice')
      .audio({ bytes: new Uint8Array([7, 8]), mimeType: 'audio/webm' })
      .speak({ voice: 'alloy' })
      .run();

    expect(result).toMatchObject({
      audio: { audio: { mimeType: 'audio/mpeg' } },
      text: 'In the Bubble.',
      transcript: { text: 'Where is Sol?' },
      usage: { audioInputTokens: 5, characters: 12, inputTokens: 2, outputTokens: 3 },
    });
    expect(provider.requests[0]?.messages[0]?.content).toEqual([
      { source: 'transcribed', text: 'Where is Sol?', type: 'text' },
    ]);
  });

  it('discovers an MCP URL, runs an allowed tool, and continues the model turn', async () => {
    const received: string[] = [];
    const fetch = mcpFetchFixture(received);
    const provider = configuredProvider(
      [
        {
          response: response(
            'tools',
            'tool-call',
            [
              {
                arguments: { system: 'Sol' },
                callId: 'call-1',
                name: 'elite__lookup',
                type: 'tool_call',
              },
            ],
            'tool_calls',
          ),
          type: 'generate',
        },
        { response: response('tools', 'answer', text('Sol was found.')), type: 'generate' },
      ],
      capabilities({ tools: true }),
    );

    const result = await createAiClient({
      mcp: [{ fetch, name: 'elite', url: 'https://mcp.test/mcp' }],
      provider,
    })
      .chat('tools')
      .user('Find Sol.')
      .tools(['elite.lookup', 'elite__lookup'])
      .run();

    expect(result.text).toBe('Sol was found.');
    expect(received).toContain('tools/list');
    expect(received).toContain('tools/call');
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      content: [
        {
          callId: 'call-1',
          status: 'success',
          structuredContent: { found: 'Sol' },
          type: 'tool_result',
        },
      ],
      role: 'tool',
    });
  });

  it('rejects an unknown MCP allowlist before model generation', async () => {
    const received: string[] = [];
    const provider = configuredProvider([], capabilities({ tools: true }));
    await expect(
      createAiClient({
        mcp: [{ fetch: mcpFetchFixture(received), name: 'elite', url: 'https://mcp.test/mcp' }],
        provider,
      })
        .user('Find Sol.')
        .tools(['elite.missing'])
        .run(),
    ).rejects.toMatchObject({ code: 'mcp_tool_not_discovered' });
    expect(provider.requests).toHaveLength(0);
  });

  it('returns MCP failures to the model and enforces the tool-step limit', async () => {
    const received: string[] = [];
    const failedProvider = configuredProvider(
      [
        {
          response: response(
            'tool-error',
            'tool-call',
            [
              {
                arguments: { system: 'Sol' },
                callId: 'call-1',
                name: 'elite__lookup',
                type: 'tool_call',
              },
            ],
            'tool_calls',
          ),
          type: 'generate',
        },
        {
          response: response('tool-error', 'answer', text('The lookup failed.')),
          type: 'generate',
        },
      ],
      capabilities({ tools: true }),
    );
    await createAiClient({
      mcp: [
        {
          fetch: mcpFetchFixture(received, {
            content: [{ text: 'failed', type: 'text' }],
            isError: true,
          }),
          name: 'elite',
          url: 'https://mcp.test/mcp',
        },
      ],
      provider: failedProvider,
    })
      .chat('tool-error')
      .user('Try lookup.')
      .run();
    expect(failedProvider.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      error: { code: 'mcp_tool_reported_error' },
      status: 'error',
    });

    const limitedProvider = configuredProvider(
      [
        {
          response: response(
            'tool-limit',
            'tool-call',
            [
              {
                arguments: { system: 'Sol' },
                callId: 'call-2',
                name: 'elite__lookup',
                type: 'tool_call',
              },
            ],
            'tool_calls',
          ),
          type: 'generate',
        },
        {
          response: response(
            'tool-limit',
            'tool-call-again',
            [
              {
                arguments: { system: 'Sol' },
                callId: 'call-3',
                name: 'elite__lookup',
                type: 'tool_call',
              },
            ],
            'tool_calls',
          ),
          type: 'generate',
        },
      ],
      capabilities({ tools: true }),
    );
    await expect(
      createAiClient({
        maxToolSteps: 1,
        mcp: [
          {
            fetch: mcpFetchFixture([], { content: [{ text: 'ok', type: 'text' }] }),
            name: 'elite',
            url: 'https://mcp.test/mcp',
          },
        ],
        provider: limitedProvider,
      })
        .chat('tool-limit')
        .user('Loop.')
        .run(),
    ).rejects.toMatchObject({ code: 'tool_step_limit_exceeded' });
  });
});

function configuredProvider(
  steps: ConstructorParameters<typeof ScriptedProvider>[0],
  modelCapabilities: ModelCapabilities = capabilities(),
  media: Pick<ConfiguredProvider, 'speechSynthesis' | 'transcription'> = {},
): ConfiguredProvider & ScriptedProvider {
  return Object.assign(new ScriptedProvider(steps, { capabilities: modelCapabilities }), {
    model: 'test-model',
    ...media,
  });
}

function capabilities(
  enable: { readonly documents?: boolean; readonly tools?: boolean } = {},
): ModelCapabilities {
  return {
    input: {
      audio: false,
      documents: enable.documents ?? false,
      images: false,
      text: true,
    },
    output: { audio: false, structured: true, text: true },
    realtime: false,
    speechSynthesis: true,
    streaming: true,
    tools: {
      calls: enable.tools ?? false,
      parallelCalls: enable.tools ?? false,
      strictSchemas: enable.tools ?? false,
    },
    transcription: true,
  };
}

function response(
  chatId: string,
  id: string,
  content: ConversationMessage['content'],
  finishReason: 'stop' | 'tool_calls' = 'stop',
): ModelResponse {
  return {
    finishReason,
    id: `response-${id}`,
    message: {
      content,
      conversationId: chatId,
      createdAt: '2026-08-08T10:00:00.000Z',
      id: `message-${id}`,
      role: 'assistant',
    },
    model: { model: 'test-model', provider: 'scripted' },
    usage: { inputTokens: 2, outputTokens: 3 },
  };
}

function text(value: string): ConversationMessage['content'] {
  return [{ source: 'generated', text: value, type: 'text' }];
}

type StreamEventPayload =
  | { readonly type: 'model.request.started' }
  | { readonly delta: string; readonly outputIndex: number; readonly type: 'model.text.delta' }
  | { readonly error: SerializedAiError; readonly type: 'model.response.failed' }
  | { readonly toolCall: ToolCall; readonly type: 'model.tool_call.completed' }
  | { readonly response: ModelResponse; readonly type: 'model.response.completed' };

function streamEvent(sequence: number, payload: StreamEventPayload): ModelStreamEvent {
  return {
    eventId: `event-${String(sequence)}`,
    occurredAt: '2026-08-08T10:00:00.000Z',
    requestId: 'stream-request',
    sequence,
    ...payload,
  };
}

function isTextDelta(
  event: AiStreamEvent,
): event is { readonly delta: string; readonly type: 'text.delta' } {
  return event.type === 'text.delta';
}

async function collectEvents(events: AsyncIterable<AiStreamEvent>): Promise<AiStreamEvent[]> {
  const collected: AiStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function storedMessage(
  chatId: string,
  id: string,
  role: 'assistant' | 'user',
  value: string,
): ConversationMessage {
  return {
    content: [{ source: role === 'user' ? 'typed' : 'generated', text: value, type: 'text' }],
    conversationId: chatId,
    createdAt: '2026-08-08T09:00:00.000Z',
    id,
    role,
  };
}

async function repositoryWithLongHistory(chatId: string): Promise<InMemoryConversationStore> {
  const repository = new InMemoryConversationStore();
  await repository.create({ id: chatId });
  await repository.append(
    chatId,
    [
      storedMessage(chatId, `${chatId}-user`, 'user', `Question ${'x'.repeat(240)}`),
      storedMessage(chatId, `${chatId}-answer`, 'assistant', `Answer ${'y'.repeat(240)}`),
    ],
    { expectedRevision: 0 },
  );
  return repository;
}

function compressedChat(
  repository: InMemoryConversationStore,
  provider: ConfiguredProvider,
  chatId: string,
): AiChat {
  return createAiClient({
    history: {
      compression: { keepRecentTokens: 100, triggerTokens: 1 },
      maxContextTokens: 400,
      repository,
      reserveOutputTokens: 40,
      reserveToolResultTokens: 40,
    },
    provider,
  }).chat(chatId);
}

function mcpFetchFixture(received: string[], callResult?: object): typeof globalThis.fetch {
  return async (_input, init) => {
    await Promise.resolve();
    if (init?.method === 'DELETE') {
      return new Response(null, { status: 200 });
    }
    if (typeof init?.body !== 'string') {
      return new Response('invalid', { status: 400 });
    }
    const value: unknown = JSON.parse(init.body);
    if (!isMcpRequest(value)) {
      return new Response('invalid', { status: 400 });
    }
    received.push(value.method);
    if (value.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    const result =
      value.method === 'initialize'
        ? {
            capabilities: { tools: {} },
            protocolVersion: '2025-11-25',
            serverInfo: { name: 'fixture', version: '1' },
          }
        : value.method === 'tools/list'
          ? {
              tools: [
                {
                  description: 'Look up an Elite system.',
                  inputSchema: {
                    additionalProperties: false,
                    properties: { system: { type: 'string' } },
                    required: ['system'],
                    type: 'object',
                  },
                  name: 'lookup',
                },
              ],
            }
          : (callResult ?? {
              content: [{ text: 'found', type: 'text' }],
              structuredContent: { found: 'Sol' },
            });
    return Response.json(
      { id: value.id, jsonrpc: '2.0', result },
      {
        headers: value.method === 'initialize' ? { 'mcp-session-id': 'test-session' } : {},
      },
    );
  };
}

function isMcpRequest(
  value: unknown,
): value is { readonly id?: number | string; readonly method: string } {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'method') === 'string'
  );
}

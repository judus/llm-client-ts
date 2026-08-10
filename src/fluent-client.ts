import type { CallOptions } from './call-options.js';
import type { AudioPart, DocumentPart, ToolResultPart } from './content.js';
import type { ConversationStore } from './conversation-store.js';
import { AiError, UnsupportedCapabilityError } from './error.js';
import type { HostedTool } from './hosted-tool.js';
import type { ConversationMessage } from './message.js';
import type { JsonObject, JsonValue } from './json.js';
import type { FinishReason, ModelResponse } from './model.js';
import type { McpServer } from './mcp-client.js';
import { openMcpServers } from './mcp-client.js';
import type { ConfiguredProvider } from './provider.js';
import { ModelClient } from './client.js';
import { CharacterTokenEstimator, PairSafeHistorySelector } from './context-selection.js';
import { ToolRegistry, type LocalTool, type ToolExecutionOutput } from './tool-registry.js';
import type { ToolCallPart } from './content.js';
import type { ToolCall } from './tool.js';
import { addUsage, type Usage } from './usage.js';
import type { SpeechSynthesis, SpeechSynthesisOptions, Transcription } from './voice-types.js';

export interface AiHistoryOptions {
  /** Automatic rolling-summary settings. Enabled by default when maxContextTokens is set. */
  readonly compression?: false | AiHistoryCompressionOptions;
  /** Maximum request context. When omitted, the complete stored history is sent. */
  readonly maxContextTokens?: number;
  readonly repository: ConversationStore;
  readonly reserveOutputTokens?: number;
  readonly reserveToolResultTokens?: number;
}

export interface AiHistoryCompressionOptions {
  /** Active-history size that triggers a summary. Defaults to 80% of input capacity. */
  readonly triggerTokens?: number;
  /** Recent unsummarized history retained beside the rolling summary. Defaults to 50%. */
  readonly keepRecentTokens?: number;
}

export interface CreateAiClientOptions {
  readonly history?: AiHistoryOptions;
  readonly hostedTools?: readonly HostedTool[];
  readonly instructions?: string;
  readonly maxToolSteps?: number;
  readonly mcp?: readonly McpServer[];
  readonly provider: ConfiguredProvider;
  readonly toolTimeoutMs?: number;
}

export interface AudioInput {
  readonly bytes: Uint8Array;
  readonly channels?: number;
  readonly durationMs?: number;
  readonly language?: string;
  readonly mimeType: string;
  readonly prompt?: string;
  readonly sampleRateHz?: number;
}

export type DocumentInput =
  | {
      readonly bytes: Uint8Array;
      readonly filename: string;
      readonly mimeType: string;
      readonly title?: string;
    }
  | {
      readonly filename?: string;
      readonly mimeType: string;
      readonly title?: string;
      readonly url: string;
    }
  | {
      readonly fileId: string;
      readonly filename?: string;
      readonly mimeType: string;
      readonly provider: string;
      readonly title?: string;
    };

export type AiRunOptions = CallOptions;

export interface AiResult {
  readonly audio?: SpeechSynthesis;
  readonly chatId: string;
  readonly finishReason: FinishReason;
  readonly message: ConversationMessage;
  readonly text: string;
  readonly transcript?: Transcription;
  readonly usage: Usage;
}

/** Progress emitted while a fluent request is running. The completed event carries the persisted result. */
export type AiStreamEvent =
  | { readonly chatId: string; readonly type: 'run.started' }
  | { readonly attempt: number; readonly type: 'run.retrying' }
  | { readonly type: 'text.reset' }
  | { readonly delta: string; readonly type: 'text.delta' }
  | { readonly call: ToolCall; readonly type: 'tool.call' }
  | {
      readonly callId: string;
      readonly status: ToolResultPart['status'];
      readonly type: 'tool.result';
    }
  | { readonly result: AiResult; readonly type: 'run.completed' };

interface ClientDefaults {
  readonly history?: AiHistoryOptions;
  readonly hostedTools: readonly HostedTool[];
  readonly instructions?: string;
  readonly maxToolSteps: number;
  readonly mcp: readonly McpServer[];
  readonly provider: ConfiguredProvider;
  readonly toolTimeoutMs: number;
}

interface RequestState {
  readonly audio?: AudioInput;
  readonly chatId: string;
  readonly documents: DocumentPart[];
  readonly mcp?: readonly McpServer[];
  readonly speak?: SpeechSynthesisOptions;
  readonly text?: string;
  readonly tools?: readonly string[];
}

interface LoadedHistory {
  readonly messages: readonly ConversationMessage[];
  readonly revision?: number;
}

/** Entry point for typed and recorded-voice turns. */
export class AiClient {
  readonly #defaults: ClientDefaults;

  public constructor(options: CreateAiClientOptions) {
    this.#defaults = {
      ...(options.history === undefined ? {} : { history: options.history }),
      hostedTools: [...(options.hostedTools ?? [])],
      ...(options.instructions === undefined
        ? {}
        : { instructions: nonEmpty(options.instructions, 'instructions') }),
      maxToolSteps: positiveInteger(options.maxToolSteps ?? 8, 'maxToolSteps'),
      mcp: [...(options.mcp ?? [])],
      provider: options.provider,
      toolTimeoutMs: positiveInteger(options.toolTimeoutMs ?? 30_000, 'toolTimeoutMs'),
    };
    nonEmpty(options.provider.id, 'provider ID');
    nonEmpty(options.provider.model, 'model');
  }

  public audio(input: AudioInput): AiRequest {
    return new AiRequest(this.#defaults, {
      audio: normalizeAudio(input),
      chatId: globalThis.crypto.randomUUID(),
      documents: [],
    });
  }

  public chat(id: string): AiChat {
    return new AiChat(this.#defaults, nonEmpty(id, 'chat ID'));
  }

  public user(text: string): AiRequest {
    return new AiRequest(this.#defaults, {
      chatId: globalThis.crypto.randomUUID(),
      documents: [],
      text: nonEmpty(text, 'user text'),
    });
  }
}

/** A stable chat identity backed by the configured history repository. */
export class AiChat {
  readonly #chatId: string;
  readonly #defaults: ClientDefaults;

  public constructor(defaults: ClientDefaults, chatId: string) {
    this.#defaults = defaults;
    this.#chatId = chatId;
  }

  public audio(input: AudioInput): AiRequest {
    return new AiRequest(this.#defaults, {
      audio: normalizeAudio(input),
      chatId: this.#chatId,
      documents: [],
    });
  }

  public user(text: string): AiRequest {
    return new AiRequest(this.#defaults, {
      chatId: this.#chatId,
      documents: [],
      text: nonEmpty(text, 'user text'),
    });
  }
}

/** Single-use fluent request builder. */
export class AiRequest {
  readonly #defaults: ClientDefaults;
  #state: RequestState;
  #started = false;

  public constructor(defaults: ClientDefaults, state: RequestState) {
    this.#defaults = defaults;
    this.#state = state;
  }

  public addMcp(servers: readonly McpServer[]): this {
    this.#assertMutable();
    this.#state = {
      ...this.#state,
      mcp: [...(this.#state.mcp ?? this.#defaults.mcp), ...servers],
    };
    return this;
  }

  public document(input: DocumentInput): this {
    this.#assertMutable();
    this.#state.documents.push(normalizeDocument(input));
    return this;
  }

  public mcp(servers: readonly McpServer[]): this {
    this.#assertMutable();
    this.#state = { ...this.#state, mcp: [...servers] };
    return this;
  }

  public speak(options: SpeechSynthesisOptions = {}): this {
    this.#assertMutable();
    this.#state = { ...this.#state, speak: { ...options } };
    return this;
  }

  public tools(names: readonly string[]): this {
    this.#assertMutable();
    this.#state = { ...this.#state, tools: names.map((name) => nonEmpty(name, 'tool name')) };
    return this;
  }

  public async run(options: AiRunOptions = {}): Promise<AiResult> {
    this.#assertMutable();
    this.#started = true;
    options.signal?.throwIfAborted();

    const provider = this.#defaults.provider;
    const modelClient = new ModelClient(provider);
    const history = await loadHistory(this.#defaults.history?.repository, this.#state.chatId);
    let usage: Usage = {};
    let transcript: Transcription | undefined;
    let userText = this.#state.text;

    if (this.#state.audio !== undefined) {
      const transcriber = provider.transcription;
      if (transcriber === undefined)
        throw new UnsupportedCapabilityError('transcription', provider.model);
      transcript = await transcribe(transcriber, this.#state.audio, options.signal);
      usage = addUsage(usage, transcript.usage);
      userText = transcript.text;
    }
    if (userText === undefined) {
      throw new AiError('invalid_request', 'A request requires text or audio input.', {
        code: 'request_input_missing',
      });
    }

    const pending: ConversationMessage[] = [
      message(this.#state.chatId, 'user', [
        {
          source: transcript === undefined ? 'typed' : 'transcribed',
          text: userText,
          type: 'text',
        },
        ...this.#state.documents,
      ]),
    ];
    const preparedHistory = await prepareHistory(
      this.#defaults,
      modelClient,
      history.messages,
      pending,
      this.#state.chatId,
      options,
    );
    usage = addUsage(usage, preparedHistory.usage);
    if (preparedHistory.summary !== undefined) pending.unshift(preparedHistory.summary);
    const mcpServers = this.#state.mcp ?? this.#defaults.mcp;
    const opened =
      mcpServers.length === 0 || this.#state.tools?.length === 0
        ? { close: (): Promise<void> => Promise.resolve(), tools: [] as readonly LocalTool[] }
        : await openMcpServers(mcpServers, options.signal);

    try {
      const registry = toolRegistry(opened.tools, this.#state.tools);
      let finalResponse: ModelResponse | undefined;
      for (let step = 0; step <= this.#defaults.maxToolSteps; step += 1) {
        const context = selectContext(this.#defaults, preparedHistory.messages, pending);
        const response = await modelClient.generate(
          {
            ...(this.#defaults.hostedTools.length === 0
              ? {}
              : { hostedTools: this.#defaults.hostedTools }),
            messages: prependInstructions(context, this.#defaults.instructions, this.#state.chatId),
            model: { model: provider.model, provider: provider.id },
            ...(registry.definitions.length === 0 && this.#defaults.hostedTools.length === 0
              ? {}
              : { toolChoice: { type: 'auto' as const }, tools: registry.definitions }),
          },
          options,
        );
        finalResponse = response;
        usage = addUsage(usage, response.usage);
        pending.push(response.message);
        const calls = toolCalls(response.message);
        if (calls.length === 0) break;
        if (step === this.#defaults.maxToolSteps) {
          throw new AiError('tool_execution', 'The model exceeded the MCP tool-step limit.', {
            code: 'tool_step_limit_exceeded',
            details: { maxToolSteps: this.#defaults.maxToolSteps },
          });
        }
        const results = await Promise.all(
          calls.map(async (call) =>
            executeTool(
              registry,
              call,
              this.#state.chatId,
              this.#defaults.toolTimeoutMs,
              options.signal,
            ),
          ),
        );
        pending.push(message(this.#state.chatId, 'tool', results, response.message.id));
      }
      if (finalResponse === undefined) {
        throw new AiError('malformed_response', 'The model run completed without a response.', {
          code: 'model_response_missing',
        });
      }
      await persistHistory(
        this.#defaults.history?.repository,
        this.#state.chatId,
        pending,
        history.revision,
      );
      const text = assistantText(finalResponse.message);
      let audio: SpeechSynthesis | undefined;
      if (this.#state.speak !== undefined) {
        const synthesizer = provider.speechSynthesis;
        if (synthesizer === undefined)
          throw new UnsupportedCapabilityError('speech synthesis', provider.model);
        audio = await synthesizer.synthesize(
          { text, ...this.#state.speak },
          options.signal === undefined ? {} : { signal: options.signal },
        );
        usage = addUsage(usage, audio.usage);
      }
      return {
        ...(audio === undefined ? {} : { audio }),
        chatId: this.#state.chatId,
        finishReason: finalResponse.finishReason,
        message: finalResponse.message,
        text,
        ...(transcript === undefined ? {} : { transcript }),
        usage,
      };
    } finally {
      await opened.close();
    }
  }

  public async *stream(options: AiRunOptions = {}): AsyncGenerator<AiStreamEvent, void, void> {
    this.#assertMutable();
    this.#started = true;
    options.signal?.throwIfAborted();

    const provider = this.#defaults.provider;
    const modelClient = new ModelClient(provider);
    const history = await loadHistory(this.#defaults.history?.repository, this.#state.chatId);
    let usage: Usage = {};
    let transcript: Transcription | undefined;
    let userText = this.#state.text;

    if (this.#state.audio !== undefined) {
      const transcriber = provider.transcription;
      if (transcriber === undefined) {
        throw new UnsupportedCapabilityError('transcription', provider.model);
      }
      transcript = await transcribe(transcriber, this.#state.audio, options.signal);
      usage = addUsage(usage, transcript.usage);
      userText = transcript.text;
    }
    if (userText === undefined) {
      throw new AiError('invalid_request', 'A request requires text or audio input.', {
        code: 'request_input_missing',
      });
    }

    const pending: ConversationMessage[] = [
      message(this.#state.chatId, 'user', [
        {
          source: transcript === undefined ? 'typed' : 'transcribed',
          text: userText,
          type: 'text',
        },
        ...this.#state.documents,
      ]),
    ];
    const preparedHistory = await prepareHistory(
      this.#defaults,
      modelClient,
      history.messages,
      pending,
      this.#state.chatId,
      options,
    );
    usage = addUsage(usage, preparedHistory.usage);
    if (preparedHistory.summary !== undefined) {
      pending.unshift(preparedHistory.summary);
    }
    const mcpServers = this.#state.mcp ?? this.#defaults.mcp;
    const opened =
      mcpServers.length === 0 || this.#state.tools?.length === 0
        ? { close: (): Promise<void> => Promise.resolve(), tools: [] as readonly LocalTool[] }
        : await openMcpServers(mcpServers, options.signal);

    try {
      yield { chatId: this.#state.chatId, type: 'run.started' };
      const registry = toolRegistry(opened.tools, this.#state.tools);
      let finalResponse: ModelResponse | undefined;
      for (let step = 0; step <= this.#defaults.maxToolSteps; step += 1) {
        const context = selectContext(this.#defaults, preparedHistory.messages, pending);
        const requestMessages = prependInstructions(
          context,
          this.#defaults.instructions,
          this.#state.chatId,
        );
        let response: ModelResponse | undefined;
        const modelRequest = {
          ...(this.#defaults.hostedTools.length === 0
            ? {}
            : { hostedTools: this.#defaults.hostedTools }),
          messages: requestMessages,
          model: { model: provider.model, provider: provider.id },
          ...(registry.definitions.length === 0 && this.#defaults.hostedTools.length === 0
            ? {}
            : { toolChoice: { type: 'auto' as const }, tools: registry.definitions }),
        };
        let emittedText = false;
        try {
          for await (const event of modelClient.stream(modelRequest, options)) {
            if (event.type === 'model.text.delta') {
              emittedText = true;
              yield { delta: event.delta, type: 'text.delta' };
            } else if (event.type === 'model.tool_call.completed') {
              yield { call: event.toolCall, type: 'tool.call' };
            } else if (event.type === 'model.response.completed') {
              response = event.response;
            }
          }
        } catch (error) {
          if (!isAbruptStreamEnd(error)) throw error;
          if (emittedText) yield { type: 'text.reset' };
          yield { attempt: 2, type: 'run.retrying' };
          response = await modelClient.generate(modelRequest, options);
          const fallbackText = assistantText(response.message);
          if (fallbackText.length > 0) yield { delta: fallbackText, type: 'text.delta' };
          for (const call of toolCalls(response.message)) {
            yield {
              call: { arguments: call.arguments, id: call.callId, name: call.name },
              type: 'tool.call',
            };
          }
        }
        if (response === undefined) {
          throw new AiError(
            'malformed_response',
            'The model stream completed without a response.',
            {
              code: 'stream_response_missing',
            },
          );
        }
        finalResponse = response;
        usage = addUsage(usage, response.usage);
        pending.push(response.message);
        const calls = toolCalls(response.message);
        if (calls.length === 0) {
          break;
        }
        if (step === this.#defaults.maxToolSteps) {
          throw new AiError('tool_execution', 'The model exceeded the MCP tool-step limit.', {
            code: 'tool_step_limit_exceeded',
            details: { maxToolSteps: this.#defaults.maxToolSteps },
          });
        }
        const results = await Promise.all(
          calls.map(async (call) =>
            executeTool(
              registry,
              call,
              this.#state.chatId,
              this.#defaults.toolTimeoutMs,
              options.signal,
            ),
          ),
        );
        for (const result of results) {
          yield { callId: result.callId, status: result.status, type: 'tool.result' };
        }
        pending.push(message(this.#state.chatId, 'tool', results, response.message.id));
      }
      if (finalResponse === undefined) {
        throw new AiError('malformed_response', 'The model run completed without a response.', {
          code: 'model_response_missing',
        });
      }

      await persistHistory(
        this.#defaults.history?.repository,
        this.#state.chatId,
        pending,
        history.revision,
      );
      const text = assistantText(finalResponse.message);
      let audio: SpeechSynthesis | undefined;
      if (this.#state.speak !== undefined) {
        const synthesizer = provider.speechSynthesis;
        if (synthesizer === undefined) {
          throw new UnsupportedCapabilityError('speech synthesis', provider.model);
        }
        audio = await synthesizer.synthesize(
          { text, ...this.#state.speak },
          options.signal === undefined ? {} : { signal: options.signal },
        );
        usage = addUsage(usage, audio.usage);
      }
      yield {
        result: {
          ...(audio === undefined ? {} : { audio }),
          chatId: this.#state.chatId,
          finishReason: finalResponse.finishReason,
          message: finalResponse.message,
          text,
          ...(transcript === undefined ? {} : { transcript }),
          usage,
        },
        type: 'run.completed',
      };
    } finally {
      await opened.close();
    }
  }

  #assertMutable(): void {
    if (this.#started) {
      throw new AiError('invalid_request', 'An AI request can only be run once.', {
        code: 'request_already_started',
      });
    }
  }
}

export function createAiClient(options: CreateAiClientOptions): AiClient {
  return new AiClient(options);
}

function isAbruptStreamEnd(error: unknown): boolean {
  return (
    error instanceof AiError &&
    error.code === 'invalid_event_sequence' &&
    error.message === 'The provider stream ended without a terminal event.'
  );
}

function normalizeAudio(input: AudioInput): AudioInput {
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new AiError('invalid_request', 'Audio input must contain bytes.', {
      code: 'audio_input_empty',
    });
  }
  nonEmpty(input.mimeType, 'audio MIME type');
  return { ...input, bytes: input.bytes.slice() };
}

function normalizeDocument(input: DocumentInput): DocumentPart {
  const common = {
    ...(input.filename === undefined ? {} : { filename: nonEmpty(input.filename, 'filename') }),
    mimeType: nonEmpty(input.mimeType, 'document MIME type'),
    ...(input.title === undefined ? {} : { title: nonEmpty(input.title, 'document title') }),
    type: 'document' as const,
  };
  if ('bytes' in input) {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new AiError('invalid_request', 'Document input must contain bytes.', {
        code: 'document_input_empty',
      });
    }
    return { ...common, source: { bytes: input.bytes.slice(), type: 'bytes' } };
  }
  if ('url' in input) {
    return { ...common, source: { type: 'url', url: input.url } };
  }
  return {
    ...common,
    source: {
      fileId: nonEmpty(input.fileId, 'file ID'),
      provider: input.provider,
      type: 'provider_file',
    },
  };
}

async function transcribe(
  provider: NonNullable<ConfiguredProvider['transcription']>,
  input: AudioInput,
  signal?: AbortSignal,
): Promise<Transcription> {
  const audio: AudioPart = {
    ...(input.channels === undefined ? {} : { channels: input.channels }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    mimeType: input.mimeType,
    ...(input.sampleRateHz === undefined ? {} : { sampleRateHz: input.sampleRateHz }),
    source: { bytes: input.bytes, type: 'bytes' },
    type: 'audio',
  };
  let completed: Transcription | undefined;
  for await (const event of provider.transcribe(
    {
      audio,
      ...(input.language === undefined ? {} : { language: input.language }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    },
    signal === undefined ? {} : { signal },
  )) {
    if (event.type === 'transcription.completed') {
      completed = event.transcription;
    }
  }
  if (completed === undefined) {
    throw new AiError('malformed_response', 'Transcription ended without a final transcript.', {
      code: 'transcription_completion_missing',
    });
  }
  return completed;
}

async function loadHistory(
  repository: ConversationStore | undefined,
  chatId: string,
): Promise<LoadedHistory> {
  if (repository === undefined) {
    return { messages: [] };
  }
  const snapshot = await repository.snapshot(chatId);
  if (snapshot !== undefined) {
    return { messages: snapshot.messages, revision: snapshot.conversation.revision };
  }
  const conversation = await repository.create({ id: chatId });
  return { messages: [], revision: conversation.revision };
}

async function persistHistory(
  repository: ConversationStore | undefined,
  chatId: string,
  messages: readonly ConversationMessage[],
  revision: number | undefined,
): Promise<void> {
  if (repository === undefined) {
    return;
  }
  await repository.append(chatId, messages, { expectedRevision: revision ?? 0 });
}

function selectContext(
  defaults: ClientDefaults,
  history: readonly ConversationMessage[],
  pending: readonly ConversationMessage[],
): readonly ConversationMessage[] {
  const messages = [...history, ...pending];
  const options = defaults.history;
  if (options?.maxContextTokens === undefined) {
    return messages;
  }
  return new PairSafeHistorySelector(new CharacterTokenEstimator()).select(messages, {
    maxContextTokens: options.maxContextTokens,
    reserveOutputTokens: options.reserveOutputTokens ?? 4_096,
    reserveToolResultTokens: options.reserveToolResultTokens ?? 4_096,
  }).messages;
}

interface PreparedHistory {
  readonly messages: readonly ConversationMessage[];
  readonly summary?: ConversationMessage;
  readonly usage: Usage;
}

async function prepareHistory(
  defaults: ClientDefaults,
  client: ModelClient,
  storedMessages: readonly ConversationMessage[],
  pending: readonly ConversationMessage[],
  chatId: string,
  options: AiRunOptions,
): Promise<PreparedHistory> {
  const active = activeHistory(storedMessages);
  const history = defaults.history;
  if (history?.maxContextTokens === undefined || history.compression === false) {
    return { messages: active, usage: {} };
  }
  const reserveOutputTokens = history.reserveOutputTokens ?? 4_096;
  const reserveToolResultTokens = history.reserveToolResultTokens ?? 4_096;
  const inputCapacity = history.maxContextTokens - reserveOutputTokens - reserveToolResultTokens;
  if (inputCapacity <= 0) {
    throw new AiError('invalid_request', 'History reserves leave no input-token capacity.', {
      code: 'history_context_capacity_empty',
    });
  }
  const compression = history.compression ?? {};
  const triggerTokens = positiveInteger(
    compression.triggerTokens ?? Math.max(1, Math.floor(inputCapacity * 0.8)),
    'history compression triggerTokens',
  );
  const estimator = new CharacterTokenEstimator();
  const estimatedTokens = [...active, ...pending].reduce(
    (total, message_) => total + estimator.estimate(message_),
    0,
  );
  if (estimatedTokens <= triggerTokens || active.length === 0) {
    return { messages: active, usage: {} };
  }
  const keepRecentTokens = positiveInteger(
    compression.keepRecentTokens ?? Math.max(1, Math.floor(inputCapacity * 0.5)),
    'history compression keepRecentTokens',
  );
  if (keepRecentTokens >= inputCapacity) {
    throw new AiError(
      'invalid_request',
      'History keepRecentTokens must be smaller than the available input capacity.',
      {
        code: 'history_compression_window_invalid',
        details: { inputCapacity, keepRecentTokens },
      },
    );
  }
  const selection = new PairSafeHistorySelector(estimator).select(active, {
    maxContextTokens: keepRecentTokens,
    reserveOutputTokens: 0,
    reserveToolResultTokens: 0,
  });
  const omittedIds = new Set(
    selection.omitted.filter(({ reason }) => reason === 'budget').map(({ messageId }) => messageId),
  );
  const omitted = active.filter((message_) => omittedIds.has(message_.id));
  if (omitted.length === 0) {
    return { messages: active, usage: {} };
  }
  const previousSummary = active.find(isHistorySummary);
  const sources = [
    ...(previousSummary === undefined ? [] : [previousSummary]),
    ...omitted.filter((message_) => !isHistorySummary(message_)),
  ];
  const summaryResponse = await client.generate(
    {
      messages: [
        message(chatId, 'developer', [
          {
            source: 'typed',
            text: 'Create a compact rolling summary of the conversation. Preserve user preferences, named entities, decisions, unresolved questions, and tool-derived facts. Do not add new facts.',
            type: 'text',
          },
        ]),
        ...sources,
      ],
      model: { model: defaults.provider.model, provider: defaults.provider.id },
    },
    options,
  );
  if (toolCalls(summaryResponse.message).length > 0) {
    throw new AiError('malformed_response', 'A history summary returned an unexpected tool call.', {
      code: 'history_summary_tool_call',
    });
  }
  const summaryText = assistantText(summaryResponse.message).trim();
  if (summaryText.length === 0) {
    throw new AiError('malformed_response', 'A history summary returned no text.', {
      code: 'history_summary_empty',
    });
  }
  const lastSource = omitted.at(-1);
  if (lastSource === undefined) {
    throw new AiError('malformed_response', 'History compression selected no source boundary.', {
      code: 'history_summary_boundary_missing',
    });
  }
  const summary = message(
    chatId,
    'developer',
    [{ source: 'summarized', text: `Conversation summary:\n${summaryText}`, type: 'text' }],
    undefined,
    {
      historySummary: {
        lastSourceMessageId: lastSource.id,
        sourceMessagesRetained: true,
      },
    },
  );
  return {
    messages: selection.messages.filter((message_) => !isHistorySummary(message_)),
    summary,
    usage: summaryResponse.usage,
  };
}

function activeHistory(messages: readonly ConversationMessage[]): readonly ConversationMessage[] {
  const summaryIndex = messages.findLastIndex(isHistorySummary);
  if (summaryIndex < 0) {
    return messages;
  }
  const summary = messages[summaryIndex];
  if (summary === undefined) {
    return messages;
  }
  return [
    summary,
    ...messages.slice(summaryIndex + 1).filter((message_) => !isHistorySummary(message_)),
  ];
}

function isHistorySummary(message_: ConversationMessage): boolean {
  const marker = message_.metadata?.['historySummary'];
  return (
    message_.role === 'developer' &&
    typeof marker === 'object' &&
    marker !== null &&
    !isJsonArray(marker) &&
    typeof marker['lastSourceMessageId'] === 'string'
  );
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function prependInstructions(
  messages: readonly ConversationMessage[],
  instructions: string | undefined,
  chatId: string,
): readonly ConversationMessage[] {
  return instructions === undefined
    ? messages
    : [
        message(chatId, 'developer', [{ source: 'typed', text: instructions, type: 'text' }]),
        ...messages,
      ];
}

function toolRegistry(
  tools: readonly LocalTool[],
  allowlist: readonly string[] | undefined,
): ToolRegistry {
  if (allowlist === undefined) {
    return new ToolRegistry(tools);
  }
  const normalized = new Set(allowlist.map(normalizeAllowedToolName));
  const available = new Set(tools.map((tool) => tool.definition.name));
  for (const name of normalized) {
    if (!available.has(name)) {
      throw new AiError('invalid_request', `Allowed MCP tool ${name} was not discovered.`, {
        code: 'mcp_tool_not_discovered',
        details: { tool: name },
      });
    }
  }
  return new ToolRegistry(tools.filter((tool) => normalized.has(tool.definition.name)));
}

function normalizeAllowedToolName(name: string): string {
  return name.includes('.') && !name.includes('__') ? name.replace('.', '__') : name;
}

function toolCalls(message_: ConversationMessage): readonly ToolCallPart[] {
  return message_.content.filter((part): part is ToolCallPart => part.type === 'tool_call');
}

async function executeTool(
  registry: ToolRegistry,
  call: ToolCallPart,
  chatId: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolResultPart> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    controller.abort(new DOMException('Tool execution timed out.', 'TimeoutError'));
  }, timeoutMs);
  const combinedSignal =
    signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
  try {
    const output = await registry.execute(
      { arguments: call.arguments, id: call.callId, name: call.name },
      {
        callId: call.callId,
        deadline: new Date(Date.now() + timeoutMs).toISOString(),
        runId: chatId,
        signal: combinedSignal,
      },
    );
    return successfulToolResult(call, output);
  } catch (error) {
    const normalized =
      error instanceof AiError
        ? error
        : new AiError('tool_execution', `Tool ${call.name} failed.`, {
            cause: error,
            code: 'tool_execution_failed',
          });
    return {
      callId: call.callId,
      content: [],
      error: {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      },
      status: combinedSignal.aborted ? 'cancelled' : 'error',
      type: 'tool_result',
    };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function successfulToolResult(call: ToolCallPart, output: ToolExecutionOutput): ToolResultPart {
  return {
    callId: call.callId,
    content: output.content ?? [],
    status: 'success',
    ...(output.structuredContent === undefined
      ? {}
      : { structuredContent: output.structuredContent }),
    type: 'tool_result',
  };
}

function message(
  chatId: string,
  role: ConversationMessage['role'],
  content: ConversationMessage['content'],
  parentId?: string,
  metadata?: JsonObject,
): ConversationMessage {
  return {
    content,
    conversationId: chatId,
    createdAt: new Date().toISOString(),
    id: globalThis.crypto.randomUUID(),
    ...(parentId === undefined ? {} : { parentId }),
    ...(metadata === undefined ? {} : { metadata }),
    role,
  };
}

function assistantText(message_: ConversationMessage): string {
  return message_.content
    .flatMap((part) =>
      part.type === 'text' ? [part.text] : part.type === 'refusal' ? [part.reason] : [],
    )
    .join('\n');
}

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new AiError('invalid_request', `${label} must not be empty.`, {
      code: 'empty_value',
      details: { label },
    });
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AiError('invalid_request', `${label} must be a positive integer.`, {
      code: 'invalid_positive_integer',
      details: { label, value },
    });
  }
  return value;
}

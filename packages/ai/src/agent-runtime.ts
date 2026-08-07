import type {
  AgentResult,
  AgentRunRequest,
  AgentRunOptions,
  RunBudgetSnapshot,
  RunLimits,
} from './agent-types.js';
import { defaultRunLimits } from './agent-types.js';
import type { ToolResultPart } from './content.js';
import type { AiClient } from './client.js';
import { PairSafeHistorySelector, type ContextSelectionOptions } from './context-selection.js';
import type { ConversationStore } from './conversation-store.js';
import { AiError, serializeAiError } from './error.js';
import type { JsonValue } from './json.js';
import type { ConversationMessage } from './message.js';
import type { ModelRequest, ModelResponse } from './model.js';
import type { PolicyDecision, ToolPolicy } from './policy.js';
import { SafeDefaultToolPolicy } from './policy.js';
import type {
  RunCompletedEvent,
  RunEvent,
  RunEventBase,
  RunLimitExceededEvent,
  TerminalRunEvent,
} from './run-event.js';
import type { ToolExecutionOutput } from './tool-registry.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolCall, ToolDefinition } from './tool.js';
import { addUsage, type Usage } from './usage.js';

export interface AgentRuntimeOptions {
  readonly client: AiClient;
  readonly clock?: () => Date;
  readonly contextSelection?: ContextSelectionOptions;
  readonly conversations?: ConversationStore;
  readonly historySelector?: PairSafeHistorySelector;
  readonly idGenerator?: () => string;
  readonly policy?: ToolPolicy;
  readonly tools?: ToolRegistry;
}

interface RunState {
  readonly callCounts: Map<string, number>;
  readonly conversationId: string;
  readonly failureCounts: Map<string, number>;
  readonly limits: RunLimits;
  readonly messages: ConversationMessage[];
  readonly pendingMessages: ConversationMessage[];
  readonly runId: string;
  readonly startedAtMs: number;
  conversationRevision?: number;
  executorsInvoked: boolean;
  modelSteps: number;
  persistenceAttempted: boolean;
  toolCalls: number;
  usage: Usage;
}

interface PreparedToolCall {
  readonly call: ToolCall;
  readonly decision?: PolicyDecision;
  readonly result?: ToolResultPart;
}

interface ExecutedToolCall {
  readonly call: ToolCall;
  readonly result: ToolResultPart;
}

/** Executes a finite model/tool cycle and emits an ordered, replayable run log. */
export class BoundedAgentRuntime {
  readonly #client: AiClient;
  readonly #clock: () => Date;
  readonly #conversations: ConversationStore | undefined;
  readonly #contextSelection: ContextSelectionOptions;
  readonly #historySelector: PairSafeHistorySelector;
  readonly #idGenerator: () => string;
  readonly #policy: ToolPolicy;
  readonly #tools: ToolRegistry;

  public constructor(options: AgentRuntimeOptions) {
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
    this.#conversations = options.conversations;
    this.#contextSelection = options.contextSelection ?? defaultContextSelection;
    this.#historySelector = options.historySelector ?? new PairSafeHistorySelector();
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#policy = options.policy ?? new SafeDefaultToolPolicy();
    this.#tools = options.tools ?? new ToolRegistry();
  }

  public async run(request: AgentRunRequest, options: AgentRunOptions = {}): Promise<AgentResult> {
    let terminal: TerminalRunEvent | undefined;
    for await (const event of this.stream(request, options)) {
      if (isTerminalEvent(event)) {
        terminal = event;
      }
    }
    if (terminal === undefined) {
      throw new AiError('malformed_response', 'The agent stream ended without a terminal event.', {
        code: 'missing_terminal_run_event',
      });
    }
    return terminal.result;
  }

  public async *stream(
    request: AgentRunRequest,
    options: AgentRunOptions = {},
  ): AsyncGenerator<RunEvent, void, void> {
    const limits = mergeLimits(request.limits);
    const runId = this.#idGenerator();
    const conversationId = request.conversationId ?? this.#idGenerator();
    const initialMessages = this.#initialMessages(request, runId, conversationId);
    const history = await this.#loadHistory(conversationId);
    const selected = this.#historySelector.select(
      [...(history?.messages ?? []), ...initialMessages],
      this.#contextSelection,
    );
    const state: RunState = {
      callCounts: new Map<string, number>(),
      conversationId,
      failureCounts: new Map<string, number>(),
      limits,
      ...(history === undefined ? {} : { conversationRevision: history.revision }),
      executorsInvoked: false,
      messages: [...selected.messages],
      modelSteps: 0,
      pendingMessages: [...initialMessages],
      persistenceAttempted: false,
      runId,
      startedAtMs: this.#clock().getTime(),
      toolCalls: 0,
      usage: {},
    };
    const events = new EventSequencer(runId, this.#clock, this.#idGenerator);
    const timeoutController = new AbortController();
    const timeout = globalThis.setTimeout(() => {
      timeoutController.abort(new DOMException('Run deadline exceeded.', 'TimeoutError'));
    }, limits.maxDurationMs);
    const signal =
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal]);

    try {
      yield { ...events.next(), type: 'run.started' };
      const tools = this.#enabledTools(request.agent.tools);

      for (let step = 1; step <= limits.maxModelSteps; step += 1) {
        throwIfRunAborted(signal, timeoutController.signal);
        const requestLimit = checkBudget(state, this.#clock().getTime());
        if (requestLimit !== undefined) {
          await this.#persist(state);
          yield limitEvent(events, state, requestLimit);
          return;
        }

        const modelRequest: ModelRequest = {
          messages: [...state.messages],
          model: request.agent.model,
          ...(tools.length === 0 ? {} : { toolChoice: { type: 'auto' }, tools }),
        };
        yield { ...events.next(), request: modelRequest, step, type: 'run.model.started' };

        const providerResponse = await this.#client.generate(modelRequest, { signal });
        const response = normalizeResponseMessage(providerResponse, state);
        state.modelSteps += 1;
        state.usage = addUsage(state.usage, response.usage);
        state.messages.push(response.message);
        state.pendingMessages.push(response.message);

        yield { ...events.next(), response, step, type: 'run.model.completed' };
        yield { ...events.next(), type: 'run.usage.updated', usage: state.usage };
        yield {
          ...events.next(),
          budget: budgetSnapshot(state, this.#clock().getTime()),
          type: 'run.budget.updated',
        };

        const responseLimit = checkBudget(state, this.#clock().getTime());
        if (responseLimit !== undefined) {
          await this.#persist(state);
          yield limitEvent(events, state, responseLimit);
          return;
        }

        const calls = toolCalls(response);
        if (calls.length === 0) {
          if (response.finishReason === 'tool_calls') {
            throw new AiError(
              'malformed_response',
              'The model reported tool_calls without returning a tool call.',
              { code: 'missing_tool_call' },
            );
          }
          await this.#persist(state);
          yield completedEvent(events, state, response);
          return;
        }

        const callLimit = this.#recordCalls(state, calls);
        if (callLimit !== undefined) {
          await this.#persist(state);
          yield limitEvent(events, state, callLimit);
          return;
        }

        const prepared: PreparedToolCall[] = [];
        for (const call of calls) {
          yield { ...events.next(), call, type: 'run.tool.proposed' };
          try {
            this.#tools.validate(call);
          } catch (error) {
            const result = toolErrorResult(call, normalizeToolError(error, call.name));
            prepared.push({ call, result });
            yield { ...events.next(), call, result, type: 'run.tool.completed' };
            continue;
          }

          const definition = this.#tools.definition(call.name);
          if (definition === undefined) {
            throw new AiError(
              'tool_validation',
              `Tool ${call.name} disappeared from the registry.`,
              {
                code: 'tool_registry_changed',
              },
            );
          }
          const decision = await this.#policy.evaluate({
            agentId: request.agent.id,
            call,
            ...(request.context === undefined ? {} : { context: request.context }),
            runId,
            tool: definition,
          });
          yield { ...events.next(), call, decision, type: 'run.policy.decided' };

          if (decision.outcome === 'deny') {
            const result = deniedToolResult(call, decision.reason);
            prepared.push({ call, decision, result });
            yield { ...events.next(), call, result, type: 'run.tool.completed' };
          } else if (decision.outcome === 'dry_run') {
            const output = decision.result ?? defaultDryRunOutput(call);
            this.#tools.validateOutput(call.name, output);
            const result = successfulToolResult(call, output);
            prepared.push({ call, decision, result });
            yield { ...events.next(), call, result, type: 'run.tool.completed' };
          } else {
            prepared.push({ call, decision });
          }
        }

        const executable = prepared.filter(
          (
            item,
          ): item is PreparedToolCall & {
            readonly decision: { readonly outcome: 'allow'; readonly reason: string };
          } => item.decision?.outcome === 'allow',
        );
        const concurrency =
          request.agent.parallelToolCalls === true ? limits.maxConcurrentTools : 1;
        const executed: ExecutedToolCall[] = [];
        for (let offset = 0; offset < executable.length; offset += concurrency) {
          const batch = executable.slice(offset, offset + concurrency);
          if (batch.length > 0) {
            state.executorsInvoked = true;
          }
          for (const { call } of batch) {
            yield { ...events.next(), call, type: 'run.tool.started' };
          }
          const results = await Promise.all(
            batch.map(async ({ call }): Promise<ExecutedToolCall> => ({
              call,
              result: await this.#executeTool(call, state, signal),
            })),
          );
          for (const execution of results) {
            executed.push(execution);
            yield {
              ...events.next(),
              call: execution.call,
              result: execution.result,
              type: 'run.tool.completed',
            };
          }
        }

        const executedById = new Map(executed.map((item) => [item.call.id, item.result]));
        const results = prepared.map((item): ToolResultPart => {
          const result = item.result ?? executedById.get(item.call.id);
          if (result === undefined) {
            throw new AiError('malformed_response', 'A tool call has no execution result.', {
              code: 'missing_tool_result',
              details: { callId: item.call.id },
            });
          }
          return result;
        });
        const toolMessage = this.#toolMessage(state, results);
        state.messages.push(toolMessage);
        state.pendingMessages.push(toolMessage);

        const repeatedFailure = recordFailures(state, calls, results);
        if (repeatedFailure) {
          await this.#persist(state);
          yield limitEvent(events, state, 'maxRepeatedToolFailures');
          return;
        }
      }

      await this.#persist(state);
      yield limitEvent(events, state, 'maxModelSteps');
    } catch (error) {
      let normalized = normalizeRunError(error, options.signal, timeoutController.signal);
      try {
        await this.#persist(state);
      } catch (persistenceError) {
        normalized = normalizeRunError(persistenceError, options.signal, timeoutController.signal);
      }
      if (normalized.category === 'budget_exceeded') {
        yield limitEvent(events, state, 'maxDurationMs', normalized);
      } else if (normalized.category === 'cancelled') {
        const result = terminalResult(state, 'cancelled', normalized);
        yield {
          ...events.next(),
          error: serializeAiError(normalized),
          result,
          type: 'run.cancelled',
        };
      } else {
        const result = terminalResult(state, 'failed', normalized);
        yield {
          ...events.next(),
          error: serializeAiError(normalized),
          result,
          type: 'run.failed',
        };
      }
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async #loadHistory(
    conversationId: string,
  ): Promise<
    { readonly messages: readonly ConversationMessage[]; readonly revision: number } | undefined
  > {
    if (this.#conversations === undefined) {
      return undefined;
    }
    const existing = await this.#conversations.snapshot(conversationId);
    if (existing !== undefined) {
      return { messages: existing.messages, revision: existing.conversation.revision };
    }
    const created = await this.#conversations.create({ id: conversationId });
    return { messages: [], revision: created.revision };
  }

  async #persist(state: RunState): Promise<void> {
    if (
      this.#conversations === undefined ||
      state.conversationRevision === undefined ||
      state.persistenceAttempted
    ) {
      return;
    }
    state.persistenceAttempted = true;
    try {
      const conversation = await this.#conversations.append(
        state.conversationId,
        state.pendingMessages,
        { expectedRevision: state.conversationRevision },
      );
      state.conversationRevision = conversation.revision;
    } catch (cause) {
      const originalCode = cause instanceof AiError ? cause.code : 'unknown';
      throw new AiError(
        'persistence_conflict',
        `Failed to persist agent run ${state.runId}. The run was not replayed.`,
        {
          cause,
          code: 'agent_run_persistence_failed',
          details: {
            conversationId: state.conversationId,
            executorsInvoked: state.executorsInvoked,
            expectedRevision: state.conversationRevision,
            originalCode,
            runId: state.runId,
          },
          retryable: !state.executorsInvoked,
        },
      );
    }
  }

  #enabledTools(names: readonly string[] | undefined): readonly ToolDefinition[] {
    if (names === undefined) {
      return this.#tools.definitions;
    }
    return names.map((name): ToolDefinition => {
      const definition = this.#tools.definition(name);
      if (definition === undefined) {
        throw new AiError('invalid_request', `Agent references unregistered tool ${name}.`, {
          code: 'agent_tool_not_found',
          details: { toolName: name },
        });
      }
      return definition;
    });
  }

  #executeTool(call: ToolCall, state: RunState, signal: AbortSignal): Promise<ToolResultPart> {
    return this.#tools
      .execute(call, {
        callId: call.id,
        deadline: new Date(state.startedAtMs + state.limits.maxDurationMs).toISOString(),
        runId: state.runId,
        signal,
      })
      .then(
        (output): ToolResultPart => successfulToolResult(call, output),
        (error: unknown): ToolResultPart =>
          toolErrorResult(call, normalizeToolError(error, call.name)),
      );
  }

  #initialMessages(
    request: AgentRunRequest,
    runId: string,
    conversationId: string,
  ): ConversationMessage[] {
    const messages: ConversationMessage[] = [];
    if (request.agent.instructions !== undefined) {
      messages.push({
        content: [{ source: 'typed', text: request.agent.instructions, type: 'text' }],
        conversationId,
        createdAt: this.#clock().toISOString(),
        id: this.#idGenerator(),
        role: 'developer',
        runId,
      });
    }
    messages.push({
      content: request.input,
      conversationId,
      createdAt: this.#clock().toISOString(),
      id: this.#idGenerator(),
      role: 'user',
      runId,
    });
    return messages;
  }

  #recordCalls(state: RunState, calls: readonly ToolCall[]): keyof RunLimits | undefined {
    if (state.toolCalls + calls.length > state.limits.maxToolCalls) {
      return 'maxToolCalls';
    }
    const ids = new Set<string>();
    const batchCounts = new Map<string, number>();
    for (const call of calls) {
      if (ids.has(call.id)) {
        throw new AiError('malformed_response', `Duplicate tool call ID ${call.id}.`, {
          code: 'duplicate_tool_call_id',
          details: { callId: call.id },
        });
      }
      ids.add(call.id);
      const next = (state.callCounts.get(call.name) ?? 0) + (batchCounts.get(call.name) ?? 0) + 1;
      if (next > state.limits.maxCallsPerTool) {
        return 'maxCallsPerTool';
      }
      batchCounts.set(call.name, (batchCounts.get(call.name) ?? 0) + 1);
    }
    for (const call of calls) {
      state.callCounts.set(call.name, (state.callCounts.get(call.name) ?? 0) + 1);
    }
    state.toolCalls += calls.length;
    return undefined;
  }

  #toolMessage(state: RunState, results: readonly ToolResultPart[]): ConversationMessage {
    return {
      content: results,
      conversationId: state.conversationId,
      createdAt: this.#clock().toISOString(),
      id: this.#idGenerator(),
      role: 'tool',
      runId: state.runId,
    };
  }
}

class EventSequencer {
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #runId: string;
  #sequence = 0;

  public constructor(runId: string, clock: () => Date, idGenerator: () => string) {
    this.#runId = runId;
    this.#clock = clock;
    this.#idGenerator = idGenerator;
  }

  public next(): RunEventBase {
    const base: RunEventBase = {
      eventId: this.#idGenerator(),
      occurredAt: this.#clock().toISOString(),
      runId: this.#runId,
      sequence: this.#sequence,
    };
    this.#sequence += 1;
    return base;
  }
}

function mergeLimits(overrides: Partial<RunLimits> | undefined): RunLimits {
  const limits: RunLimits = { ...defaultRunLimits, ...overrides };
  for (const name of runLimitNames) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AiError('invalid_request', `Run limit ${name} must be a positive safe integer.`, {
        code: 'invalid_run_limit',
        details: { limit: name, value },
      });
    }
  }
  return limits;
}

function toolCalls(response: ModelResponse): readonly ToolCall[] {
  return response.message.content
    .filter((part) => part.type === 'tool_call')
    .map((part): ToolCall => ({ arguments: part.arguments, id: part.callId, name: part.name }));
}

function successfulToolResult(call: ToolCall, output: ToolExecutionOutput): ToolResultPart {
  return {
    callId: call.id,
    content: output.content ?? [],
    status: 'success',
    ...(output.structuredContent === undefined
      ? {}
      : { structuredContent: output.structuredContent }),
    type: 'tool_result',
  };
}

function deniedToolResult(call: ToolCall, reason: string): ToolResultPart {
  return {
    callId: call.id,
    content: [{ source: 'generated', text: reason, type: 'text' }],
    error: { code: 'policy_denied', message: reason, retryable: false },
    status: 'denied',
    type: 'tool_result',
  };
}

function toolErrorResult(call: ToolCall, error: AiError): ToolResultPart {
  return {
    callId: call.id,
    content: [],
    error: { code: error.code, message: error.message, retryable: error.retryable },
    status: error.category === 'cancelled' ? 'cancelled' : 'error',
    type: 'tool_result',
  };
}

function defaultDryRunOutput(call: ToolCall): ToolExecutionOutput {
  return {
    content: [
      {
        source: 'generated',
        text: `Dry run: ${call.name} was not executed.`,
        type: 'text',
      },
    ],
  };
}

function normalizeToolError(error: unknown, toolName: string): AiError {
  if (error instanceof AiError) {
    return error;
  }
  if (isAbortError(error)) {
    return new AiError('cancelled', `Tool ${toolName} was cancelled.`, {
      cause: error,
      code: 'tool_cancelled',
      details: { toolName },
    });
  }
  return new AiError('tool_execution', `Tool ${toolName} failed.`, {
    cause: error,
    code: 'tool_execution_failed',
    details: { toolName },
  });
}

function normalizeRunError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timeoutSignal: AbortSignal,
): AiError {
  if (timeoutSignal.aborted && callerSignal?.aborted !== true) {
    return new AiError('budget_exceeded', 'The agent run exceeded its wall-clock limit.', {
      cause: error,
      code: 'run_duration_exceeded',
      details: { limit: 'maxDurationMs' },
    });
  }
  if (callerSignal?.aborted === true || isAbortError(error)) {
    return new AiError('cancelled', 'The agent run was cancelled.', {
      cause: error,
      code: 'run_cancelled',
    });
  }
  if (error instanceof AiError) {
    return error;
  }
  return new AiError('tool_execution', 'The agent run failed.', {
    cause: error,
    code: 'agent_run_failed',
  });
}

function throwIfRunAborted(signal: AbortSignal, timeoutSignal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  if (timeoutSignal.aborted) {
    throw new AiError('budget_exceeded', 'The agent run exceeded its wall-clock limit.', {
      cause: signal.reason,
      code: 'run_duration_exceeded',
      details: { limit: 'maxDurationMs' },
    });
  }
  throw new AiError('cancelled', 'The agent run was cancelled.', {
    cause: signal.reason,
    code: 'run_cancelled',
  });
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function budgetSnapshot(state: RunState, nowMs: number): RunBudgetSnapshot {
  const inputTokens = state.usage.inputTokens;
  const outputTokens = state.usage.outputTokens;
  const totalTokens =
    inputTokens === undefined && outputTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0);
  return {
    elapsedMs: Math.max(0, nowMs - state.startedAtMs),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    modelSteps: state.modelSteps,
    ...(outputTokens === undefined ? {} : { outputTokens }),
    toolCalls: state.toolCalls,
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

function checkBudget(state: RunState, nowMs: number): keyof RunLimits | undefined {
  const budget = budgetSnapshot(state, nowMs);
  if (budget.elapsedMs >= state.limits.maxDurationMs) {
    return 'maxDurationMs';
  }
  if (budget.inputTokens !== undefined && budget.inputTokens > state.limits.maxInputTokens) {
    return 'maxInputTokens';
  }
  if (budget.outputTokens !== undefined && budget.outputTokens > state.limits.maxOutputTokens) {
    return 'maxOutputTokens';
  }
  if (budget.totalTokens !== undefined && budget.totalTokens > state.limits.maxTotalTokens) {
    return 'maxTotalTokens';
  }
  return undefined;
}

function limitEvent(
  events: EventSequencer,
  state: RunState,
  limit: keyof RunLimits,
  suppliedError?: AiError,
): RunLimitExceededEvent {
  const error =
    suppliedError ??
    new AiError('budget_exceeded', `The agent run exceeded ${limit}.`, {
      code: 'run_limit_exceeded',
      details: { limit },
    });
  return {
    ...events.next(),
    error: serializeAiError(error),
    limit,
    result: terminalResult(state, 'limit_exceeded', error),
    type: 'run.limit_exceeded',
  };
}

function completedEvent(
  events: EventSequencer,
  state: RunState,
  response: ModelResponse,
): RunCompletedEvent {
  return {
    ...events.next(),
    result: {
      conversationId: state.conversationId,
      ...(state.conversationRevision === undefined
        ? {}
        : { conversationRevision: state.conversationRevision }),
      messages: [...state.messages],
      modelSteps: state.modelSteps,
      output: response.message,
      runId: state.runId,
      status: 'completed',
      toolCalls: state.toolCalls,
      usage: state.usage,
    },
    type: 'run.completed',
  };
}

function terminalResult(
  state: RunState,
  status: 'cancelled' | 'failed' | 'limit_exceeded',
  error: AiError,
): AgentResult {
  return {
    conversationId: state.conversationId,
    ...(state.conversationRevision === undefined
      ? {}
      : { conversationRevision: state.conversationRevision }),
    error: serializeAiError(error),
    messages: [...state.messages],
    modelSteps: state.modelSteps,
    runId: state.runId,
    status,
    toolCalls: state.toolCalls,
    usage: state.usage,
  };
}

function normalizeResponseMessage(response: ModelResponse, state: RunState): ModelResponse {
  return {
    ...response,
    message: {
      ...response.message,
      conversationId: state.conversationId,
      runId: state.runId,
    },
  };
}

function recordFailures(
  state: RunState,
  calls: readonly ToolCall[],
  results: readonly ToolResultPart[],
): boolean {
  let exceeded = false;
  for (const [index, call] of calls.entries()) {
    const result = results[index];
    if (result === undefined) {
      continue;
    }
    const key = `${call.name}:${stableJson(call.arguments)}`;
    if (result.status === 'error') {
      const failures = (state.failureCounts.get(key) ?? 0) + 1;
      state.failureCounts.set(key, failures);
      exceeded ||= failures >= state.limits.maxRepeatedToolFailures;
    } else {
      state.failureCounts.delete(key);
    }
  }
  return exceeded;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (isJsonArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

const runLimitNames: readonly (keyof RunLimits)[] = [
  'maxCallsPerTool',
  'maxConcurrentTools',
  'maxDurationMs',
  'maxInputTokens',
  'maxModelSteps',
  'maxOutputTokens',
  'maxRepeatedToolFailures',
  'maxToolCalls',
  'maxTotalTokens',
];

const defaultContextSelection: ContextSelectionOptions = {
  maxContextTokens: 200_000,
  reserveOutputTokens: 32_000,
  reserveToolResultTokens: 16_000,
};

function isTerminalEvent(event: RunEvent): event is TerminalRunEvent {
  return (
    event.type === 'run.cancelled' ||
    event.type === 'run.completed' ||
    event.type === 'run.failed' ||
    event.type === 'run.limit_exceeded'
  );
}

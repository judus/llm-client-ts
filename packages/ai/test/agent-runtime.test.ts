import { describe, expect, it, vi } from 'vitest';

import {
  AiClient,
  AiError,
  BoundedAgentRuntime,
  InMemoryConversationStore,
  ToolRegistry,
  type AgentRunRequest,
  type CallOptions,
  type ConversationMessage,
  type Conversation,
  type ConversationSnapshot,
  type ConversationStore,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type PolicyDecision,
  type RunEvent,
  type ToolCall,
  type ToolHandler,
  type ToolPolicy,
} from '../src/index.js';

const capabilities: ModelCapabilities = {
  input: { audio: false, documents: false, images: false, text: true },
  output: { audio: false, structured: true, text: true },
  realtime: false,
  speechSynthesis: false,
  streaming: false,
  tools: { calls: true, parallelCalls: true, strictSchemas: true },
  transcription: false,
};

const baseRequest: AgentRunRequest = {
  agent: {
    id: 'researcher',
    instructions: 'Answer precisely.',
    model: { model: 'test-model', provider: 'scripted' },
    tools: ['lookup'],
  },
  conversationId: 'conversation-1',
  input: [{ source: 'typed', text: 'Find 42.', type: 'text' }],
};

class QueueProvider implements ModelProvider {
  public readonly id = 'scripted';
  public readonly requests: ModelRequest[] = [];
  readonly #responses: ModelResponse[];

  public constructor(responses: readonly ModelResponse[]) {
    this.#responses = [...responses];
  }

  public capabilities(): Promise<ModelCapabilities> {
    return Promise.resolve(capabilities);
  }

  public generate(request: ModelRequest, options?: CallOptions): Promise<ModelResponse> {
    options?.signal?.throwIfAborted();
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) {
      return Promise.reject(
        new AiError('malformed_response', 'Script exhausted.', { code: 'script_exhausted' }),
      );
    }
    return Promise.resolve(response);
  }

  public async *stream(): AsyncGenerator<ModelStreamEvent, void, void> {
    yield await Promise.reject(new Error('Streaming is not used by this test provider.'));
  }
}

class HangingProvider implements ModelProvider {
  public readonly id = 'scripted';

  public capabilities(): Promise<ModelCapabilities> {
    return Promise.resolve(capabilities);
  }

  public generate(_request: ModelRequest, options?: CallOptions): Promise<ModelResponse> {
    return new Promise((_resolve, reject) => {
      const rejectCancellation = (): void => {
        reject(new DOMException('Provider aborted.', 'AbortError'));
      };
      if (options?.signal?.aborted === true) {
        rejectCancellation();
        return;
      }
      options?.signal?.addEventListener('abort', rejectCancellation, { once: true });
    });
  }

  public async *stream(): AsyncGenerator<ModelStreamEvent, void, void> {
    yield await Promise.reject(new Error('Streaming is not used by this test provider.'));
  }
}

class RejectingConversationStore implements ConversationStore {
  public appendCalls = 0;

  public append(): Promise<Conversation> {
    this.appendCalls += 1;
    return Promise.reject(
      new AiError('persistence_conflict', 'Concurrent append.', {
        code: 'conversation_revision_conflict',
        retryable: true,
      }),
    );
  }

  public create(): Promise<Conversation> {
    return Promise.reject(new Error('The fixture conversation already exists.'));
  }

  public get(): Promise<Conversation | undefined> {
    return Promise.resolve(conversation());
  }

  public listMessages(): Promise<readonly ConversationMessage[]> {
    return Promise.resolve([]);
  }

  public snapshot(): Promise<ConversationSnapshot | undefined> {
    return Promise.resolve({ conversation: conversation(), messages: [] });
  }
}

function conversation(): Conversation {
  return {
    createdAt: '2026-08-07T12:00:00.000Z',
    id: 'conversation-1',
    revision: 7,
    updatedAt: '2026-08-07T12:00:00.000Z',
  };
}

class FixedPolicy implements ToolPolicy {
  readonly #decision: PolicyDecision;

  public constructor(decision: PolicyDecision) {
    this.#decision = decision;
  }

  public evaluate(): PolicyDecision {
    return this.#decision;
  }
}

function lookupCall(id = 'call-1', arguments_: ToolCall['arguments'] = { id: 42 }): ToolCall {
  return { arguments: arguments_, id, name: 'lookup' };
}

function response(
  id: string,
  content: ConversationMessage['content'],
  finishReason: ModelResponse['finishReason'],
  usage: ModelResponse['usage'] = { inputTokens: 10, outputTokens: 5 },
): ModelResponse {
  return {
    finishReason,
    id,
    message: {
      content,
      conversationId: 'conversation-1',
      createdAt: '2026-08-07T12:00:01.000Z',
      id: `message-${id}`,
      role: 'assistant',
      runId: 'provider-run',
    },
    model: { model: 'test-model', provider: 'scripted' },
    usage,
  };
}

function toolResponse(call: ToolCall): ModelResponse {
  return response(
    'tool-response',
    [
      {
        arguments: call.arguments,
        callId: call.id,
        name: call.name,
        type: 'tool_call',
      },
    ],
    'tool_calls',
  );
}

function finalResponse(text = 'The answer is 42.'): ModelResponse {
  return response('final-response', [{ source: 'generated', text, type: 'text' }], 'stop');
}

function registry(
  execute: ToolHandler = vi.fn(() => ({ structuredContent: { value: 'answer' } })),
): ToolRegistry {
  return new ToolRegistry([
    {
      definition: {
        annotations: { readOnly: true },
        description: 'Looks up a value.',
        inputSchema: {
          additionalProperties: false,
          properties: { id: { type: 'integer' } },
          required: ['id'],
          type: 'object',
        },
        name: 'lookup',
      },
      execute,
    },
  ]);
}

function runtime(
  provider: QueueProvider,
  options: {
    readonly policy?: ToolPolicy;
    readonly tools?: ToolRegistry;
  } = {},
): BoundedAgentRuntime {
  let id = 0;
  return new BoundedAgentRuntime({
    client: new AiClient(provider),
    clock: () => new Date('2026-08-07T12:00:00.000Z'),
    idGenerator: () => `id-${String(id++)}`,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    tools: options.tools ?? registry(),
  });
}

async function collect(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('BoundedAgentRuntime', () => {
  it('completes a direct response with ordered events and cumulative usage', async () => {
    const provider = new QueueProvider([finalResponse()]);
    const events = await collect(runtime(provider).stream(baseRequest));
    const result = await runtime(new QueueProvider([finalResponse()])).run(baseRequest);

    expect(events.map(({ type }) => type)).toEqual([
      'run.started',
      'run.model.started',
      'run.model.completed',
      'run.usage.updated',
      'run.budget.updated',
      'run.completed',
    ]);
    expect(events.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result).toMatchObject({ modelSteps: 1, status: 'completed', toolCalls: 0 });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(provider.requests[0]?.messages.map(({ role }) => role)).toEqual(['developer', 'user']);
  });

  it('validates, authorizes, executes, and returns local tool results to the model', async () => {
    const execute = vi.fn(() => ({ structuredContent: { value: 'answer' } }));
    const provider = new QueueProvider([toolResponse(lookupCall()), finalResponse()]);
    const result = await runtime(provider, { tools: registry(execute) }).run(baseRequest);

    expect(result).toMatchObject({ modelSteps: 2, status: 'completed', toolCalls: 1 });
    expect(execute).toHaveBeenCalledOnce();
    expect(provider.requests[1]?.messages.at(-1)).toMatchObject({
      content: [
        {
          callId: 'call-1',
          status: 'success',
          structuredContent: { value: 'answer' },
          type: 'tool_result',
        },
      ],
      role: 'tool',
    });
  });

  it('never invokes a tool with invalid input and gives the model a normalized error', async () => {
    const execute = vi.fn(() => ({}));
    const provider = new QueueProvider([
      toolResponse(lookupCall('call-invalid', { id: 'wrong' })),
      finalResponse('Could not look it up.'),
    ]);

    const result = await runtime(provider, { tools: registry(execute) }).run(baseRequest);

    expect(result.status).toBe('completed');
    expect(execute).not.toHaveBeenCalled();
    expect(provider.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      error: { code: 'tool_input_validation_failed' },
      status: 'error',
    });
  });

  it('denies unannotated tools by default and supports explicit dry runs', async () => {
    const execute = vi.fn(() => ({}));
    const unannotated = registry(execute);
    const registered = unannotated.definition('lookup');
    expect(registered).toBeDefined();
    const deniedRegistry = new ToolRegistry([
      {
        definition: {
          description: registered!.description,
          inputSchema: registered!.inputSchema,
          name: registered!.name,
          ...(registered!.outputSchema === undefined
            ? {}
            : { outputSchema: registered!.outputSchema }),
        },
        execute,
      },
    ]);
    const deniedProvider = new QueueProvider([toolResponse(lookupCall()), finalResponse()]);
    await runtime(deniedProvider, { tools: deniedRegistry }).run(baseRequest);
    expect(execute).not.toHaveBeenCalled();
    expect(deniedProvider.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      status: 'denied',
    });

    const dryProvider = new QueueProvider([toolResponse(lookupCall()), finalResponse()]);
    await runtime(dryProvider, {
      policy: new FixedPolicy({ outcome: 'dry_run', reason: 'Simulation requested.' }),
      tools: registry(execute),
    }).run(baseRequest);
    expect(execute).not.toHaveBeenCalled();
    expect(dryProvider.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
      status: 'success',
    });
  });

  it('terminates at model, token, tool, and per-tool limits', async () => {
    const modelLimited = await runtime(
      new QueueProvider([toolResponse(lookupCall()), toolResponse(lookupCall('call-2'))]),
    ).run({ ...baseRequest, limits: { maxModelSteps: 1 } });
    expect(modelLimited).toMatchObject({
      error: { details: { limit: 'maxModelSteps' } },
      status: 'limit_exceeded',
    });

    const tokenLimited = await runtime(new QueueProvider([finalResponse('large')])).run({
      ...baseRequest,
      limits: { maxTotalTokens: 14 },
    });
    expect(tokenLimited).toMatchObject({
      error: { details: { limit: 'maxTotalTokens' } },
      status: 'limit_exceeded',
    });

    const twoCalls = response(
      'two-calls',
      [lookupCallPart(lookupCall()), lookupCallPart(lookupCall('call-2'))],
      'tool_calls',
    );
    const toolLimited = await runtime(new QueueProvider([twoCalls])).run({
      ...baseRequest,
      limits: { maxToolCalls: 1 },
    });
    expect(toolLimited).toMatchObject({
      error: { details: { limit: 'maxToolCalls' } },
      status: 'limit_exceeded',
    });

    const perToolLimited = await runtime(new QueueProvider([twoCalls])).run({
      ...baseRequest,
      limits: { maxCallsPerTool: 1 },
    });
    expect(perToolLimited).toMatchObject({
      error: { details: { limit: 'maxCallsPerTool' } },
      status: 'limit_exceeded',
    });
  });

  it('bounds parallel execution and preserves model result ordering', async () => {
    let active = 0;
    let peak = 0;
    const execute = vi.fn(async (arguments_: ToolCall['arguments']) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 2));
      active -= 1;
      return { structuredContent: { id: arguments_['id'] ?? null } };
    });
    const calls = [
      lookupCall('call-1', { id: 1 }),
      lookupCall('call-2', { id: 2 }),
      lookupCall('call-3', { id: 3 }),
    ];
    const provider = new QueueProvider([
      response('parallel', calls.map(lookupCallPart), 'tool_calls'),
      finalResponse(),
    ]);
    const result = await runtime(provider, { tools: registry(execute) }).run({
      ...baseRequest,
      agent: { ...baseRequest.agent, parallelToolCalls: true },
      limits: { maxConcurrentTools: 2 },
    });

    expect(result.status).toBe('completed');
    expect(peak).toBe(2);
    expect(
      provider.requests[1]?.messages
        .at(-1)
        ?.content.map((part) => (part.type === 'tool_result' ? part.callId : 'unexpected')),
    ).toEqual(['call-1', 'call-2', 'call-3']);
  });

  it('terminates repeated identical failures predictably', async () => {
    const execute = vi.fn(() => {
      throw new Error('upstream down');
    });
    const provider = new QueueProvider([
      toolResponse(lookupCall('call-1')),
      toolResponse(lookupCall('call-2')),
    ]);

    const result = await runtime(provider, { tools: registry(execute) }).run(baseRequest);

    expect(result).toMatchObject({
      error: { details: { limit: 'maxRepeatedToolFailures' } },
      status: 'limit_exceeded',
      toolCalls: 2,
    });
  });

  it('cancels in-flight tool work and emits a terminal cancellation event', async () => {
    const controller = new AbortController();
    const execute = vi.fn(
      (_arguments: ToolCall['arguments'], context: { readonly signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Tool aborted.', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const provider = new QueueProvider([toolResponse(lookupCall())]);
    const eventsPromise = collect(
      runtime(provider, { tools: registry(execute) }).stream(baseRequest, {
        signal: controller.signal,
      }),
    );
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledOnce();
    });
    controller.abort(new DOMException('Stopped by caller.', 'AbortError'));
    const events = await eventsPromise;

    expect(events.at(-1)).toMatchObject({
      result: { status: 'cancelled' },
      type: 'run.cancelled',
    });
  });

  it('fails malformed provider tool-call output and invalid run configuration', async () => {
    const malformed = await runtime(
      new QueueProvider([response('malformed', [], 'tool_calls')]),
    ).run(baseRequest);
    expect(malformed).toMatchObject({
      error: { code: 'missing_tool_call' },
      status: 'failed',
    });

    await expect(
      runtime(new QueueProvider([finalResponse()])).run({
        ...baseRequest,
        limits: { maxModelSteps: 0 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_run_limit' });
  });

  it('uses safe generated identifiers and exposes all registry tools when no allow-list is set', async () => {
    const provider = new QueueProvider([finalResponse()]);
    const agentRuntime = new BoundedAgentRuntime({
      client: new AiClient(provider),
      tools: registry(),
    });

    const result = await agentRuntime.run({
      ...baseRequest,
      agent: {
        id: baseRequest.agent.id,
        instructions: 'Answer precisely.',
        model: baseRequest.agent.model,
      },
    });

    expect(result.runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(provider.requests[0]?.tools?.map(({ name }) => name)).toEqual(['lookup']);
  });

  it('turns deadline and caller aborts into distinct terminal results', async () => {
    const timedOut = await new BoundedAgentRuntime({
      client: new AiClient(new HangingProvider()),
      tools: registry(),
    }).run({ ...baseRequest, limits: { maxDurationMs: 5 } });
    expect(timedOut).toMatchObject({
      error: { code: 'run_duration_exceeded' },
      status: 'limit_exceeded',
    });

    const controller = new AbortController();
    controller.abort(new DOMException('Cancelled.', 'AbortError'));
    const cancelled = await runtime(new QueueProvider([finalResponse()])).run(baseRequest, {
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({
      error: { code: 'run_cancelled' },
      status: 'cancelled',
    });
  });

  it('checks individual token dimensions and rejects missing or duplicate tools', async () => {
    const inputLimited = await runtime(new QueueProvider([finalResponse()])).run({
      ...baseRequest,
      limits: { maxInputTokens: 9 },
    });
    expect(inputLimited.error?.details).toMatchObject({ limit: 'maxInputTokens' });

    const outputLimited = await runtime(new QueueProvider([finalResponse()])).run({
      ...baseRequest,
      limits: { maxOutputTokens: 4 },
    });
    expect(outputLimited.error?.details).toMatchObject({ limit: 'maxOutputTokens' });

    const unknown = await runtime(new QueueProvider([finalResponse()])).run({
      ...baseRequest,
      agent: { ...baseRequest.agent, tools: ['missing'] },
    });
    expect(unknown).toMatchObject({ error: { code: 'agent_tool_not_found' }, status: 'failed' });

    const call = lookupCall('duplicate');
    const duplicate = await runtime(
      new QueueProvider([
        response('duplicates', [lookupCallPart(call), lookupCallPart(call)], 'tool_calls'),
      ]),
    ).run(baseRequest);
    expect(duplicate).toMatchObject({
      error: { code: 'duplicate_tool_call_id' },
      status: 'failed',
    });
  });

  it('normalizes unexpected policy failures and canonicalizes array arguments', async () => {
    const failingPolicy: ToolPolicy = {
      evaluate: () => {
        throw new TypeError('Policy storage is unavailable.');
      },
    };
    const policyFailure = await runtime(new QueueProvider([toolResponse(lookupCall())]), {
      policy: failingPolicy,
    }).run(baseRequest);
    expect(policyFailure).toMatchObject({
      error: { code: 'agent_run_failed' },
      status: 'failed',
    });

    const invalidArguments = { id: [2, 1] };
    const repeatedInvalid = await runtime(
      new QueueProvider([
        toolResponse(lookupCall('invalid-1', invalidArguments)),
        toolResponse(lookupCall('invalid-2', invalidArguments)),
      ]),
    ).run(baseRequest);
    expect(repeatedInvalid).toMatchObject({
      error: { details: { limit: 'maxRepeatedToolFailures' } },
      status: 'limit_exceeded',
    });
  });

  it('continues a stored conversation across runs using optimistic revisions', async () => {
    const conversations = new InMemoryConversationStore({
      clock: () => new Date('2026-08-07T12:00:00.000Z'),
      idGenerator: () => 'unused',
    });
    const provider = new QueueProvider([
      finalResponse('First.'),
      response(
        'second-final-response',
        [{ source: 'generated', text: 'Second.', type: 'text' }],
        'stop',
      ),
    ]);
    let id = 0;
    const agentRuntime = new BoundedAgentRuntime({
      client: new AiClient(provider),
      clock: () => new Date('2026-08-07T12:00:00.000Z'),
      conversations,
      idGenerator: () => `stored-${String(id++)}`,
      tools: registry(),
    });

    const first = await agentRuntime.run(baseRequest);
    const second = await agentRuntime.run({
      ...baseRequest,
      input: [{ source: 'typed', text: 'Continue.', type: 'text' }],
    });

    expect(first).toMatchObject({ conversationId: 'conversation-1', conversationRevision: 1 });
    expect(second).toMatchObject({ conversationId: 'conversation-1', conversationRevision: 2 });
    expect(provider.requests[1]?.messages.map(({ role }) => role)).toEqual([
      'developer',
      'user',
      'assistant',
      'developer',
      'user',
    ]);
    expect((await conversations.snapshot('conversation-1'))?.messages).toHaveLength(6);
  });

  it('never retries a failed persistence append and marks side-effect conflicts non-retryable', async () => {
    const withoutSideEffects = new RejectingConversationStore();
    const plainResult = await new BoundedAgentRuntime({
      client: new AiClient(new QueueProvider([finalResponse()])),
      conversations: withoutSideEffects,
      tools: registry(),
    }).run(baseRequest);
    expect(plainResult).toMatchObject({
      error: {
        code: 'agent_run_persistence_failed',
        details: { executorsInvoked: false, originalCode: 'conversation_revision_conflict' },
        retryable: true,
      },
      status: 'failed',
    });
    expect(withoutSideEffects.appendCalls).toBe(1);

    const execute = vi.fn(() => ({ structuredContent: { value: 'answer' } }));
    const afterSideEffect = new RejectingConversationStore();
    const toolResult = await new BoundedAgentRuntime({
      client: new AiClient(
        new QueueProvider([toolResponse(lookupCall()), finalResponse('Finished.')]),
      ),
      conversations: afterSideEffect,
      tools: registry(execute),
    }).run(baseRequest);
    expect(toolResult).toMatchObject({
      error: {
        code: 'agent_run_persistence_failed',
        details: { executorsInvoked: true },
        retryable: false,
      },
      status: 'failed',
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(afterSideEffect.appendCalls).toBe(1);
  });
});

function lookupCallPart(call: ToolCall): ConversationMessage['content'][number] {
  return {
    arguments: call.arguments,
    callId: call.id,
    name: call.name,
    type: 'tool_call',
  };
}

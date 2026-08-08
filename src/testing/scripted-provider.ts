import {
  AiError,
  type CallOptions,
  type ModelCapabilities,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from '../index.js';

export type ScriptedProviderStep =
  | { readonly response: ModelResponse; readonly type: 'generate' }
  | { readonly events: readonly ModelStreamEvent[]; readonly type: 'stream' }
  | { readonly error: AiError; readonly type: 'throw' };

export interface ScriptedProviderOptions {
  readonly capabilities?: ModelCapabilities;
  readonly id?: string;
}

/** Deterministic provider used for client and adapter conformance tests. */
export class ScriptedProvider implements ModelProvider {
  public readonly id: string;
  readonly #capabilities: ModelCapabilities;
  readonly #requests: ModelRequest[] = [];
  readonly #steps: ScriptedProviderStep[];

  public constructor(
    steps: readonly ScriptedProviderStep[],
    options: ScriptedProviderOptions = {},
  ) {
    this.id = options.id ?? 'scripted';
    this.#capabilities = options.capabilities ?? textModelCapabilities();
    this.#steps = [...steps];
  }

  public get requests(): readonly ModelRequest[] {
    return [...this.#requests];
  }

  public get remainingSteps(): number {
    return this.#steps.length;
  }

  public capabilities(): Promise<ModelCapabilities> {
    return Promise.resolve(this.#capabilities);
  }

  public generate(request: ModelRequest, options?: CallOptions): Promise<ModelResponse> {
    options?.signal?.throwIfAborted();
    this.#requests.push(request);
    const step = this.#nextStep('generate');
    if (step.type === 'throw') {
      return Promise.reject(step.error);
    }
    if (step.type !== 'generate') {
      return Promise.reject(unexpectedStep('generate', step.type));
    }
    return Promise.resolve(step.response);
  }

  public async *stream(
    request: ModelRequest,
    options?: CallOptions,
  ): AsyncGenerator<ModelStreamEvent, void, void> {
    options?.signal?.throwIfAborted();
    this.#requests.push(request);
    const step = this.#nextStep('stream');
    if (step.type === 'throw') {
      throw step.error;
    }
    if (step.type !== 'stream') {
      throw unexpectedStep('stream', step.type);
    }
    for (const event of step.events) {
      await Promise.resolve();
      options?.signal?.throwIfAborted();
      yield event;
    }
  }

  #nextStep(operation: 'generate' | 'stream'): ScriptedProviderStep {
    const step = this.#steps.shift();
    if (step === undefined) {
      throw new AiError('malformed_response', `No scripted ${operation} step remains.`, {
        code: 'script_exhausted',
      });
    }
    return step;
  }
}

export function textModelCapabilities(): ModelCapabilities {
  return {
    input: {
      audio: false,
      documents: false,
      images: false,
      text: true,
    },
    output: {
      audio: false,
      structured: false,
      text: true,
    },
    realtime: false,
    speechSynthesis: false,
    streaming: true,
    tools: {
      calls: false,
      parallelCalls: false,
      strictSchemas: false,
    },
    transcription: false,
  };
}

function unexpectedStep(
  operation: 'generate' | 'stream',
  actual: ScriptedProviderStep['type'],
): AiError {
  return new AiError(
    'malformed_response',
    `Expected scripted ${operation} step, received ${actual}.`,
    { code: 'unexpected_script_step' },
  );
}

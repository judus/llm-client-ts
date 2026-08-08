import type { CallOptions } from './call-options.js';
import { AiError } from './error.js';
import type { ModelStreamEvent } from './event.js';
import type { ModelCapabilities, ModelRequest, ModelResponse } from './model.js';
import type { ModelProvider } from './provider.js';
import { validateModelRequest } from './validate-request.js';

/** Provider-neutral low-level client. It never executes requested tools automatically. */
export class ModelClient {
  readonly #provider: ModelProvider;

  public constructor(provider: ModelProvider) {
    this.#provider = provider;
  }

  public async capabilities(request: ModelRequest): Promise<ModelCapabilities> {
    return this.#provider.capabilities(request.model);
  }

  public async generate(request: ModelRequest, options?: CallOptions): Promise<ModelResponse> {
    throwIfCancelled(options?.signal);
    const capabilities = await this.#provider.capabilities(request.model);
    validateModelRequest(request, capabilities, this.#provider.id, false);
    throwIfCancelled(options?.signal);
    return this.#provider.generate(request, options);
  }

  public async *stream(
    request: ModelRequest,
    options?: CallOptions,
  ): AsyncGenerator<ModelStreamEvent, void, void> {
    throwIfCancelled(options?.signal);
    const capabilities = await this.#provider.capabilities(request.model);
    validateModelRequest(request, capabilities, this.#provider.id, true);

    let expectedSequence = 0;
    let started = false;
    let terminal = false;

    for await (const event of this.#provider.stream(request, options)) {
      throwIfCancelled(options?.signal);

      if (terminal) {
        throw protocolError('The provider emitted an event after a terminal event.');
      }
      if (event.sequence !== expectedSequence) {
        throw protocolError(
          `Expected stream sequence ${String(expectedSequence)}, received ${String(event.sequence)}.`,
        );
      }
      if (!started && event.type !== 'model.request.started') {
        throw protocolError('The first provider event must be model.request.started.');
      }
      if (started && event.type === 'model.request.started') {
        throw protocolError('The provider emitted model.request.started more than once.');
      }

      started = true;
      terminal =
        event.type === 'model.response.completed' || event.type === 'model.response.failed';
      expectedSequence += 1;
      yield event;
    }

    if (!terminal) {
      throw protocolError('The provider stream ended without a terminal event.');
    }
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AiError('cancelled', 'The model request was cancelled.', {
      cause: signal.reason,
      code: 'request_cancelled',
    });
  }
}

function protocolError(message: string): AiError {
  return new AiError('malformed_response', message, {
    code: 'invalid_event_sequence',
  });
}

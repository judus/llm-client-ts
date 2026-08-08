import { AiError } from './error.js';
import type { ModelStreamEvent } from './event.js';
import type { ModelResponse } from './model.js';

export interface ReducedModelStream {
  readonly response: ModelResponse;
  readonly text: string;
}

/** Reduces a validated model stream into its canonical response and streamed text. */
export async function reduceModelStream(
  events: AsyncIterable<ModelStreamEvent>,
): Promise<ReducedModelStream> {
  let response: ModelResponse | undefined;
  let text = '';

  for await (const event of events) {
    if (event.type === 'model.text.delta') {
      text += event.delta;
    } else if (event.type === 'model.response.completed') {
      response = event.response;
    } else if (event.type === 'model.response.failed') {
      throw new AiError(event.error.category, event.error.message, {
        code: event.error.code,
        ...(event.error.details === undefined ? {} : { details: event.error.details }),
        retryable: event.error.retryable,
      });
    }
  }

  if (response === undefined) {
    throw new AiError('malformed_response', 'The stream did not contain a completed response.', {
      code: 'missing_completed_response',
    });
  }

  return { response, text };
}

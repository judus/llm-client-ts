import { describe, expect, it } from 'vitest';

import { AiError } from '@maduser/ai-ts';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';

import { mapOpenAIError } from '../src/error-mapper.js';

describe('mapOpenAIError', () => {
  it('normalizes rate limits without leaking provider response bodies', () => {
    const providerError = APIError.generate(
      429,
      { error: { code: 'rate_limit_exceeded', message: 'Slow down.' } },
      'Slow down.',
      new Headers({ 'x-request-id': 'request-openai-1' }),
    );

    expect(mapOpenAIError(providerError)).toMatchObject({
      category: 'rate_limit',
      code: 'rate_limit_exceeded',
      retryable: true,
    });
  });

  it.each([
    [400, 'invalid_request', false],
    [401, 'authentication', false],
    [403, 'authorization', false],
    [408, 'timeout', true],
    [409, 'invalid_request', true],
    [500, 'provider_unavailable', true],
  ] as const)('maps HTTP %s', (status, category, retryable) => {
    const error = APIError.generate(status, undefined, 'Provider error.', new Headers());

    expect(mapOpenAIError(error)).toMatchObject({ category, retryable });
  });

  it('maps connection, timeout, cancellation, and unknown failures', () => {
    expect(
      mapOpenAIError(new APIConnectionError({ cause: new Error('socket'), message: 'socket' })),
    ).toMatchObject({ category: 'transport', retryable: true });
    expect(mapOpenAIError(new APIConnectionTimeoutError())).toMatchObject({
      category: 'timeout',
      retryable: true,
    });
    expect(mapOpenAIError(new APIUserAbortError())).toMatchObject({ category: 'cancelled' });
    expect(mapOpenAIError(new Error('unknown'))).toMatchObject({
      category: 'transport',
      code: 'openai_unknown_error',
    });
  });

  it('preserves normalized errors and reads validated API error metadata', () => {
    const normalized = new AiError('invalid_request', 'Already normalized.', {
      code: 'normalized',
    });
    expect(mapOpenAIError(normalized)).toBe(normalized);

    expect(
      mapOpenAIError({
        code: null,
        message: 'Service unavailable.',
        requestID: 'provider-request-1',
        status: 503,
      }),
    ).toMatchObject({
      category: 'provider_unavailable',
      details: { providerRequestId: 'provider-request-1', status: 503 },
      retryable: true,
    });
  });
});

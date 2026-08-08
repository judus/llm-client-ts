import { describe, expect, it } from 'vitest';

import { AiError } from '@maduser/ai-ts';

import { mapBedrockError } from '../src/error-mapper.js';

describe('Bedrock error mapping', () => {
  it.each([
    ['AccessDeniedException', 'authorization', false],
    ['ValidationException', 'invalid_request', false],
    ['ThrottlingException', 'rate_limit', true],
    ['ServiceQuotaExceededException', 'rate_limit', false],
    ['ServiceUnavailableException', 'provider_unavailable', true],
    ['InternalServerException', 'provider_unavailable', true],
    ['ModelTimeoutException', 'timeout', true],
    ['CredentialsProviderError', 'authentication', false],
    ['ExpiredTokenException', 'authentication', false],
  ] as const)('maps %s', (name, category, retryable) => {
    expect(
      mapBedrockError({
        $metadata: { httpStatusCode: 429, requestId: 'aws-request-1' },
        message: 'AWS failed.',
        name,
      }),
    ).toMatchObject({
      category,
      details: { providerRequestId: 'aws-request-1', status: 429 },
      retryable,
    });
  });

  it('maps cancellation, timeout, and unknown transport failures', () => {
    expect(mapBedrockError({ message: 'abort', name: 'AbortError' })).toMatchObject({
      category: 'cancelled',
      code: 'bedrock_request_cancelled',
    });
    expect(mapBedrockError({ message: 'timeout', name: 'TimeoutError' })).toMatchObject({
      category: 'timeout',
      code: 'bedrock_timeout',
    });
    expect(mapBedrockError(new Error('network'))).toMatchObject({
      category: 'transport',
      code: 'bedrock_unknown_error',
    });
  });

  it('keeps canonical errors intact', () => {
    const error = new AiError('invalid_request', 'No.', { code: 'fixture' });
    expect(mapBedrockError(error)).toBe(error);
  });
});

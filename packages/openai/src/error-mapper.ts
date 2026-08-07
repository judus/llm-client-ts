import { AiError } from '@maduser/ai-ts';
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from 'openai';

export function mapOpenAIError(error: unknown): AiError {
  if (error instanceof AiError) {
    return error;
  }
  if (error instanceof APIUserAbortError) {
    return new AiError('cancelled', 'The OpenAI request was cancelled.', {
      cause: error,
      code: 'openai_request_cancelled',
    });
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new AiError('timeout', 'The OpenAI request timed out.', {
      cause: error,
      code: 'openai_timeout',
      retryable: true,
    });
  }
  if (error instanceof APIConnectionError) {
    return new AiError('transport', 'Could not connect to OpenAI.', {
      cause: error,
      code: 'openai_connection_error',
      retryable: true,
    });
  }
  if (isOpenAIApiError(error)) {
    return mapApiError(error);
  }
  return new AiError('transport', 'The OpenAI request failed.', {
    cause: error,
    code: 'openai_unknown_error',
  });
}

interface OpenAIApiErrorShape {
  readonly code: string | null | undefined;
  readonly message: string;
  readonly requestID: string | null | undefined;
  readonly status: number | undefined;
}

function mapApiError(error: OpenAIApiErrorShape): AiError {
  const status = error.status;
  const category =
    status === 401
      ? 'authentication'
      : status === 403
        ? 'authorization'
        : status === 408
          ? 'timeout'
          : status === 429
            ? 'rate_limit'
            : status !== undefined && status >= 500
              ? 'provider_unavailable'
              : 'invalid_request';
  const retryable = status === 408 || status === 409 || status === 429 || (status ?? 0) >= 500;

  return new AiError(category, error.message, {
    cause: error,
    code: error.code ?? `openai_http_${String(status ?? 'unknown')}`,
    details: {
      ...(error.requestID === undefined || error.requestID === null
        ? {}
        : { providerRequestId: error.requestID }),
      ...(status === undefined ? {} : { status }),
    },
    retryable,
  });
}

function isOpenAIApiError(error: unknown): error is OpenAIApiErrorShape {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if (!('message' in error) || typeof error.message !== 'string') {
    return false;
  }
  if (!('status' in error) && !('code' in error) && !('requestID' in error)) {
    return false;
  }
  const status = 'status' in error ? error.status : undefined;
  const code = 'code' in error ? error.code : undefined;
  const requestID = 'requestID' in error ? error.requestID : undefined;
  return (
    (status === undefined || typeof status === 'number') &&
    (code === undefined || code === null || typeof code === 'string') &&
    (requestID === undefined || requestID === null || typeof requestID === 'string')
  );
}

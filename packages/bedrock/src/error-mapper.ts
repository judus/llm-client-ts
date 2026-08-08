import { AiError, type AiErrorCategory, type JsonObject } from '@maduser/ai-ts';

interface AwsErrorShape {
  readonly $metadata?: {
    readonly httpStatusCode?: number;
    readonly requestId?: string;
  };
  readonly message: string;
  readonly name: string;
}

const awsErrors: Readonly<
  Record<string, { readonly category: AiErrorCategory; readonly retryable: boolean }>
> = {
  AccessDeniedException: { category: 'authorization', retryable: false },
  CredentialsProviderError: { category: 'authentication', retryable: false },
  ExpiredTokenException: { category: 'authentication', retryable: false },
  InternalServerException: { category: 'provider_unavailable', retryable: true },
  ModelErrorException: { category: 'provider_unavailable', retryable: true },
  ModelNotReadyException: { category: 'provider_unavailable', retryable: true },
  ModelStreamErrorException: { category: 'provider_unavailable', retryable: true },
  ModelTimeoutException: { category: 'timeout', retryable: true },
  InvalidSignatureException: { category: 'authentication', retryable: false },
  ResourceNotFoundException: { category: 'invalid_request', retryable: false },
  ServiceQuotaExceededException: { category: 'rate_limit', retryable: false },
  ServiceUnavailableException: { category: 'provider_unavailable', retryable: true },
  ThrottlingException: { category: 'rate_limit', retryable: true },
  UnrecognizedClientException: { category: 'authentication', retryable: false },
  ValidationException: { category: 'invalid_request', retryable: false },
};

export function mapBedrockError(error: unknown): AiError {
  if (error instanceof AiError) {
    return error;
  }
  if (isNamedError(error, 'AbortError')) {
    return new AiError('cancelled', 'The Bedrock request was cancelled.', {
      cause: error,
      code: 'bedrock_request_cancelled',
    });
  }
  if (isNamedError(error, 'TimeoutError')) {
    return new AiError('timeout', 'The Bedrock request timed out.', {
      cause: error,
      code: 'bedrock_timeout',
      retryable: true,
    });
  }
  if (isAwsError(error)) {
    const mapped = awsErrors[error.name];
    if (mapped !== undefined) {
      const details = awsDetails(error);
      return new AiError(mapped.category, error.message, {
        cause: error,
        code: `bedrock_${toSnakeCase(error.name)}`,
        ...(details === undefined ? {} : { details }),
        retryable: mapped.retryable,
      });
    }
  }
  return new AiError('transport', 'The Bedrock request failed.', {
    cause: error,
    code: 'bedrock_unknown_error',
  });
}

function awsDetails(error: AwsErrorShape): JsonObject | undefined {
  const status = error.$metadata?.httpStatusCode;
  const requestId = error.$metadata?.requestId;
  if (status === undefined && requestId === undefined) {
    return undefined;
  }
  return {
    ...(requestId === undefined ? {} : { providerRequestId: requestId }),
    ...(status === undefined ? {} : { status }),
  };
}

function isAwsError(error: unknown): error is AwsErrorShape {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

function isNamedError(error: unknown, name: string): boolean {
  return isAwsError(error) && error.name === name;
}

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase();
}

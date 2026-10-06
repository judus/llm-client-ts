import type { JsonObject } from './json.js';

export type AiErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'budget_exceeded'
  | 'cancelled'
  | 'content_policy'
  | 'invalid_request'
  | 'malformed_response'
  | 'persistence_conflict'
  | 'provider_unavailable'
  | 'rate_limit'
  | 'structured_output_validation'
  | 'timeout'
  | 'tool_execution'
  | 'tool_validation'
  | 'transport'
  | 'unsupported_capability';

export interface AiErrorOptions {
  readonly cause?: unknown;
  readonly code: string;
  readonly details?: JsonObject;
  readonly retryable?: boolean;
}

/** Stable error exposed by the suite. Diagnostic causes are never model-facing by default. */
export class AiError extends Error {
  public readonly category: AiErrorCategory;
  public readonly code: string;
  public readonly details: JsonObject | undefined;
  public readonly retryable: boolean;

  public constructor(category: AiErrorCategory, message: string, options: AiErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AiError';
    this.category = category;
    this.code = options.code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export interface SerializedAiError {
  readonly category: AiErrorCategory;
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
  readonly retryable: boolean;
}

/** An intentionally model-safe usage error. Never include credentials or raw argument values. */
export class ToolUsageError extends AiError {
  public constructor(
    toolName: string,
    problem: string,
    correction: string,
    options: { code?: string; details?: JsonObject } = {},
  ) {
    super('tool_validation', `Tool ${toolName}: ${problem} Correction: ${correction}`, {
      code: options.code ?? 'tool_usage_error',
      details: { ...options.details, toolName, correction },
      // Corrected arguments are required; retrying the same call cannot help.
      retryable: false,
    });
    this.name = 'ToolUsageError';
  }
}

export function serializeAiError(error: AiError): SerializedAiError {
  return {
    category: error.category,
    code: error.code,
    ...(error.details === undefined ? {} : { details: error.details }),
    message: error.message,
    retryable: error.retryable,
  };
}

export class UnsupportedCapabilityError extends AiError {
  public constructor(capability: string, model: string) {
    super('unsupported_capability', `Model ${model} does not support ${capability}.`, {
      code: 'unsupported_capability',
      details: { capability, model },
    });
    this.name = 'UnsupportedCapabilityError';
  }
}

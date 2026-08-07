import OpenAI, { toFile } from 'openai';

import {
  AiError,
  type CallOptions,
  type ProviderFileAdapter,
  type ProviderFileUpload,
  type ProviderFileUploadRequest,
} from '@maduser/ai-ts';

import type { OpenAIProviderOptions } from './configuration.js';

export type OpenAIFilePurpose =
  'assistants' | 'batch' | 'evals' | 'fine-tune' | 'user_data' | 'vision';

export interface OpenAIFileAdapterOptions extends OpenAIProviderOptions {
  /** Optional automatic expiry, from one hour through thirty days. */
  readonly expiresAfterSeconds?: number;
  /** Opaque scope this configured OpenAI client is allowed to serve. */
  readonly scopeId: string;
}

export interface OpenAIFileCreateRequest {
  readonly bytes: Uint8Array;
  readonly expiresAfterSeconds?: number;
  readonly filename: string;
  readonly mimeType: string;
  readonly purpose: OpenAIFilePurpose;
}

export interface OpenAIFileCreateResult {
  readonly expiresAt?: number;
  readonly fileId: string;
}

export interface OpenAIFileTransport {
  create(request: OpenAIFileCreateRequest, options: CallOptions): Promise<OpenAIFileCreateResult>;
  delete(fileId: string, options: CallOptions): Promise<{ readonly deleted: boolean }>;
}

export interface OpenAIFileAdapterDependencies {
  readonly transport: OpenAIFileTransport;
}

/** OpenAI Files API implementation of the provider-neutral file lifecycle port. */
export class OpenAIFileAdapter implements ProviderFileAdapter {
  public readonly provider = 'openai';
  readonly #expiresAfterSeconds: number | undefined;
  readonly #scopeId: string;
  readonly #transport: OpenAIFileTransport;

  public constructor(
    options: OpenAIFileAdapterOptions,
    dependencies?: OpenAIFileAdapterDependencies,
  ) {
    validateScope(options.scopeId);
    if (options.expiresAfterSeconds !== undefined) {
      validateExpiry(options.expiresAfterSeconds);
    }
    this.#expiresAfterSeconds = options.expiresAfterSeconds;
    this.#scopeId = options.scopeId;
    this.#transport = dependencies?.transport ?? new OpenAISdkFileTransport(options);
  }

  public async upload(
    request: ProviderFileUploadRequest,
    options: CallOptions = {},
  ): Promise<ProviderFileUpload> {
    this.#validateScope(request.scopeId);
    const purpose = parsePurpose(request.purpose);
    try {
      const result = await this.#transport.create(
        {
          bytes: request.artifact.bytes.slice(),
          ...(this.#expiresAfterSeconds === undefined
            ? {}
            : { expiresAfterSeconds: this.#expiresAfterSeconds }),
          filename: request.artifact.filename ?? request.artifact.id,
          mimeType: request.artifact.mimeType,
          purpose,
        },
        options,
      );
      if (result.fileId.trim().length === 0) {
        throw new AiError('malformed_response', 'OpenAI returned an empty file ID.', {
          code: 'invalid_openai_file_id',
        });
      }
      return {
        ...(result.expiresAt === undefined
          ? {}
          : { expiresAt: normalizeProviderExpiry(result.expiresAt) }),
        fileId: result.fileId,
      };
    } catch (error) {
      throw normalizeFileError(error, 'upload');
    }
  }

  public async delete(fileId: string, scopeId: string, options: CallOptions = {}): Promise<void> {
    this.#validateScope(scopeId);
    try {
      const result = await this.#transport.delete(fileId, options);
      if (!result.deleted) {
        throw new AiError('malformed_response', 'OpenAI did not confirm file deletion.', {
          code: 'openai_file_not_deleted',
          details: { providerFileId: fileId },
        });
      }
    } catch (error) {
      throw normalizeFileError(error, 'delete');
    }
  }

  #validateScope(scopeId: string): void {
    if (scopeId !== this.#scopeId) {
      throw new AiError('authorization', 'OpenAI file adapter scope mismatch.', {
        code: 'openai_file_scope_mismatch',
        details: { scopeId },
      });
    }
  }
}

class OpenAISdkFileTransport implements OpenAIFileTransport {
  readonly #client: OpenAI;

  public constructor(options: OpenAIProviderOptions) {
    this.#client = new OpenAI({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
      ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      ...(options.organization === undefined ? {} : { organization: options.organization }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
  }

  public async create(
    request: OpenAIFileCreateRequest,
    options: CallOptions,
  ): Promise<OpenAIFileCreateResult> {
    const file = await toFile(request.bytes, request.filename, { type: request.mimeType });
    const result = await this.#client.files.create(
      {
        ...(request.expiresAfterSeconds === undefined
          ? {}
          : {
              expires_after: {
                anchor: 'created_at',
                seconds: request.expiresAfterSeconds,
              },
            }),
        file,
        purpose: request.purpose,
      },
      sdkOptions(options),
    );
    return {
      ...(result.expires_at === undefined ? {} : { expiresAt: result.expires_at }),
      fileId: result.id,
    };
  }

  public async delete(
    fileId: string,
    options: CallOptions,
  ): Promise<{ readonly deleted: boolean }> {
    const result = await this.#client.files.delete(fileId, sdkOptions(options));
    return { deleted: result.deleted };
  }
}

function sdkOptions(options: CallOptions): {
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeout?: number;
} {
  return {
    ...(options.idempotencyKey === undefined
      ? {}
      : { headers: { 'Idempotency-Key': options.idempotencyKey } }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  };
}

function parsePurpose(value: string): OpenAIFilePurpose {
  if (
    value !== 'assistants' &&
    value !== 'batch' &&
    value !== 'evals' &&
    value !== 'fine-tune' &&
    value !== 'user_data' &&
    value !== 'vision'
  ) {
    throw new AiError('invalid_request', `Unsupported OpenAI file purpose: ${value}.`, {
      code: 'unsupported_openai_file_purpose',
      details: { purpose: value },
    });
  }
  return value;
}

function validateExpiry(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 3_600 || seconds > 2_592_000) {
    throw new AiError(
      'invalid_request',
      'OpenAI file expiry must be from 3600 to 2592000 seconds.',
      {
        code: 'invalid_openai_file_expiry',
        details: { seconds },
      },
    );
  }
}

function normalizeProviderExpiry(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new AiError('malformed_response', 'OpenAI returned an invalid file expiry.', {
      code: 'invalid_openai_file_expiry_response',
      details: { seconds },
    });
  }
  const date = new Date(seconds * 1_000);
  if (!Number.isFinite(date.getTime())) {
    throw new AiError('malformed_response', 'OpenAI returned an invalid file expiry.', {
      code: 'invalid_openai_file_expiry_response',
      details: { seconds },
    });
  }
  return date.toISOString();
}

function validateScope(scopeId: string): void {
  if (scopeId.trim().length === 0 || scopeId.length > 256) {
    throw new AiError('invalid_request', 'OpenAI file scope ID is invalid.', {
      code: 'invalid_openai_file_scope',
    });
  }
}

function normalizeFileError(error: unknown, operation: 'delete' | 'upload'): AiError {
  if (error instanceof AiError) {
    return error;
  }
  return new AiError('transport', `OpenAI file ${operation} failed.`, {
    cause: error,
    code: `openai_file_${operation}_failed`,
    retryable: true,
  });
}

import { AiError } from './error.js';
import type { JsonObject, JsonValue } from './json.js';

export interface ArtifactChecksum {
  readonly algorithm: 'sha256';
  readonly value: string;
}

export interface ArtifactRef {
  readonly byteLength: number;
  readonly checksum: ArtifactChecksum;
  readonly createdAt: string;
  readonly filename?: string;
  readonly id: string;
  readonly metadata?: JsonObject;
  readonly mimeType: string;
}

export interface Artifact extends ArtifactRef {
  readonly bytes: Uint8Array;
}

export type ArtifactSource = AsyncIterable<Uint8Array> | Uint8Array;

export interface PutArtifact {
  readonly filename?: string;
  readonly metadata?: JsonObject;
  readonly mimeType: string;
  readonly source: ArtifactSource;
}

export interface ArtifactWriteOptions {
  readonly signal?: AbortSignal;
}

export interface ArtifactStore {
  delete(id: string): Promise<void>;
  get(id: string): Promise<Artifact | undefined>;
  put(input: PutArtifact, options?: ArtifactWriteOptions): Promise<ArtifactRef>;
}

export interface InMemoryArtifactStoreOptions {
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly maxArtifactBytes?: number;
}

/** Bounded reference artifact store for tests and single-process applications. */
export class InMemoryArtifactStore implements ArtifactStore {
  readonly #artifacts = new Map<string, Artifact>();
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #maxArtifactBytes: number;

  public constructor(options: InMemoryArtifactStoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#maxArtifactBytes = positiveInteger(
      options.maxArtifactBytes ?? 100 * 1_024 * 1_024,
      'maxArtifactBytes',
    );
  }

  public async put(input: PutArtifact, options: ArtifactWriteOptions = {}): Promise<ArtifactRef> {
    validateMimeType(input.mimeType);
    if (input.filename !== undefined) {
      validateFilename(input.filename);
    }
    const metadata = input.metadata === undefined ? undefined : cloneMetadata(input.metadata);
    throwIfAborted(options.signal);
    const bytes = await collectSource(input.source, this.#maxArtifactBytes, options.signal);
    const checksum = await sha256(bytes);
    throwIfAborted(options.signal);
    const id = this.#idGenerator();
    validateArtifactId(id);
    if (this.#artifacts.has(id)) {
      throw new AiError('persistence_conflict', `Artifact ${id} already exists.`, {
        code: 'artifact_id_conflict',
        details: { artifactId: id },
        retryable: true,
      });
    }
    const artifact: Artifact = {
      byteLength: bytes.byteLength,
      bytes,
      checksum: { algorithm: 'sha256', value: checksum },
      createdAt: this.#clock().toISOString(),
      ...(input.filename === undefined ? {} : { filename: input.filename }),
      id,
      ...(metadata === undefined ? {} : { metadata }),
      mimeType: input.mimeType.toLowerCase(),
    };
    this.#artifacts.set(id, artifact);
    return reference(artifact);
  }

  public get(id: string): Promise<Artifact | undefined> {
    const artifact = this.#artifacts.get(id);
    return Promise.resolve(artifact === undefined ? undefined : cloneArtifact(artifact));
  }

  public delete(id: string): Promise<void> {
    this.#artifacts.delete(id);
    return Promise.resolve();
  }
}

async function collectSource(
  source: ArtifactSource,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (source instanceof Uint8Array) {
    ensureWithinLimit(source.byteLength, maxBytes);
    return source.slice();
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const chunk of source) {
      throwIfAborted(signal);
      if (!(chunk instanceof Uint8Array)) {
        throw new AiError('invalid_request', 'Artifact source emitted a non-binary chunk.', {
          code: 'invalid_artifact_chunk',
        });
      }
      byteLength += chunk.byteLength;
      ensureWithinLimit(byteLength, maxBytes);
      chunks.push(chunk.slice());
    }
  } catch (error) {
    if (error instanceof AiError) {
      throw error;
    }
    if (signal?.aborted === true) {
      throw cancelledArtifact(signal.reason);
    }
    throw new AiError('transport', 'Artifact source failed while reading.', {
      cause: error,
      code: 'artifact_source_failed',
    });
  }
  throwIfAborted(signal);
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function ensureWithinLimit(byteLength: number, maxBytes: number): void {
  if (byteLength > maxBytes) {
    throw new AiError('invalid_request', 'Artifact exceeds the configured byte limit.', {
      code: 'artifact_too_large',
      details: { byteLength, maxBytes },
    });
  }
}

function validateMimeType(mimeType: string): void {
  if (mimeType.length > 127 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(mimeType)) {
    throw new AiError('invalid_request', `Invalid artifact MIME type: ${mimeType}.`, {
      code: 'invalid_artifact_mime_type',
      details: { mimeType },
    });
  }
}

function validateFilename(filename: string): void {
  const byteLength = new TextEncoder().encode(filename).byteLength;
  if (
    filename === '.' ||
    filename === '..' ||
    filename.trim().length === 0 ||
    byteLength > 255 ||
    hasUnsafeFilenameCharacter(filename)
  ) {
    throw new AiError('invalid_request', `Invalid artifact filename: ${filename}.`, {
      code: 'invalid_artifact_filename',
      details: { filename },
    });
  }
}

function hasUnsafeFilenameCharacter(filename: string): boolean {
  for (let index = 0; index < filename.length; index += 1) {
    const codeUnit = filename.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127 || codeUnit === 47 || codeUnit === 92) {
      return true;
    }
  }
  return false;
}

function validateArtifactId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new AiError('invalid_request', 'Artifact ID generator returned an invalid identifier.', {
      code: 'invalid_artifact_id',
    });
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AiError('invalid_request', `${name} must be a positive integer.`, {
      code: 'invalid_artifact_limit',
      details: { name, value },
    });
  }
  return value;
}

function cloneMetadata(metadata: unknown): JsonObject {
  if (
    !isJsonValue(metadata) ||
    metadata === null ||
    typeof metadata !== 'object' ||
    isJsonArray(metadata)
  ) {
    throw new AiError('invalid_request', 'Artifact metadata must be a JSON object.', {
      code: 'invalid_artifact_metadata',
    });
  }
  return structuredClone(metadata);
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw cancelledArtifact(signal.reason);
  }
}

function cancelledArtifact(cause: unknown): AiError {
  return new AiError('cancelled', 'Artifact write was cancelled.', {
    cause,
    code: 'artifact_write_cancelled',
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function reference(artifact: Artifact): ArtifactRef {
  return {
    byteLength: artifact.byteLength,
    checksum: structuredClone(artifact.checksum),
    createdAt: artifact.createdAt,
    ...(artifact.filename === undefined ? {} : { filename: artifact.filename }),
    id: artifact.id,
    ...(artifact.metadata === undefined ? {} : { metadata: structuredClone(artifact.metadata) }),
    mimeType: artifact.mimeType,
  };
}

function cloneArtifact(artifact: Artifact): Artifact {
  return { ...reference(artifact), bytes: artifact.bytes.slice() };
}

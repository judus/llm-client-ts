import type { Artifact, ArtifactChecksum, ArtifactStore } from './artifact-store.js';
import type { CallOptions } from './call-options.js';
import { AiError } from './error.js';

export interface ProviderFileUploadRequest {
  readonly artifact: Artifact;
  readonly purpose: string;
  /** Opaque tenant and credential boundary. Never place credentials in this value. */
  readonly scopeId: string;
}

export interface ProviderFileUpload {
  readonly expiresAt?: string;
  readonly fileId: string;
}

export interface ProviderFileAdapter {
  delete(fileId: string, scopeId: string, options?: CallOptions): Promise<void>;
  readonly provider: string;
  upload(request: ProviderFileUploadRequest, options?: CallOptions): Promise<ProviderFileUpload>;
}

export interface AcquireProviderFileLease {
  readonly artifactId: string;
  readonly deleteOnRelease?: boolean;
  readonly leaseDurationMs?: number;
  readonly purpose: string;
  readonly scopeId: string;
}

export interface ProviderFileLease {
  readonly acquiredAt: string;
  readonly artifactChecksum: ArtifactChecksum;
  readonly artifactId: string;
  readonly deleteOnRelease: boolean;
  readonly expiresAt: string;
  readonly id: string;
  readonly provider: string;
  readonly providerFileId: string;
  readonly purpose: string;
  readonly reused: boolean;
  readonly scopeId: string;
}

export type ProviderFileLifecycleEvent =
  | ProviderFileEventBase<'provider_file.cleanup_failed'>
  | ProviderFileEventBase<'provider_file.deleted'>
  | ProviderFileEventBase<'provider_file.lease_expired'>
  | ProviderFileEventBase<'provider_file.released'>
  | ProviderFileEventBase<'provider_file.reused'>
  | ProviderFileEventBase<'provider_file.uploaded'>;

export interface ProviderFileEventBase<Type extends string> {
  readonly errorCode?: string;
  readonly leaseId?: string;
  readonly provider: string;
  readonly providerFileId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly type: Type;
}

export interface ProviderFileCleanupFailure {
  readonly code: string;
  readonly providerFileId: string;
}

export interface ProviderFileCleanupReport {
  readonly deleted: number;
  readonly expiredLeases: number;
  readonly failures: readonly ProviderFileCleanupFailure[];
}

export interface ProviderFileLeaseManagerOptions {
  readonly adapter: ProviderFileAdapter;
  readonly artifacts: ArtifactStore;
  readonly clock?: () => Date;
  readonly defaultLeaseDurationMs?: number;
  readonly idGenerator?: () => string;
}

interface RemoteFile {
  readonly cacheKey: string;
  readonly deleteOnRelease: boolean;
  readonly expiresAt?: string;
  readonly fileId: string;
  references: number;
  readonly scopeId: string;
}

interface StoredLease {
  readonly lease: ProviderFileLease;
  readonly remote: RemoteFile;
  released: boolean;
}

/** Coordinates scoped provider-file reuse and deterministic cleanup. */
export class ProviderFileLeaseManager {
  readonly #adapter: ProviderFileAdapter;
  readonly #artifacts: ArtifactStore;
  readonly #clock: () => Date;
  readonly #defaultLeaseDurationMs: number;
  readonly #events: ProviderFileLifecycleEvent[] = [];
  readonly #idGenerator: () => string;
  readonly #leases = new Map<string, StoredLease>();
  readonly #pendingUploads = new Map<string, Promise<RemoteFile>>();
  readonly #remoteFiles = new Set<RemoteFile>();
  readonly #reusable = new Map<string, RemoteFile>();
  #sequence = 0;

  public constructor(options: ProviderFileLeaseManagerOptions) {
    this.#adapter = options.adapter;
    this.#artifacts = options.artifacts;
    this.#clock = options.clock ?? (() => new Date());
    this.#defaultLeaseDurationMs = positiveDuration(
      options.defaultLeaseDurationMs ?? 60 * 60 * 1_000,
      'defaultLeaseDurationMs',
    );
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    validateIdentifier('provider', options.adapter.provider);
  }

  public get events(): readonly ProviderFileLifecycleEvent[] {
    return structuredClone(this.#events);
  }

  public async acquire(
    request: AcquireProviderFileLease,
    options: CallOptions = {},
  ): Promise<ProviderFileLease> {
    validateIdentifier('scope ID', request.scopeId);
    validateIdentifier('purpose', request.purpose);
    const durationMs = positiveDuration(
      request.leaseDurationMs ?? this.#defaultLeaseDurationMs,
      'leaseDurationMs',
    );
    throwIfAborted(options.signal);
    const artifact = await this.#artifacts.get(request.artifactId);
    if (artifact === undefined) {
      throw new AiError('invalid_request', `Artifact ${request.artifactId} does not exist.`, {
        code: 'provider_file_artifact_not_found',
        details: { artifactId: request.artifactId },
      });
    }
    throwIfAborted(options.signal);
    const deleteOnRelease = request.deleteOnRelease ?? true;
    const cacheKey = reusableKey(
      this.#adapter.provider,
      request.scopeId,
      request.purpose,
      artifact.checksum,
      deleteOnRelease,
    );
    const now = this.#clock();
    const candidate = this.#reusable.get(cacheKey);
    let remote: RemoteFile;
    let reused: boolean;
    if (candidate !== undefined && !isExpired(candidate.expiresAt, now)) {
      remote = candidate;
      reused = true;
    } else {
      if (candidate !== undefined) {
        this.#reusable.delete(cacheKey);
      }
      remote = await this.#upload(cacheKey, artifact, request, deleteOnRelease);
      reused = remote.references > 0;
    }
    throwIfAborted(options.signal);
    const acquiredAt = this.#clock();
    const requestedExpiry = new Date(acquiredAt.getTime() + durationMs);
    const expiresAt = earlierDate(requestedExpiry, remote.expiresAt);
    const leaseId = this.#idGenerator();
    validateIdentifier('provider file lease ID', leaseId);
    if (this.#leases.has(leaseId)) {
      throw new AiError('persistence_conflict', `Provider file lease ${leaseId} already exists.`, {
        code: 'provider_file_lease_id_conflict',
        details: { leaseId },
        retryable: true,
      });
    }
    const lease: ProviderFileLease = {
      acquiredAt: acquiredAt.toISOString(),
      artifactChecksum: structuredClone(artifact.checksum),
      artifactId: artifact.id,
      deleteOnRelease,
      expiresAt: expiresAt.toISOString(),
      id: leaseId,
      provider: this.#adapter.provider,
      providerFileId: remote.fileId,
      purpose: request.purpose,
      reused,
      scopeId: request.scopeId,
    };
    remote.references += 1;
    this.#leases.set(lease.id, { lease, released: false, remote });
    this.#emit(reused ? 'provider_file.reused' : 'provider_file.uploaded', remote.fileId, lease.id);
    return structuredClone(lease);
  }

  public get(leaseId: string): ProviderFileLease | undefined {
    const stored = this.#leases.get(leaseId);
    return stored === undefined || stored.released ? undefined : structuredClone(stored.lease);
  }

  public async release(leaseId: string, options: CallOptions = {}): Promise<void> {
    const stored = this.#leases.get(leaseId);
    if (stored === undefined || stored.released) {
      return;
    }
    stored.released = true;
    stored.remote.references -= 1;
    this.#emit('provider_file.released', stored.remote.fileId, leaseId);
    if (stored.remote.references === 0 && stored.remote.deleteOnRelease) {
      await this.#deleteRemote(stored.remote, options);
    }
  }

  public async cleanup(options: CallOptions = {}): Promise<ProviderFileCleanupReport> {
    const failures: ProviderFileCleanupFailure[] = [];
    let deleted = 0;
    let expiredLeases = 0;
    const now = this.#clock();
    for (const stored of this.#leases.values()) {
      if (!stored.released && Date.parse(stored.lease.expiresAt) <= now.getTime()) {
        stored.released = true;
        stored.remote.references -= 1;
        expiredLeases += 1;
        this.#emit('provider_file.lease_expired', stored.remote.fileId, stored.lease.id);
      }
    }
    for (const remote of [...this.#remoteFiles]) {
      throwIfAborted(options.signal);
      if (remote.references !== 0 || !remote.deleteOnRelease) {
        continue;
      }
      try {
        await this.#deleteRemote(remote, options);
        deleted += 1;
      } catch (error) {
        const normalized = normalizeProviderFileError(error, 'delete', remote.fileId);
        failures.push({ code: normalized.code, providerFileId: remote.fileId });
      }
    }
    return { deleted, expiredLeases, failures };
  }

  async #upload(
    cacheKey: string,
    artifact: Artifact,
    request: AcquireProviderFileLease,
    deleteOnRelease: boolean,
  ): Promise<RemoteFile> {
    let pending = this.#pendingUploads.get(cacheKey);
    if (pending === undefined) {
      pending = this.#performUpload(cacheKey, artifact, request, deleteOnRelease);
      this.#pendingUploads.set(cacheKey, pending);
    }
    try {
      return await pending;
    } finally {
      if (this.#pendingUploads.get(cacheKey) === pending) {
        this.#pendingUploads.delete(cacheKey);
      }
    }
  }

  async #performUpload(
    cacheKey: string,
    artifact: Artifact,
    request: AcquireProviderFileLease,
    deleteOnRelease: boolean,
  ): Promise<RemoteFile> {
    let upload: ProviderFileUpload;
    try {
      upload = await this.#adapter.upload({
        artifact,
        purpose: request.purpose,
        scopeId: request.scopeId,
      });
    } catch (error) {
      throw normalizeProviderFileError(error, 'upload');
    }
    validateIdentifier('provider file ID', upload.fileId);
    if (upload.expiresAt !== undefined && isExpired(upload.expiresAt, this.#clock())) {
      throw new AiError('malformed_response', 'Provider returned an expired file.', {
        code: 'provider_file_already_expired',
        details: { providerFileId: upload.fileId },
      });
    }
    const remote: RemoteFile = {
      cacheKey,
      deleteOnRelease,
      ...(upload.expiresAt === undefined ? {} : { expiresAt: normalizeDate(upload.expiresAt) }),
      fileId: upload.fileId,
      references: 0,
      scopeId: request.scopeId,
    };
    this.#remoteFiles.add(remote);
    this.#reusable.set(cacheKey, remote);
    return remote;
  }

  async #deleteRemote(remote: RemoteFile, options: CallOptions): Promise<void> {
    try {
      await this.#adapter.delete(remote.fileId, remote.scopeId, options);
    } catch (error) {
      const normalized = normalizeProviderFileError(error, 'delete', remote.fileId);
      this.#emit('provider_file.cleanup_failed', remote.fileId, undefined, normalized.code);
      throw normalized;
    }
    this.#remoteFiles.delete(remote);
    if (this.#reusable.get(remote.cacheKey) === remote) {
      this.#reusable.delete(remote.cacheKey);
    }
    this.#emit('provider_file.deleted', remote.fileId);
  }

  #emit(
    type: ProviderFileLifecycleEvent['type'],
    providerFileId: string,
    leaseId?: string,
    errorCode?: string,
  ): void {
    this.#events.push({
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(leaseId === undefined ? {} : { leaseId }),
      provider: this.#adapter.provider,
      providerFileId,
      sequence: this.#sequence,
      timestamp: this.#clock().toISOString(),
      type,
    });
    this.#sequence += 1;
  }
}

function reusableKey(
  provider: string,
  scopeId: string,
  purpose: string,
  checksum: ArtifactChecksum,
  deleteOnRelease: boolean,
): string {
  return JSON.stringify([
    provider,
    scopeId,
    purpose,
    checksum.algorithm,
    checksum.value,
    deleteOnRelease,
  ]);
}

function earlierDate(requested: Date, providerExpiry: string | undefined): Date {
  if (providerExpiry === undefined) {
    return requested;
  }
  const provider = new Date(providerExpiry);
  return provider.getTime() < requested.getTime() ? provider : requested;
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  return expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime();
}

function normalizeDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new AiError('malformed_response', 'Provider returned an invalid file expiry.', {
      code: 'invalid_provider_file_expiry',
    });
  }
  return new Date(timestamp).toISOString();
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AiError('invalid_request', `${name} must be a positive integer.`, {
      code: 'invalid_provider_file_duration',
      details: { name, value },
    });
  }
  return value;
}

function validateIdentifier(label: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) {
    throw new AiError('invalid_request', `Invalid ${label}: ${value}.`, {
      code: 'invalid_provider_file_identifier',
      details: { label, value },
    });
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AiError('cancelled', 'Provider file operation was cancelled.', {
      cause: signal.reason,
      code: 'provider_file_cancelled',
    });
  }
}

function normalizeProviderFileError(
  error: unknown,
  operation: 'delete' | 'upload',
  providerFileId?: string,
): AiError {
  if (error instanceof AiError) {
    return error;
  }
  return new AiError('transport', `Provider file ${operation} failed.`, {
    cause: error,
    code: `provider_file_${operation}_failed`,
    details: {
      operation,
      ...(providerFileId === undefined ? {} : { providerFileId }),
    },
    retryable: true,
  });
}

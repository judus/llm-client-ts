import { describe, expect, it } from 'vitest';

import {
  AiError,
  InMemoryArtifactStore,
  ProviderFileLeaseManager,
  type Artifact,
  type ProviderFileAdapter,
  type ProviderFileUpload,
  type ProviderFileUploadRequest,
} from '../src/index.js';

class FakeProviderFiles implements ProviderFileAdapter {
  public deletes: { readonly fileId: string; readonly scopeId: string }[] = [];
  public readonly provider = 'fixture';
  public uploads: ProviderFileUploadRequest[] = [];
  public uploadResult: ProviderFileUpload = { fileId: 'file-1' };

  public delete(fileId: string, scopeId: string): Promise<void> {
    this.deletes.push({ fileId, scopeId });
    return Promise.resolve();
  }

  public upload(request: ProviderFileUploadRequest): Promise<ProviderFileUpload> {
    this.uploads.push(cloneUploadRequest(request));
    return Promise.resolve(this.uploadResult);
  }
}

async function fixtureArtifactStore(): Promise<{
  readonly artifactId: string;
  readonly artifacts: InMemoryArtifactStore;
}> {
  const artifacts = new InMemoryArtifactStore({ idGenerator: () => 'artifact-1' });
  const artifact = await artifacts.put({
    filename: 'document.txt',
    mimeType: 'text/plain',
    source: new TextEncoder().encode('document'),
  });
  return { artifactId: artifact.id, artifacts };
}

describe('ProviderFileLeaseManager', () => {
  it('deduplicates concurrent uploads and deletes after the final release', async () => {
    const { artifactId, artifacts } = await fixtureArtifactStore();
    const adapter = new FakeProviderFiles();
    let id = 0;
    const manager = new ProviderFileLeaseManager({
      adapter,
      artifacts,
      clock: () => new Date('2026-08-07T12:00:00.000Z'),
      idGenerator: () => `lease-${String(++id)}`,
    });
    const request = { artifactId, purpose: 'user_data', scopeId: 'tenant-1' };
    const [first, second] = await Promise.all([manager.acquire(request), manager.acquire(request)]);

    expect(adapter.uploads).toHaveLength(1);
    expect(first.providerFileId).toBe('file-1');
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    await manager.release(first.id);
    expect(adapter.deletes).toHaveLength(0);
    await manager.release(second.id);
    expect(adapter.deletes).toEqual([{ fileId: 'file-1', scopeId: 'tenant-1' }]);
    await manager.release(second.id);
    expect(manager.events.map(({ type }) => type)).toEqual([
      'provider_file.uploaded',
      'provider_file.reused',
      'provider_file.released',
      'provider_file.released',
      'provider_file.deleted',
    ]);
  });

  it('never reuses provider files across scope, purpose, or cleanup policy', async () => {
    const { artifactId, artifacts } = await fixtureArtifactStore();
    const adapter = new FakeProviderFiles();
    let file = 0;
    adapter.upload = (request) => {
      adapter.uploads.push(cloneUploadRequest(request));
      return Promise.resolve({ fileId: `file-${String(++file)}` });
    };
    let lease = 0;
    const manager = new ProviderFileLeaseManager({
      adapter,
      artifacts,
      idGenerator: () => `lease-${String(++lease)}`,
    });
    await manager.acquire({ artifactId, purpose: 'purpose-a', scopeId: 'scope-a' });
    await manager.acquire({ artifactId, purpose: 'purpose-a', scopeId: 'scope-b' });
    await manager.acquire({ artifactId, purpose: 'purpose-b', scopeId: 'scope-a' });
    await manager.acquire({
      artifactId,
      deleteOnRelease: false,
      purpose: 'purpose-a',
      scopeId: 'scope-a',
    });
    expect(adapter.uploads).toHaveLength(4);
  });

  it('caps leases at provider expiry and replaces expired remote files', async () => {
    const { artifactId, artifacts } = await fixtureArtifactStore();
    const adapter = new FakeProviderFiles();
    let upload = 0;
    adapter.upload = (request) => {
      adapter.uploads.push(cloneUploadRequest(request));
      upload += 1;
      return Promise.resolve({
        expiresAt: upload === 1 ? '2026-08-07T12:00:00.500Z' : '2026-08-07T12:00:05.000Z',
        fileId: `file-${String(upload)}`,
      });
    };
    let now = new Date('2026-08-07T12:00:00.000Z');
    let lease = 0;
    const manager = new ProviderFileLeaseManager({
      adapter,
      artifacts,
      clock: () => now,
      idGenerator: () => `lease-${String(++lease)}`,
    });
    const first = await manager.acquire({
      artifactId,
      leaseDurationMs: 1_000,
      purpose: 'user_data',
      scopeId: 'tenant-1',
    });
    expect(first.expiresAt).toBe('2026-08-07T12:00:00.500Z');
    expect(manager.get(first.id)).toEqual(first);

    now = new Date('2026-08-07T12:00:01.000Z');
    const second = await manager.acquire({
      artifactId,
      leaseDurationMs: 1_000,
      purpose: 'user_data',
      scopeId: 'tenant-1',
    });
    expect(second.providerFileId).toBe('file-2');
    expect(second.expiresAt).toBe('2026-08-07T12:00:02.000Z');
    expect(adapter.uploads).toHaveLength(2);
  });

  it('retains reusable files when deletion on release is disabled', async () => {
    const { artifactId, artifacts } = await fixtureArtifactStore();
    let now = new Date('2026-08-07T12:00:00.000Z');
    const adapter = new FakeProviderFiles();
    let lease = 0;
    const manager = new ProviderFileLeaseManager({
      adapter,
      artifacts,
      clock: () => now,
      idGenerator: () => `lease-${String(++lease)}`,
    });
    const first = await manager.acquire({
      artifactId,
      deleteOnRelease: false,
      leaseDurationMs: 1,
      purpose: 'user_data',
      scopeId: 'tenant-1',
    });
    now = new Date('2026-08-07T12:00:00.002Z');
    await expect(manager.cleanup()).resolves.toMatchObject({ expiredLeases: 1 });
    expect(adapter.deletes).toHaveLength(0);
    const reused = await manager.acquire({
      artifactId,
      deleteOnRelease: false,
      purpose: 'user_data',
      scopeId: 'tenant-1',
    });
    expect(reused.reused).toBe(true);
    expect(reused.providerFileId).toBe(first.providerFileId);
    await manager.release('missing');
  });

  it('expires leases, reports cleanup failures, and retries cleanup', async () => {
    const { artifactId, artifacts } = await fixtureArtifactStore();
    const adapter = new FakeProviderFiles();
    let failDelete = true;
    adapter.delete = (fileId, scopeId) => {
      adapter.deletes.push({ fileId, scopeId });
      return failDelete ? Promise.reject(new Error('offline')) : Promise.resolve();
    };
    let now = new Date('2026-08-07T12:00:00.000Z');
    const manager = new ProviderFileLeaseManager({
      adapter,
      artifacts,
      clock: () => now,
      idGenerator: () => 'lease-1',
    });
    const lease = await manager.acquire({
      artifactId,
      leaseDurationMs: 1_000,
      purpose: 'user_data',
      scopeId: 'tenant-1',
    });
    now = new Date('2026-08-07T12:00:02.000Z');
    await expect(manager.cleanup()).resolves.toEqual({
      deleted: 0,
      expiredLeases: 1,
      failures: [{ code: 'provider_file_delete_failed', providerFileId: 'file-1' }],
    });
    expect(manager.get(lease.id)).toBeUndefined();
    failDelete = false;
    await expect(manager.cleanup()).resolves.toEqual({
      deleted: 1,
      expiredLeases: 0,
      failures: [],
    });
    expect(manager.events.some(({ type }) => type === 'provider_file.cleanup_failed')).toBe(true);
  });

  it('validates requests, missing artifacts, provider responses, and cancellation', async () => {
    const { artifacts } = await fixtureArtifactStore();
    const adapter = new FakeProviderFiles();
    const manager = new ProviderFileLeaseManager({
      adapter,
      artifacts,
      idGenerator: () => 'lease-1',
    });
    await expect(
      manager.acquire({ artifactId: 'missing', purpose: 'user_data', scopeId: 'tenant-1' }),
    ).rejects.toMatchObject({ code: 'provider_file_artifact_not_found' });
    await expect(
      manager.acquire({ artifactId: 'artifact-1', purpose: 'bad purpose', scopeId: 'tenant-1' }),
    ).rejects.toMatchObject({ code: 'invalid_provider_file_identifier' });

    const cancelled = new AbortController();
    cancelled.abort('stop');
    await expect(
      manager.acquire(
        { artifactId: 'artifact-1', purpose: 'user_data', scopeId: 'tenant-1' },
        { signal: cancelled.signal },
      ),
    ).rejects.toMatchObject({ code: 'provider_file_cancelled' });

    adapter.uploadResult = { expiresAt: '2020-01-01T00:00:00.000Z', fileId: 'file-expired' };
    await expect(
      manager.acquire({ artifactId: 'artifact-1', purpose: 'user_data', scopeId: 'tenant-1' }),
    ).rejects.toMatchObject({ code: 'provider_file_already_expired' });

    adapter.uploadResult = { expiresAt: 'not-a-date', fileId: 'file-invalid-date' };
    await expect(
      manager.acquire({ artifactId: 'artifact-1', purpose: 'other', scopeId: 'tenant-1' }),
    ).rejects.toMatchObject({ code: 'invalid_provider_file_expiry' });

    expect(
      () => new ProviderFileLeaseManager({ adapter, artifacts, defaultLeaseDurationMs: 0 }),
    ).toThrow(expect.objectContaining({ code: 'invalid_provider_file_duration' }));
  });

  it('rejects duplicate lease IDs and cancellation during cleanup', async () => {
    const { artifactId, artifacts } = await fixtureArtifactStore();
    const adapter = new FakeProviderFiles();
    const manager = new ProviderFileLeaseManager({
      adapter,
      artifacts,
      idGenerator: () => 'same-lease',
    });
    await manager.acquire({ artifactId, purpose: 'first', scopeId: 'tenant-1' });
    await expect(
      manager.acquire({ artifactId, purpose: 'second', scopeId: 'tenant-1' }),
    ).rejects.toMatchObject({ code: 'provider_file_lease_id_conflict', retryable: true });
    const controller = new AbortController();
    controller.abort('stop');
    await expect(manager.cleanup({ signal: controller.signal })).rejects.toMatchObject({
      code: 'provider_file_cancelled',
    });
  });

  it('preserves typed adapter errors and normalizes unknown upload failures', async () => {
    const { artifactId, artifacts } = await fixtureArtifactStore();
    const adapter = new FakeProviderFiles();
    const manager = new ProviderFileLeaseManager({ adapter, artifacts });
    adapter.upload = () => Promise.reject(new Error('network'));
    await expect(
      manager.acquire({ artifactId, purpose: 'user_data', scopeId: 'tenant-1' }),
    ).rejects.toMatchObject({ code: 'provider_file_upload_failed', retryable: true });

    adapter.upload = () =>
      Promise.reject(new AiError('authorization', 'Denied.', { code: 'upload_denied' }));
    await expect(
      manager.acquire({ artifactId, purpose: 'user_data', scopeId: 'tenant-1' }),
    ).rejects.toMatchObject({ code: 'upload_denied' });
  });
});

function cloneUploadRequest(request: ProviderFileUploadRequest): ProviderFileUploadRequest {
  return {
    artifact: cloneArtifact(request.artifact),
    purpose: request.purpose,
    scopeId: request.scopeId,
  };
}

function cloneArtifact(artifact: Artifact): Artifact {
  return {
    ...artifact,
    bytes: artifact.bytes.slice(),
    checksum: structuredClone(artifact.checksum),
    ...(artifact.metadata === undefined ? {} : { metadata: structuredClone(artifact.metadata) }),
  };
}

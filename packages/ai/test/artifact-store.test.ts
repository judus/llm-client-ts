import { describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../src/index.js';

function store(maxArtifactBytes = 1_024): InMemoryArtifactStore {
  return new InMemoryArtifactStore({
    clock: () => new Date('2026-08-07T12:00:00.000Z'),
    idGenerator: () => 'artifact-1',
    maxArtifactBytes,
  });
}

describe('InMemoryArtifactStore', () => {
  it('stores immutable bytes and metadata with a deterministic checksum', async () => {
    const artifacts = store();
    const bytes = new Uint8Array([97, 98, 99]);
    const metadata = { classification: 'internal', tenant: 'tenant-1' };
    const ref = await artifacts.put({
      filename: 'brief.txt',
      metadata,
      mimeType: 'Text/Plain',
      source: bytes,
    });
    bytes[0] = 0;
    metadata.classification = 'changed';

    expect(ref).toEqual({
      byteLength: 3,
      checksum: {
        algorithm: 'sha256',
        value: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      },
      createdAt: '2026-08-07T12:00:00.000Z',
      filename: 'brief.txt',
      id: 'artifact-1',
      metadata: { classification: 'internal', tenant: 'tenant-1' },
      mimeType: 'text/plain',
    });
    const first = await artifacts.get(ref.id);
    expect(first?.bytes).toEqual(new Uint8Array([97, 98, 99]));
    if (first !== undefined) {
      first.bytes[0] = 1;
    }
    expect((await artifacts.get(ref.id))?.bytes).toEqual(new Uint8Array([97, 98, 99]));
    await artifacts.delete(ref.id);
    await artifacts.delete(ref.id);
    await expect(artifacts.get(ref.id)).resolves.toBeUndefined();
  });

  it('collects a bounded asynchronous source in order', async () => {
    async function* source(): AsyncGenerator<Uint8Array, void, void> {
      yield new Uint8Array([1, 2]);
      await Promise.resolve();
      yield new Uint8Array([3]);
    }
    const artifacts = store(3);
    const ref = await artifacts.put({ mimeType: 'application/octet-stream', source: source() });
    expect(ref.byteLength).toBe(3);
    expect((await artifacts.get(ref.id))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects invalid metadata fields, IDs, limits, and oversized input', async () => {
    expect(() => new InMemoryArtifactStore({ maxArtifactBytes: 0 })).toThrow(
      expect.objectContaining({ code: 'invalid_artifact_limit' }),
    );
    await expect(
      store().put({ filename: '../secret.txt', mimeType: 'text/plain', source: new Uint8Array() }),
    ).rejects.toMatchObject({ code: 'invalid_artifact_filename' });
    await expect(
      store().put({ mimeType: 'text/plain; charset=utf-8', source: new Uint8Array() }),
    ).rejects.toMatchObject({ code: 'invalid_artifact_mime_type' });
    await expect(
      new InMemoryArtifactStore({ idGenerator: () => 'bad id' }).put({
        mimeType: 'text/plain',
        source: new Uint8Array(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_artifact_id' });
    await expect(
      store(2).put({ mimeType: 'application/octet-stream', source: new Uint8Array(3) }),
    ).rejects.toMatchObject({ code: 'artifact_too_large' });
    const invalidMetadata = {
      metadata: {},
      mimeType: 'text/plain',
      source: new Uint8Array(),
    };
    Reflect.set(invalidMetadata.metadata, 'invalid', undefined);
    await expect(store().put(invalidMetadata)).rejects.toMatchObject({
      code: 'invalid_artifact_metadata',
    });
  });

  it('rejects duplicate generated IDs without overwriting the first artifact', async () => {
    const artifacts = store();
    await artifacts.put({ mimeType: 'text/plain', source: new Uint8Array([1]) });
    await expect(
      artifacts.put({ mimeType: 'text/plain', source: new Uint8Array([2]) }),
    ).rejects.toMatchObject({ code: 'artifact_id_conflict', retryable: true });
    expect((await artifacts.get('artifact-1'))?.bytes).toEqual(new Uint8Array([1]));
  });

  it('commits at most one artifact when concurrent writes generate the same ID', async () => {
    const artifacts = store();
    const writes = await Promise.allSettled([
      artifacts.put({ mimeType: 'text/plain', source: new Uint8Array([1]) }),
      artifacts.put({ mimeType: 'text/plain', source: new Uint8Array([2]) }),
    ]);
    expect(writes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
  });

  it('normalizes stream failures and cancellation without storing partial data', async () => {
    async function* broken(): AsyncGenerator<Uint8Array, void, void> {
      yield new Uint8Array([1]);
      await Promise.resolve();
      throw new Error('read failed');
    }
    await expect(
      store().put({ mimeType: 'application/octet-stream', source: broken() }),
    ).rejects.toMatchObject({ code: 'artifact_source_failed' });

    const controller = new AbortController();
    controller.abort('stop');
    await expect(
      store().put(
        { mimeType: 'application/octet-stream', source: new Uint8Array([1]) },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'artifact_write_cancelled' });
  });
});

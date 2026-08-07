import { describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  constructors: [] as unknown[],
  creates: [] as unknown[],
  deletes: [] as unknown[],
  toFiles: [] as unknown[],
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    public readonly files = {
      create: (request: unknown, options: unknown) => {
        sdk.creates.push({ options, request });
        return Promise.resolve({
          expires_at: 1_786_104_000,
          id: 'file-sdk',
        });
      },
      delete: (fileId: string, options: unknown) => {
        sdk.deletes.push({ fileId, options });
        return Promise.resolve({ deleted: true });
      },
    };

    public constructor(options: unknown) {
      sdk.constructors.push(options);
    }
  },
  toFile: (bytes: Uint8Array, filename: string, options: unknown) => {
    sdk.toFiles.push({ bytes: bytes.slice(), filename, options });
    return Promise.resolve({ mockFile: filename });
  },
}));

import type { ProviderFileUploadRequest } from '@maduser/ai-ts';
import {
  OpenAIFileAdapter,
  type OpenAIFileCreateRequest,
  type OpenAIFileCreateResult,
  type OpenAIFileTransport,
} from '../src/index.js';

class FakeFileTransport implements OpenAIFileTransport {
  public creates: OpenAIFileCreateRequest[] = [];
  public createResult: OpenAIFileCreateResult = {
    expiresAt: 1_786_104_000,
    fileId: 'file-1',
  };
  public deletes: string[] = [];
  public deleted = true;

  public create(request: OpenAIFileCreateRequest): Promise<OpenAIFileCreateResult> {
    this.creates.push(structuredClone(request));
    return Promise.resolve(this.createResult);
  }

  public delete(fileId: string): Promise<{ readonly deleted: boolean }> {
    this.deletes.push(fileId);
    return Promise.resolve({ deleted: this.deleted });
  }
}

function uploadRequest(
  overrides: Partial<ProviderFileUploadRequest> = {},
): ProviderFileUploadRequest {
  return {
    artifact: {
      byteLength: 3,
      bytes: new Uint8Array([1, 2, 3]),
      checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
      createdAt: '2026-08-07T12:00:00.000Z',
      filename: 'report.pdf',
      id: 'artifact-1',
      mimeType: 'application/pdf',
    },
    purpose: 'user_data',
    scopeId: 'tenant-1',
    ...overrides,
  };
}

describe('OpenAIFileAdapter', () => {
  it('drives the SDK transport without exposing SDK values', async () => {
    const signal = new AbortController().signal;
    const adapter = new OpenAIFileAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://openai.test/v1',
      expiresAfterSeconds: 3_600,
      maxRetries: 2,
      organization: 'org-1',
      project: 'project-1',
      scopeId: 'tenant-1',
      timeoutMs: 4_000,
    });
    await expect(
      adapter.upload(uploadRequest(), {
        idempotencyKey: 'upload-1',
        signal,
        timeoutMs: 2_000,
      }),
    ).resolves.toEqual({
      expiresAt: '2026-08-07T12:00:00.000Z',
      fileId: 'file-sdk',
    });
    await adapter.delete('file-sdk', 'tenant-1', { idempotencyKey: 'delete-1' });

    expect(sdk.constructors).toContainEqual({
      apiKey: 'test-key',
      baseURL: 'https://openai.test/v1',
      maxRetries: 2,
      organization: 'org-1',
      project: 'project-1',
      timeout: 4_000,
    });
    expect(sdk.toFiles).toContainEqual({
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'report.pdf',
      options: { type: 'application/pdf' },
    });
    expect(sdk.creates).toContainEqual({
      options: {
        headers: { 'Idempotency-Key': 'upload-1' },
        signal,
        timeout: 2_000,
      },
      request: {
        expires_after: { anchor: 'created_at', seconds: 3_600 },
        file: { mockFile: 'report.pdf' },
        purpose: 'user_data',
      },
    });
    expect(sdk.deletes).toContainEqual({
      fileId: 'file-sdk',
      options: { headers: { 'Idempotency-Key': 'delete-1' } },
    });
  });

  it('maps an artifact upload and normalizes provider expiry', async () => {
    const transport = new FakeFileTransport();
    const adapter = new OpenAIFileAdapter(
      { expiresAfterSeconds: 3_600, scopeId: 'tenant-1' },
      { transport },
    );
    await expect(adapter.upload(uploadRequest())).resolves.toEqual({
      expiresAt: '2026-08-07T12:00:00.000Z',
      fileId: 'file-1',
    });
    expect(transport.creates).toEqual([
      {
        bytes: new Uint8Array([1, 2, 3]),
        expiresAfterSeconds: 3_600,
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        purpose: 'user_data',
      },
    ]);
    expect(adapter.provider).toBe('openai');
  });

  it('uses the artifact ID as a safe filename fallback and deletes files', async () => {
    const transport = new FakeFileTransport();
    transport.createResult = { fileId: 'file-2' };
    const adapter = new OpenAIFileAdapter({ scopeId: 'tenant-1' }, { transport });
    const request = uploadRequest({
      artifact: {
        byteLength: 3,
        bytes: new Uint8Array([1, 2, 3]),
        checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
        createdAt: '2026-08-07T12:00:00.000Z',
        id: 'artifact-1',
        mimeType: 'application/pdf',
      },
    });
    await expect(adapter.upload(request)).resolves.toEqual({ fileId: 'file-2' });
    expect(transport.creates[0]?.filename).toBe('artifact-1');
    await adapter.delete('file-2', 'tenant-1');
    expect(transport.deletes).toEqual(['file-2']);
  });

  it('rejects invalid configuration, purpose, scope, and provider results', async () => {
    const transport = new FakeFileTransport();
    expect(
      () => new OpenAIFileAdapter({ expiresAfterSeconds: 10, scopeId: 'tenant-1' }, { transport }),
    ).toThrow(expect.objectContaining({ code: 'invalid_openai_file_expiry' }));
    expect(() => new OpenAIFileAdapter({ scopeId: ' ' }, { transport })).toThrow(
      expect.objectContaining({ code: 'invalid_openai_file_scope' }),
    );
    const adapter = new OpenAIFileAdapter({ scopeId: 'tenant-1' }, { transport });
    await expect(adapter.upload(uploadRequest({ purpose: 'unknown' }))).rejects.toMatchObject({
      code: 'unsupported_openai_file_purpose',
    });
    await expect(adapter.upload(uploadRequest({ scopeId: 'tenant-2' }))).rejects.toMatchObject({
      code: 'openai_file_scope_mismatch',
    });
    transport.createResult = { fileId: '' };
    await expect(adapter.upload(uploadRequest())).rejects.toMatchObject({
      code: 'invalid_openai_file_id',
    });
    transport.createResult = { expiresAt: Number.NaN, fileId: 'file-1' };
    await expect(adapter.upload(uploadRequest())).rejects.toMatchObject({
      code: 'invalid_openai_file_expiry_response',
    });
    transport.createResult = { expiresAt: Number.MAX_SAFE_INTEGER, fileId: 'file-1' };
    await expect(adapter.upload(uploadRequest())).rejects.toMatchObject({
      code: 'invalid_openai_file_expiry_response',
    });
    transport.deleted = false;
    await expect(adapter.delete('file-1', 'tenant-1')).rejects.toMatchObject({
      code: 'openai_file_not_deleted',
    });
  });

  it('normalizes unknown transport failures', async () => {
    const transport = new FakeFileTransport();
    const adapter = new OpenAIFileAdapter({ scopeId: 'tenant-1' }, { transport });
    transport.create = () => Promise.reject(new Error('offline'));
    await expect(adapter.upload(uploadRequest())).rejects.toMatchObject({
      code: 'openai_file_upload_failed',
      retryable: true,
    });
    transport.delete = () => Promise.reject(new Error('offline'));
    await expect(adapter.delete('file-1', 'tenant-1')).rejects.toMatchObject({
      code: 'openai_file_delete_failed',
      retryable: true,
    });
  });
});

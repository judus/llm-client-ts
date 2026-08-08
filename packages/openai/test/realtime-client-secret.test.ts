import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OpenAIModule from 'openai';

import type { RealtimeVoiceSessionConfig } from '@maduser/ai-ts';

import {
  createOpenAIRealtimeClientSecretIssuer,
  OpenAIRealtimeClientSecretIssuer,
  type OpenAIRealtimeClientSecretTransport,
  type OpenAIRealtimeClientSecretTransportRequest,
} from '../src/index.js';
import { OpenAISdkRealtimeClientSecretTransport } from '../src/realtime-client-secret.js';

const config: RealtimeVoiceSessionConfig = {
  inputAudio: {
    channels: 1,
    encoding: 'pcm16',
    mimeType: 'audio/pcm',
    sampleRateHz: 24_000,
  },
  inputTranscription: { language: 'en', prompt: 'Commander names' },
  instructions: 'Be concise.',
  model: { model: 'gpt-realtime', provider: 'openai' },
  outputAudio: {
    channels: 1,
    encoding: 'g711_ulaw',
    mimeType: 'audio/pcmu',
  },
  turnDetection: { type: 'manual' },
  voice: 'coral',
};

function fakeTransport(
  result = {
    expiresAtEpochSeconds: 1_786_191_000,
    sessionId: 'session-1',
    value: 'ek_test',
  },
): OpenAIRealtimeClientSecretTransport & {
  readonly requests: OpenAIRealtimeClientSecretTransportRequest[];
} {
  const requests: OpenAIRealtimeClientSecretTransportRequest[] = [];
  return {
    issue(request) {
      requests.push(request);
      return Promise.resolve(result);
    },
    requests,
  };
}

describe('OpenAIRealtimeClientSecretIssuer', () => {
  it('maps a normalized session and returns a bounded opaque secret', async () => {
    const transport = fakeTransport();
    const issuer = new OpenAIRealtimeClientSecretIssuer(
      { expiresAfterSeconds: 900 },
      {
        now: () => new Date('2026-08-08T12:00:00.000Z'),
        transport,
      },
    );

    const secret = await issuer.issue(config);

    expect(transport.requests).toEqual([
      {
        expiresAfterSeconds: 900,
        inputAudioFormat: 'audio/pcm',
        inputTranscription: {
          language: 'en',
          model: 'gpt-4o-mini-transcribe',
          prompt: 'Commander names',
        },
        instructions: 'Be concise.',
        model: 'gpt-realtime',
        outputAudioFormat: 'audio/pcmu',
        turnDetection: { type: 'manual' },
        voice: 'coral',
      },
    ]);
    expect(secret).toEqual({
      expiresAt: '2026-08-08T12:10:00.000Z',
      provider: 'openai',
      sessionId: 'session-1',
      value: 'ek_test',
    });
  });

  it('maps server VAD, G.711 A-law, and explicit OpenAI transcription models', async () => {
    const transport = fakeTransport();
    const issuer = new OpenAIRealtimeClientSecretIssuer(
      {},
      { now: () => new Date('2026-08-08T12:00:00.000Z'), transport },
    );

    await issuer.issue({
      ...config,
      inputAudio: { encoding: 'g711_alaw', mimeType: 'audio/pcma' },
      inputTranscription: {
        model: { model: 'gpt-transcribe', provider: 'openai' },
      },
      turnDetection: {
        createResponse: true,
        interruptResponse: true,
        silenceDurationMs: 500,
        threshold: 0.5,
        type: 'server_vad',
      },
    });

    expect(transport.requests[0]).toMatchObject({
      expiresAfterSeconds: 600,
      inputAudioFormat: 'audio/pcma',
      inputTranscription: { model: 'gpt-transcribe' },
      turnDetection: { silenceDurationMs: 500, threshold: 0.5, type: 'server_vad' },
    });
  });

  it('omits disabled and absent optional session fields', async () => {
    const transport = fakeTransport();
    const issuer = new OpenAIRealtimeClientSecretIssuer(
      {},
      { now: () => new Date('2026-08-08T12:00:00.000Z'), transport },
    );

    await issuer.issue({
      inputAudio: { encoding: 'g711_ulaw', mimeType: 'audio/pcmu' },
      inputTranscription: false,
      model: config.model,
      outputAudio: { encoding: 'pcm16', mimeType: 'audio/pcm' },
      turnDetection: { type: 'manual' },
    });

    expect(transport.requests[0]).toEqual({
      expiresAfterSeconds: 600,
      inputAudioFormat: 'audio/pcmu',
      inputTranscription: false,
      model: 'gpt-realtime',
      outputAudioFormat: 'audio/pcm',
      turnDetection: { type: 'manual' },
    });
  });

  const incompatibleConfigurations = [
    {
      code: 'openai_realtime_provider_mismatch',
      config: { ...config, model: { model: 'x', provider: 'other' } },
    },
    {
      code: 'openai_realtime_transcription_provider_mismatch',
      config: {
        ...config,
        inputTranscription: { model: { model: 'x', provider: 'other' } },
      },
    },
    {
      code: 'realtime_capability_unsupported',
      config: { ...config, inputAudio: { encoding: 'opus', mimeType: 'audio/opus' } },
    },
    {
      code: 'openai_realtime_channels_unsupported',
      config: { ...config, outputAudio: { ...config.outputAudio, channels: 2 } },
    },
    {
      code: 'openai_realtime_sample_rate_unsupported',
      config: { ...config, inputAudio: { ...config.inputAudio, sampleRateHz: 16_000 } },
    },
  ] satisfies readonly {
    readonly code: string;
    readonly config: RealtimeVoiceSessionConfig;
  }[];

  it.each(incompatibleConfigurations)(
    'rejects incompatible configuration before transport',
    async (fixture) => {
      const transport = fakeTransport();
      const issuer = new OpenAIRealtimeClientSecretIssuer(
        {},
        { now: () => new Date('2026-08-08T12:00:00.000Z'), transport },
      );

      await expect(issuer.issue(fixture.config)).rejects.toMatchObject({ code: fixture.code });
      expect(transport.requests).toHaveLength(0);
    },
  );

  it.each([9, 7_201, Number.NaN])('rejects invalid TTL %s', (expiresAfterSeconds) => {
    expect(
      () =>
        new OpenAIRealtimeClientSecretIssuer(
          { expiresAfterSeconds },
          {
            now: () => new Date('2026-08-08T12:00:00.000Z'),
            transport: fakeTransport(),
          },
        ),
    ).toThrow(expect.objectContaining({ code: 'openai_realtime_client_secret_ttl_invalid' }));
  });

  it.each([
    {
      name: 'invalid clock',
      now: new Date(Number.NaN),
      result: { expiresAtEpochSeconds: 1_786_191_000, sessionId: 's', value: 'ek' },
    },
    {
      name: 'empty value',
      now: new Date('2026-08-08T12:00:00.000Z'),
      result: { expiresAtEpochSeconds: 1_786_191_000, sessionId: 's', value: '' },
    },
    {
      name: 'empty session',
      now: new Date('2026-08-08T12:00:00.000Z'),
      result: { expiresAtEpochSeconds: 1_786_191_000, sessionId: '', value: 'ek' },
    },
    {
      name: 'fractional expiry',
      now: new Date('2026-08-08T12:00:00.000Z'),
      result: { expiresAtEpochSeconds: 1.5, sessionId: 's', value: 'ek' },
    },
    {
      name: 'expired value',
      now: new Date('2026-08-08T12:00:00.000Z'),
      result: { expiresAtEpochSeconds: 1_786_190_400, sessionId: 's', value: 'ek' },
    },
  ])('rejects $name provider credentials', async ({ now, result }) => {
    const issuer = new OpenAIRealtimeClientSecretIssuer(
      {},
      { now: () => now, transport: fakeTransport(result) },
    );

    await expect(issuer.issue(config)).rejects.toMatchObject({
      category: 'malformed_response',
      code: 'openai_realtime_client_secret_malformed',
    });
  });

  it('rejects an empty configured transcription model', () => {
    expect(
      () =>
        new OpenAIRealtimeClientSecretIssuer(
          { transcriptionModel: ' ' },
          { now: () => new Date(), transport: fakeTransport() },
        ),
    ).toThrow(expect.objectContaining({ code: 'openai_realtime_value_empty' }));
  });

  it('normalizes transport failures', async () => {
    const issuer = new OpenAIRealtimeClientSecretIssuer(
      {},
      {
        now: () => new Date(),
        transport: { issue: () => Promise.reject(new Error('socket closed')) },
      },
    );

    await expect(issuer.issue(config)).rejects.toMatchObject({
      category: 'transport',
      code: 'openai_unknown_error',
    });
  });
});

const mocks = vi.hoisted(() => ({
  clientOptions: [] as unknown[],
  create: vi.fn(),
}));

vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenAIModule>();
  return {
    ...actual,
    default: class MockOpenAI {
      public readonly realtime = { clientSecrets: { create: mocks.create } };

      public constructor(options: unknown) {
        mocks.clientOptions.push(options);
      }
    },
  };
});

describe('OpenAISdkRealtimeClientSecretTransport', () => {
  beforeEach(() => {
    mocks.clientOptions.length = 0;
    mocks.create.mockReset();
  });

  it('maps SDK-free requests, call options, and SDK responses', async () => {
    mocks.create.mockResolvedValue({
      expires_at: 1_786_191_000,
      session: { id: 'session-1' },
      value: 'ek_test',
    });
    const transport = new OpenAISdkRealtimeClientSecretTransport({
      apiKey: 'test-key',
      timeoutMs: 5_000,
    });
    const signal = new AbortController().signal;

    const result = await transport.issue(
      {
        expiresAfterSeconds: 600,
        inputAudioFormat: 'audio/pcm',
        inputTranscription: { language: 'en', model: 'gpt-transcribe' },
        model: 'gpt-realtime',
        outputAudioFormat: 'audio/pcma',
        turnDetection: {
          createResponse: true,
          prefixPaddingMs: 200,
          type: 'server_vad',
        },
        voice: 'coral',
      },
      { idempotencyKey: 'idem-1', signal, timeoutMs: 2_000 },
    );

    expect(mocks.clientOptions).toEqual([{ apiKey: 'test-key', timeout: 5_000 }]);
    expect(mocks.create).toHaveBeenCalledWith(
      {
        expires_after: { anchor: 'created_at', seconds: 600 },
        session: {
          audio: {
            input: {
              format: { rate: 24_000, type: 'audio/pcm' },
              transcription: { language: 'en', model: 'gpt-transcribe' },
              turn_detection: {
                create_response: true,
                prefix_padding_ms: 200,
                type: 'server_vad',
              },
            },
            output: { format: { type: 'audio/pcma' }, voice: 'coral' },
          },
          model: 'gpt-realtime',
          output_modalities: ['audio'],
          type: 'realtime',
        },
      },
      {
        headers: { 'Idempotency-Key': 'idem-1' },
        signal,
        timeout: 2_000,
      },
    );
    expect(result).toEqual({
      expiresAtEpochSeconds: 1_786_191_000,
      sessionId: 'session-1',
      value: 'ek_test',
    });
  });

  it('omits optional SDK settings and supports the public factory defaults', async () => {
    mocks.create.mockResolvedValue({
      expires_at: Math.floor(Date.now() / 1_000) + 600,
      session: { id: 'session-default' },
      value: 'ek_default',
    });

    const issuer = createOpenAIRealtimeClientSecretIssuer({
      apiKey: 'test-key',
      baseUrl: 'https://openai.invalid/v1',
      maxRetries: 0,
      organization: 'org-1',
      project: 'project-1',
    });
    const secret = await issuer.issue({
      inputAudio: config.inputAudio,
      model: config.model,
      outputAudio: config.outputAudio,
      turnDetection: { type: 'manual' },
    });

    expect(mocks.clientOptions).toEqual([
      {
        apiKey: 'test-key',
        baseURL: 'https://openai.invalid/v1',
        maxRetries: 0,
        organization: 'org-1',
        project: 'project-1',
      },
    ]);
    expect(mocks.create).toHaveBeenCalledWith(
      {
        expires_after: { anchor: 'created_at', seconds: 600 },
        session: {
          audio: {
            input: { format: { rate: 24_000, type: 'audio/pcm' }, turn_detection: null },
            output: { format: { type: 'audio/pcmu' } },
          },
          model: 'gpt-realtime',
          output_modalities: ['audio'],
          type: 'realtime',
        },
      },
      {},
    );
    expect(secret).toMatchObject({ provider: 'openai', sessionId: 'session-default' });
  });
});

import { describe, expect, it } from 'vitest';

import type { ModelCapabilities } from '@maduser/ai-ts';

import { BedrockCapabilityRegistry } from '../src/capability-registry.js';
import type { BedrockDiscoveryCatalog } from '../src/discovery.js';

const full: ModelCapabilities = {
  input: { audio: false, documents: true, images: true, text: true },
  limits: { contextTokens: 200_000, documentBytes: 4_500_000, outputTokens: 8_000 },
  output: { audio: false, structured: true, text: true },
  realtime: false,
  speechSynthesis: false,
  streaming: true,
  tools: { calls: true, parallelCalls: true, strictSchemas: true },
  transcription: false,
};

const narrow: ModelCapabilities = {
  input: { audio: false, documents: false, images: false, text: true },
  limits: { contextTokens: 100_000, outputTokens: 4_000 },
  output: { audio: false, structured: false, text: true },
  realtime: false,
  speechSynthesis: false,
  streaming: false,
  tools: { calls: true, parallelCalls: false, strictSchemas: false },
  transcription: false,
};

const catalog: BedrockDiscoveryCatalog = {
  inferenceProfiles: [
    {
      inferenceProfileArn: 'arn:profile:mixed',
      inferenceProfileId: 'profile.mixed',
      inferenceProfileName: 'Mixed',
      modelIds: ['model.full', 'model.narrow'],
      status: 'ACTIVE',
      type: 'APPLICATION',
    },
  ],
  models: [],
};

describe('BedrockCapabilityRegistry', () => {
  it('resolves exact model entries and returns independent values', async () => {
    const registry = new BedrockCapabilityRegistry({
      entries: [{ capabilities: full, modelId: 'model.full' }],
    });
    const first = await registry.resolve({ model: 'model.full', provider: 'bedrock' });
    const second = await registry.resolve({ model: 'model.full', provider: 'bedrock' });

    expect(first).toEqual(full);
    expect(second).toEqual(full);
    expect(first).not.toBe(second);
    expect(first?.input).not.toBe(second?.input);
    await expect(
      registry.resolve({ model: 'model.full', provider: 'openai' }),
    ).resolves.toBeUndefined();
    await expect(
      registry.resolve({ model: 'missing', provider: 'bedrock' }),
    ).resolves.toBeUndefined();
  });

  it('intersects every capability across a multi-model inference profile', async () => {
    const registry = new BedrockCapabilityRegistry({
      catalog,
      entries: [
        { capabilities: full, modelId: 'model.full' },
        { capabilities: narrow, modelId: 'model.narrow' },
      ],
    });

    await expect(
      registry.resolve({ model: 'profile.mixed', provider: 'bedrock' }),
    ).resolves.toEqual({
      input: { audio: false, documents: false, images: false, text: true },
      limits: { contextTokens: 100_000, outputTokens: 4_000 },
      output: { audio: false, structured: false, text: true },
      realtime: false,
      speechSynthesis: false,
      streaming: false,
      tools: { calls: true, parallelCalls: false, strictSchemas: false },
      transcription: false,
    });
  });

  it('uses an explicit conservative fallback for unknown models and profile members', async () => {
    const registry = new BedrockCapabilityRegistry({
      catalog,
      entries: [{ capabilities: full, modelId: 'model.full' }],
      fallback: narrow,
    });

    await expect(registry.resolve({ model: 'unknown', provider: 'bedrock' })).resolves.toEqual(
      narrow,
    );
    await expect(
      registry.resolve({ model: 'profile.mixed', provider: 'bedrock' }),
    ).resolves.toMatchObject({
      input: { documents: false, images: false },
      streaming: false,
    });
  });

  it('rejects empty, duplicate, and profile-conflicting model IDs', () => {
    expect(
      () => new BedrockCapabilityRegistry({ entries: [{ capabilities: full, modelId: '' }] }),
    ).toThrow(expect.objectContaining({ code: 'bedrock_capability_model_id_empty' }));
    expect(
      () =>
        new BedrockCapabilityRegistry({
          entries: [
            { capabilities: full, modelId: 'same' },
            { capabilities: narrow, modelId: 'same' },
          ],
        }),
    ).toThrow(expect.objectContaining({ code: 'bedrock_capability_duplicate_model' }));
    expect(
      () =>
        new BedrockCapabilityRegistry({
          catalog,
          entries: [{ capabilities: full, modelId: 'profile.mixed' }],
        }),
    ).toThrow(expect.objectContaining({ code: 'bedrock_capability_profile_conflict' }));
  });
});

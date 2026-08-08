import { describe, expect, it } from 'vitest';

import type { CallOptions } from '@maduser/ai-ts';

import { BedrockDiscoveryClient } from '../src/discovery.js';
import type {
  BedrockDiscoveryTransport,
  BedrockListFoundationModelsRequest,
  BedrockListInferenceProfilesRequest,
} from '../src/discovery.js';

class FixtureDiscoveryTransport implements BedrockDiscoveryTransport {
  public closeCount = 0;
  public readonly foundationCalls: {
    readonly options: CallOptions;
    readonly request: BedrockListFoundationModelsRequest;
  }[] = [];
  public readonly profileCalls: {
    readonly options: CallOptions;
    readonly request: BedrockListInferenceProfilesRequest;
  }[] = [];
  readonly #foundationResponse: unknown;
  readonly #profileResponses: unknown[];

  public constructor(foundationResponse: unknown, profileResponses: readonly unknown[]) {
    this.#foundationResponse = foundationResponse;
    this.#profileResponses = [...profileResponses];
  }

  public close(): void {
    this.closeCount += 1;
  }

  public listFoundationModels(
    request: BedrockListFoundationModelsRequest,
    options: CallOptions,
  ): Promise<unknown> {
    this.foundationCalls.push({ options, request });
    return Promise.resolve(this.#foundationResponse);
  }

  public listInferenceProfiles(
    request: BedrockListInferenceProfilesRequest,
    options: CallOptions,
  ): Promise<unknown> {
    this.profileCalls.push({ options, request });
    return Promise.resolve(this.#profileResponses.shift());
  }
}

const modelArn = 'arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-sonnet-v1:0';
const secondModelArn = 'arn:aws:bedrock:eu-central-1::foundation-model/amazon.nova-lite-v1:0';

const foundationResponse = {
  modelSummaries: [
    {
      customizationsSupported: ['FINE_TUNING', 'FINE_TUNING'],
      inferenceTypesSupported: ['ON_DEMAND'],
      inputModalities: ['TEXT', 'IMAGE'],
      modelArn,
      modelId: 'anthropic.claude-sonnet-v1:0',
      modelLifecycle: {
        endOfLifeTime: '2028-01-01T00:00:00.000Z',
        legacyTime: new Date('2027-01-01T00:00:00.000Z'),
        publicExtendedAccessTime: '2027-06-01T00:00:00.000Z',
        startOfLifeTime: '2026-01-01T00:00:00.000Z',
        status: 'ACTIVE',
      },
      modelName: 'Claude Sonnet',
      outputModalities: ['TEXT'],
      providerName: 'Anthropic',
      responseStreamingSupported: true,
    },
    {
      modelArn: secondModelArn,
      modelId: 'amazon.nova-lite-v1:0',
    },
  ],
};

function profileResponse(
  id: string,
  arn: string,
  nextToken?: string,
  type: 'APPLICATION' | 'SYSTEM_DEFINED' = 'SYSTEM_DEFINED',
): unknown {
  return {
    inferenceProfileSummaries: [
      {
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        description: 'Cross-Region profile',
        inferenceProfileArn: `arn:aws:bedrock:eu-central-1:123:inference-profile/${id}`,
        inferenceProfileId: id,
        inferenceProfileName: `Profile ${id}`,
        models: [{ modelArn: arn }, { modelArn: arn }],
        status: 'ACTIVE',
        type,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ],
    ...(nextToken === undefined ? {} : { nextToken }),
  };
}

describe('BedrockDiscoveryClient', () => {
  it('normalizes models and paginated profiles and recommends invocation profiles', async () => {
    const transport = new FixtureDiscoveryTransport(foundationResponse, [
      profileResponse('eu.anthropic.sonnet', modelArn, 'page-2'),
      profileResponse('eu.amazon.nova-lite', secondModelArn),
    ]);
    const client = new BedrockDiscoveryClient(transport);
    const signal = new AbortController().signal;

    await expect(client.discover({}, { signal, timeoutMs: 2_000 })).resolves.toEqual({
      inferenceProfiles: [
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          description: 'Cross-Region profile',
          inferenceProfileArn:
            'arn:aws:bedrock:eu-central-1:123:inference-profile/eu.anthropic.sonnet',
          inferenceProfileId: 'eu.anthropic.sonnet',
          inferenceProfileName: 'Profile eu.anthropic.sonnet',
          modelIds: ['anthropic.claude-sonnet-v1:0'],
          status: 'ACTIVE',
          type: 'SYSTEM_DEFINED',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
        {
          createdAt: '2026-01-01T00:00:00.000Z',
          description: 'Cross-Region profile',
          inferenceProfileArn:
            'arn:aws:bedrock:eu-central-1:123:inference-profile/eu.amazon.nova-lite',
          inferenceProfileId: 'eu.amazon.nova-lite',
          inferenceProfileName: 'Profile eu.amazon.nova-lite',
          modelIds: ['amazon.nova-lite-v1:0'],
          status: 'ACTIVE',
          type: 'SYSTEM_DEFINED',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
      models: [
        {
          customizationsSupported: ['FINE_TUNING'],
          inferenceTypesSupported: ['ON_DEMAND'],
          inputModalities: ['TEXT', 'IMAGE'],
          lifecycle: {
            endOfLifeAt: '2028-01-01T00:00:00.000Z',
            legacyAt: '2027-01-01T00:00:00.000Z',
            publicExtendedAccessAt: '2027-06-01T00:00:00.000Z',
            startOfLifeAt: '2026-01-01T00:00:00.000Z',
            status: 'ACTIVE',
          },
          modelArn,
          modelId: 'anthropic.claude-sonnet-v1:0',
          modelName: 'Claude Sonnet',
          outputModalities: ['TEXT'],
          providerName: 'Anthropic',
          recommendedInvocationIds: ['eu.anthropic.sonnet'],
          responseStreamingSupported: true,
        },
        {
          customizationsSupported: [],
          inferenceTypesSupported: [],
          inputModalities: [],
          modelArn: secondModelArn,
          modelId: 'amazon.nova-lite-v1:0',
          outputModalities: [],
          recommendedInvocationIds: ['eu.amazon.nova-lite'],
          responseStreamingSupported: false,
        },
      ],
    });
    expect(transport.foundationCalls).toEqual([
      { options: { signal, timeoutMs: 2_000 }, request: {} },
    ]);
    expect(transport.profileCalls).toEqual([
      {
        options: { signal, timeoutMs: 2_000 },
        request: { maxResults: 1_000, typeEquals: 'SYSTEM_DEFINED' },
      },
      {
        options: { signal, timeoutMs: 2_000 },
        request: { maxResults: 1_000, nextToken: 'page-2', typeEquals: 'SYSTEM_DEFINED' },
      },
    ]);
  });

  it('supports all profile types and falls back to direct model invocation', async () => {
    const transport = new FixtureDiscoveryTransport(foundationResponse, [{}]);
    const catalog = await new BedrockDiscoveryClient(transport).discover({
      profilePageSize: 10,
      profileType: 'all',
    });

    expect(catalog.models.map((model) => model.recommendedInvocationIds)).toEqual([
      ['anthropic.claude-sonnet-v1:0'],
      ['amazon.nova-lite-v1:0'],
    ]);
    expect(transport.profileCalls[0]?.request).toEqual({ maxResults: 10 });
  });

  it('closes its transport exactly once and rejects further discovery', async () => {
    const transport = new FixtureDiscoveryTransport({}, [{}]);
    const client = new BedrockDiscoveryClient(transport);
    client.close();
    client.close();

    expect(transport.closeCount).toBe(1);
    await expect(client.discover()).rejects.toMatchObject({
      category: 'invalid_request',
      code: 'bedrock_discovery_closed',
    });
    expect(transport.foundationCalls).toHaveLength(0);
  });

  it.each([
    [{ maxProfilePages: 0 }, 0],
    [{ profilePageSize: 0 }, 0],
    [{ profilePageSize: 1_001 }, 1_001],
  ] as const)('rejects invalid options %#', async (options, value) => {
    const client = new BedrockDiscoveryClient(new FixtureDiscoveryTransport({}, []));
    await expect(client.discover(options)).rejects.toMatchObject({
      code: 'bedrock_discovery_option_invalid',
      details: { value },
    });
  });

  it('detects repeated pagination tokens, page overflow, and duplicate profiles', async () => {
    const cycle = new BedrockDiscoveryClient(
      new FixtureDiscoveryTransport({}, [
        { inferenceProfileSummaries: [], nextToken: 'same' },
        { inferenceProfileSummaries: [], nextToken: 'same' },
      ]),
    );
    await expect(cycle.discover()).rejects.toMatchObject({
      code: 'bedrock_discovery_pagination_cycle',
    });

    const overflow = new BedrockDiscoveryClient(
      new FixtureDiscoveryTransport({}, [{ inferenceProfileSummaries: [], nextToken: 'more' }]),
    );
    await expect(overflow.discover({ maxProfilePages: 1 })).rejects.toMatchObject({
      code: 'bedrock_discovery_page_limit_exceeded',
    });

    const duplicate = new BedrockDiscoveryClient(
      new FixtureDiscoveryTransport({}, [
        {
          inferenceProfileSummaries: [
            profileSummary('same', modelArn),
            profileSummary('same', modelArn),
          ],
        },
      ]),
    );
    await expect(duplicate.discover()).rejects.toMatchObject({
      code: 'bedrock_discovery_duplicate_profile',
    });
  });

  it.each([
    [null, 'bedrock_discovery_object_expected'],
    [{ modelSummaries: 'bad' }, 'bedrock_discovery_array_expected'],
    [
      { modelSummaries: [{ modelArn, modelId: '', responseStreamingSupported: true }] },
      'bedrock_discovery_string_expected',
    ],
    [
      {
        modelSummaries: [
          { modelArn, modelId: 'duplicate' },
          { modelArn: secondModelArn, modelId: 'duplicate' },
        ],
      },
      'bedrock_discovery_duplicate_model',
    ],
    [
      { modelSummaries: [{ modelArn, modelId: 'model', responseStreamingSupported: 'yes' }] },
      'bedrock_discovery_boolean_expected',
    ],
    [
      {
        modelSummaries: [
          {
            modelArn,
            modelId: 'model',
            modelLifecycle: { legacyTime: 'never', status: 'ACTIVE' },
          },
        ],
      },
      'bedrock_discovery_timestamp_invalid',
    ],
  ] as const)('rejects malformed model discovery %#', async (response, code) => {
    const client = new BedrockDiscoveryClient(new FixtureDiscoveryTransport(response, [{}]));
    await expect(client.discover()).rejects.toMatchObject({ code });
  });

  it.each([
    [{ inferenceProfileSummaries: 'bad' }, 'bedrock_discovery_array_expected'],
    [
      { inferenceProfileSummaries: [profileSummary('profile', 'not-an-arn')] },
      'bedrock_discovery_model_arn_invalid',
    ],
    [
      {
        inferenceProfileSummaries: [{ ...profileSummary('profile', modelArn), status: 'CREATING' }],
      },
      'bedrock_discovery_literal_invalid',
    ],
    [
      {
        inferenceProfileSummaries: [{ ...profileSummary('profile', modelArn), type: 'UNKNOWN' }],
      },
      'bedrock_discovery_profile_type_invalid',
    ],
    [
      {
        inferenceProfileSummaries: [{ ...profileSummary('profile', modelArn), models: [] }],
      },
      'bedrock_discovery_profile_models_empty',
    ],
    [{ inferenceProfileSummaries: [], nextToken: '' }, 'bedrock_discovery_string_expected'],
  ] as const)('rejects malformed profile discovery %#', async (response, code) => {
    const client = new BedrockDiscoveryClient(
      new FixtureDiscoveryTransport(foundationResponse, [response]),
    );
    await expect(client.discover()).rejects.toMatchObject({ code });
  });
});

function profileSummary(id: string, arn: string): Record<string, unknown> {
  return {
    inferenceProfileArn: `arn:profile:${id}`,
    inferenceProfileId: id,
    inferenceProfileName: id,
    models: [{ modelArn: arn }],
    status: 'ACTIVE',
    type: 'SYSTEM_DEFINED',
  };
}

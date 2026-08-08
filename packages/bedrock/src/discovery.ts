import { AiError, type CallOptions } from '@maduser/ai-ts';

import { mapBedrockError } from './error-mapper.js';

const DEFAULT_MAX_PROFILE_PAGES = 100;
const DEFAULT_PROFILE_PAGE_SIZE = 1_000;

export type BedrockInferenceProfileType = 'APPLICATION' | 'SYSTEM_DEFINED';

export interface BedrockFoundationModelLifecycle {
  readonly endOfLifeAt?: string;
  readonly legacyAt?: string;
  readonly publicExtendedAccessAt?: string;
  readonly startOfLifeAt?: string;
  readonly status: string;
}

export interface BedrockFoundationModel {
  readonly customizationsSupported: readonly string[];
  readonly inferenceTypesSupported: readonly string[];
  readonly inputModalities: readonly string[];
  readonly lifecycle?: BedrockFoundationModelLifecycle;
  readonly modelArn: string;
  readonly modelId: string;
  readonly modelName?: string;
  readonly outputModalities: readonly string[];
  readonly providerName?: string;
  readonly recommendedInvocationIds: readonly string[];
  readonly responseStreamingSupported: boolean;
}

export interface BedrockInferenceProfile {
  readonly createdAt?: string;
  readonly description?: string;
  readonly inferenceProfileArn: string;
  readonly inferenceProfileId: string;
  readonly inferenceProfileName: string;
  readonly modelIds: readonly string[];
  readonly status: 'ACTIVE';
  readonly type: BedrockInferenceProfileType;
  readonly updatedAt?: string;
}

export interface BedrockDiscoveryCatalog {
  readonly inferenceProfiles: readonly BedrockInferenceProfile[];
  readonly models: readonly BedrockFoundationModel[];
}

export interface BedrockDiscoveryOptions {
  readonly maxProfilePages?: number;
  readonly profilePageSize?: number;
  /** Defaults to system-defined cross-Region profiles. Use `all` to omit the API filter. */
  readonly profileType?: BedrockInferenceProfileType | 'all';
}

export interface BedrockListFoundationModelsRequest {
  readonly byCustomizationType?: string;
  readonly byInferenceType?: string;
  readonly byOutputModality?: string;
  readonly byProvider?: string;
}

export interface BedrockListInferenceProfilesRequest {
  readonly maxResults: number;
  readonly nextToken?: string;
  readonly typeEquals?: BedrockInferenceProfileType;
}

/** Control-plane port. Implementations may use an AWS SDK but must return the untrusted payload. */
export interface BedrockDiscoveryTransport {
  close(): void;
  listFoundationModels(
    request: BedrockListFoundationModelsRequest,
    options: CallOptions,
  ): Promise<unknown>;
  listInferenceProfiles(
    request: BedrockListInferenceProfilesRequest,
    options: CallOptions,
  ): Promise<unknown>;
}

export class BedrockDiscoveryClient {
  readonly #transport: BedrockDiscoveryTransport;
  #closed = false;

  public constructor(transport: BedrockDiscoveryTransport) {
    this.#transport = transport;
  }

  public close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#transport.close();
    }
  }

  public async discover(
    discoveryOptions: BedrockDiscoveryOptions = {},
    callOptions: CallOptions = {},
  ): Promise<BedrockDiscoveryCatalog> {
    try {
      this.#assertOpen();
      const options = normalizeOptions(discoveryOptions);
      const modelResponse = await this.#transport.listFoundationModels({}, callOptions);
      const models = normalizeFoundationModels(modelResponse);
      const profiles = await this.#listInferenceProfiles(options, callOptions);
      return correlateProfiles(models, profiles);
    } catch (error) {
      throw mapBedrockError(error);
    }
  }

  async #listInferenceProfiles(
    options: NormalizedDiscoveryOptions,
    callOptions: CallOptions,
  ): Promise<BedrockInferenceProfile[]> {
    const profiles: BedrockInferenceProfile[] = [];
    const seenIds = new Set<string>();
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;

    for (let page = 0; page < options.maxProfilePages; page += 1) {
      const response = await this.#transport.listInferenceProfiles(
        {
          maxResults: options.profilePageSize,
          ...(nextToken === undefined ? {} : { nextToken }),
          ...(options.profileType === 'all' ? {} : { typeEquals: options.profileType }),
        },
        callOptions,
      );
      const normalized = normalizeInferenceProfilePage(response);
      for (const profile of normalized.profiles) {
        if (seenIds.has(profile.inferenceProfileId)) {
          throw malformed('Bedrock returned a duplicate inference profile.', {
            code: 'bedrock_discovery_duplicate_profile',
            details: { inferenceProfileId: profile.inferenceProfileId },
          });
        }
        seenIds.add(profile.inferenceProfileId);
        profiles.push(profile);
      }

      nextToken = normalized.nextToken;
      if (nextToken === undefined) {
        return profiles;
      }
      if (seenTokens.has(nextToken)) {
        throw malformed('Bedrock repeated an inference-profile pagination token.', {
          code: 'bedrock_discovery_pagination_cycle',
        });
      }
      seenTokens.add(nextToken);
    }

    throw malformed('Bedrock inference-profile discovery exceeded its page limit.', {
      code: 'bedrock_discovery_page_limit_exceeded',
      details: { maxProfilePages: options.maxProfilePages },
    });
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AiError('invalid_request', 'The Bedrock discovery client is closed.', {
        code: 'bedrock_discovery_closed',
      });
    }
  }
}

interface NormalizedDiscoveryOptions {
  readonly maxProfilePages: number;
  readonly profilePageSize: number;
  readonly profileType: BedrockInferenceProfileType | 'all';
}

function normalizeOptions(options: BedrockDiscoveryOptions): NormalizedDiscoveryOptions {
  const maxProfilePages = options.maxProfilePages ?? DEFAULT_MAX_PROFILE_PAGES;
  const profilePageSize = options.profilePageSize ?? DEFAULT_PROFILE_PAGE_SIZE;
  if (!Number.isSafeInteger(maxProfilePages) || maxProfilePages < 1) {
    throw invalidOption('maxProfilePages', maxProfilePages);
  }
  if (!Number.isSafeInteger(profilePageSize) || profilePageSize < 1 || profilePageSize > 1_000) {
    throw invalidOption('profilePageSize', profilePageSize);
  }
  const profileType = normalizeProfileType(options.profileType);
  return {
    maxProfilePages,
    profilePageSize,
    profileType,
  };
}

function normalizeProfileType(value: unknown): BedrockInferenceProfileType | 'all' {
  if (value === undefined) {
    return 'SYSTEM_DEFINED';
  }
  if (value === 'all' || value === 'APPLICATION' || value === 'SYSTEM_DEFINED') {
    return value;
  }
  throw new AiError('invalid_request', 'Bedrock discovery option profileType is invalid.', {
    code: 'bedrock_discovery_option_invalid',
    details: { field: 'profileType' },
  });
}

function normalizeFoundationModels(value: unknown): BedrockFoundationModel[] {
  const root = requireObject(value, 'foundation-model response');
  const summaries = optionalArray(root['modelSummaries'], 'modelSummaries');
  const models = summaries.map((summary, index) => normalizeFoundationModel(summary, index));
  rejectDuplicate(models, (model) => model.modelId, 'bedrock_discovery_duplicate_model');
  return models;
}

function normalizeFoundationModel(value: unknown, index: number): BedrockFoundationModel {
  const model = requireObject(value, `modelSummaries[${String(index)}]`);
  return {
    customizationsSupported: stringArray(
      model['customizationsSupported'],
      'customizationsSupported',
    ),
    inferenceTypesSupported: stringArray(
      model['inferenceTypesSupported'],
      'inferenceTypesSupported',
    ),
    inputModalities: stringArray(model['inputModalities'], 'inputModalities'),
    ...(model['modelLifecycle'] === undefined
      ? {}
      : { lifecycle: normalizeLifecycle(model['modelLifecycle']) }),
    modelArn: requireNonEmptyString(model['modelArn'], 'modelArn'),
    modelId: requireNonEmptyString(model['modelId'], 'modelId'),
    ...(model['modelName'] === undefined
      ? {}
      : { modelName: requireNonEmptyString(model['modelName'], 'modelName') }),
    outputModalities: stringArray(model['outputModalities'], 'outputModalities'),
    ...(model['providerName'] === undefined
      ? {}
      : { providerName: requireNonEmptyString(model['providerName'], 'providerName') }),
    recommendedInvocationIds: [],
    responseStreamingSupported: optionalBoolean(
      model['responseStreamingSupported'],
      'responseStreamingSupported',
    ),
  };
}

function normalizeLifecycle(value: unknown): BedrockFoundationModelLifecycle {
  const lifecycle = requireObject(value, 'modelLifecycle');
  return {
    ...(lifecycle['endOfLifeTime'] === undefined
      ? {}
      : { endOfLifeAt: timestamp(lifecycle['endOfLifeTime'], 'endOfLifeTime') }),
    ...(lifecycle['legacyTime'] === undefined
      ? {}
      : { legacyAt: timestamp(lifecycle['legacyTime'], 'legacyTime') }),
    ...(lifecycle['publicExtendedAccessTime'] === undefined
      ? {}
      : {
          publicExtendedAccessAt: timestamp(
            lifecycle['publicExtendedAccessTime'],
            'publicExtendedAccessTime',
          ),
        }),
    ...(lifecycle['startOfLifeTime'] === undefined
      ? {}
      : { startOfLifeAt: timestamp(lifecycle['startOfLifeTime'], 'startOfLifeTime') }),
    status: requireNonEmptyString(lifecycle['status'], 'modelLifecycle.status'),
  };
}

function normalizeInferenceProfilePage(value: unknown): {
  readonly nextToken?: string;
  readonly profiles: BedrockInferenceProfile[];
} {
  const root = requireObject(value, 'inference-profile response');
  const summaries = optionalArray(root['inferenceProfileSummaries'], 'inferenceProfileSummaries');
  return {
    ...(root['nextToken'] === undefined
      ? {}
      : { nextToken: requireNonEmptyString(root['nextToken'], 'nextToken') }),
    profiles: summaries.map((summary, index) => normalizeInferenceProfile(summary, index)),
  };
}

function normalizeInferenceProfile(value: unknown, index: number): BedrockInferenceProfile {
  const profile = requireObject(value, `inferenceProfileSummaries[${String(index)}]`);
  const models = requireArray(profile['models'], 'models');
  if (models.length === 0) {
    throw malformed('Bedrock inference profiles must contain at least one model.', {
      code: 'bedrock_discovery_profile_models_empty',
    });
  }
  return {
    ...(profile['createdAt'] === undefined
      ? {}
      : { createdAt: timestamp(profile['createdAt'], 'createdAt') }),
    ...(profile['description'] === undefined
      ? {}
      : { description: requireNonEmptyString(profile['description'], 'description') }),
    inferenceProfileArn: requireNonEmptyString(
      profile['inferenceProfileArn'],
      'inferenceProfileArn',
    ),
    inferenceProfileId: requireNonEmptyString(profile['inferenceProfileId'], 'inferenceProfileId'),
    inferenceProfileName: requireNonEmptyString(
      profile['inferenceProfileName'],
      'inferenceProfileName',
    ),
    modelIds: uniqueStrings(
      models.map((model, modelIndex) =>
        modelIdFromArn(
          requireNonEmptyString(
            requireObject(model, `models[${String(modelIndex)}]`)['modelArn'],
            'modelArn',
          ),
        ),
      ),
    ),
    status: requireLiteral(profile['status'], 'ACTIVE', 'status'),
    type: requireProfileType(profile['type']),
    ...(profile['updatedAt'] === undefined
      ? {}
      : { updatedAt: timestamp(profile['updatedAt'], 'updatedAt') }),
  };
}

function correlateProfiles(
  models: readonly BedrockFoundationModel[],
  profiles: readonly BedrockInferenceProfile[],
): BedrockDiscoveryCatalog {
  const profileIdsByModel = new Map<string, string[]>();
  for (const profile of profiles) {
    for (const modelId of profile.modelIds) {
      const profileIds = profileIdsByModel.get(modelId) ?? [];
      profileIds.push(profile.inferenceProfileId);
      profileIdsByModel.set(modelId, profileIds);
    }
  }
  return {
    inferenceProfiles: profiles,
    models: models.map((model) => ({
      ...model,
      recommendedInvocationIds: profileIdsByModel.get(model.modelId) ?? [model.modelId],
    })),
  };
}

function modelIdFromArn(arn: string): string {
  const marker = ':foundation-model/';
  const markerIndex = arn.indexOf(marker);
  if (markerIndex < 0) {
    throw malformed('Bedrock returned an invalid foundation-model ARN.', {
      code: 'bedrock_discovery_model_arn_invalid',
      details: { arn },
    });
  }
  return requireNonEmptyString(arn.slice(markerIndex + marker.length), 'foundation model ID');
}

function timestamp(value: unknown, label: string): string {
  const date = value instanceof Date ? value : new Date(requireNonEmptyString(value, label));
  if (Number.isNaN(date.valueOf())) {
    throw malformed(`Bedrock returned an invalid ${label} timestamp.`, {
      code: 'bedrock_discovery_timestamp_invalid',
      details: { field: label },
    });
  }
  return date.toISOString();
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformed(`Bedrock ${label} must be an object.`, {
      code: 'bedrock_discovery_object_expected',
      details: { field: label },
    });
  }
  return Object.fromEntries(Object.entries(value));
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw malformed(`Bedrock ${label} must be an array.`, {
      code: 'bedrock_discovery_array_expected',
      details: { field: label },
    });
  }
  return value;
}

function optionalArray(value: unknown, label: string): readonly unknown[] {
  return value === undefined ? [] : requireArray(value, label);
}

function stringArray(value: unknown, label: string): readonly string[] {
  return uniqueStrings(
    optionalArray(value, label).map((item) => requireNonEmptyString(item, label)),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw malformed(`Bedrock ${label} must be a non-empty string.`, {
      code: 'bedrock_discovery_string_expected',
      details: { field: label },
    });
  }
  return value;
}

function optionalBoolean(value: unknown, label: string): boolean {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== 'boolean') {
    throw malformed(`Bedrock ${label} must be boolean.`, {
      code: 'bedrock_discovery_boolean_expected',
      details: { field: label },
    });
  }
  return value;
}

function requireProfileType(value: unknown): BedrockInferenceProfileType {
  if (value === 'APPLICATION' || value === 'SYSTEM_DEFINED') {
    return value;
  }
  throw malformed('Bedrock returned an invalid inference profile type.', {
    code: 'bedrock_discovery_profile_type_invalid',
  });
}

function requireLiteral<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw malformed(`Bedrock returned an invalid ${label}.`, {
      code: 'bedrock_discovery_literal_invalid',
      details: { field: label },
    });
  }
  return expected;
}

function rejectDuplicate<T>(values: readonly T[], key: (value: T) => string, code: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) {
      throw malformed('Bedrock discovery returned a duplicate identifier.', {
        code,
        details: { identifier: identity },
      });
    }
    seen.add(identity);
  }
}

function invalidOption(field: string, value: number): AiError {
  return new AiError('invalid_request', `Bedrock discovery option ${field} is invalid.`, {
    code: 'bedrock_discovery_option_invalid',
    details: { field, value: Number.isFinite(value) ? value : String(value) },
  });
}

function malformed(
  message: string,
  options: { readonly code: string; readonly details?: Record<string, string | number> },
): AiError {
  return new AiError('malformed_response', message, options);
}

import { AiError, type ModelCapabilities, type ModelSelector } from '@maduser/ai-ts';

import type { BedrockDiscoveryCatalog } from './discovery.js';

export interface BedrockCapabilityResolver {
  resolve(model: ModelSelector): Promise<ModelCapabilities | undefined>;
}

export interface BedrockCapabilityEntry {
  readonly capabilities: ModelCapabilities;
  readonly modelId: string;
}

export interface BedrockCapabilityRegistryOptions {
  readonly catalog?: BedrockDiscoveryCatalog;
  readonly entries: readonly BedrockCapabilityEntry[];
  /** Conservative capabilities used only when no exact entry exists. */
  readonly fallback?: ModelCapabilities;
}

/** Exact, application-supplied model capabilities with inference-profile correlation. */
export class BedrockCapabilityRegistry implements BedrockCapabilityResolver {
  readonly #capabilities = new Map<string, ModelCapabilities>();
  readonly #fallback: ModelCapabilities | undefined;
  readonly #profileModels = new Map<string, readonly string[]>();

  public constructor(options: BedrockCapabilityRegistryOptions) {
    for (const entry of options.entries) {
      const modelId = requireModelId(entry.modelId);
      if (this.#capabilities.has(modelId)) {
        throw new AiError('invalid_request', 'A Bedrock capability model ID is duplicated.', {
          code: 'bedrock_capability_duplicate_model',
          details: { modelId },
        });
      }
      this.#capabilities.set(modelId, cloneCapabilities(entry.capabilities));
    }
    for (const profile of options.catalog?.inferenceProfiles ?? []) {
      if (this.#capabilities.has(profile.inferenceProfileId)) {
        throw new AiError(
          'invalid_request',
          'A Bedrock capability entry conflicts with an inference-profile ID.',
          {
            code: 'bedrock_capability_profile_conflict',
            details: { inferenceProfileId: profile.inferenceProfileId },
          },
        );
      }
      this.#profileModels.set(profile.inferenceProfileId, [...profile.modelIds]);
    }
    this.#fallback =
      options.fallback === undefined ? undefined : cloneCapabilities(options.fallback);
  }

  public resolve(model: ModelSelector): Promise<ModelCapabilities | undefined> {
    if (model.provider !== 'bedrock') {
      return Promise.resolve(undefined);
    }
    const direct = this.#capabilities.get(model.model);
    if (direct !== undefined) {
      return Promise.resolve(cloneCapabilities(direct));
    }
    const profileModels = this.#profileModels.get(model.model);
    if (profileModels === undefined) {
      return Promise.resolve(cloneOptionalCapabilities(this.#fallback));
    }
    const capabilities: ModelCapabilities[] = [];
    for (const modelId of profileModels) {
      const value = this.#capabilities.get(modelId) ?? this.#fallback;
      if (value === undefined) {
        return Promise.resolve(undefined);
      }
      capabilities.push(value);
    }
    return Promise.resolve(
      capabilities.length === 0
        ? cloneOptionalCapabilities(this.#fallback)
        : intersect(capabilities),
    );
  }
}

function intersect(values: readonly ModelCapabilities[]): ModelCapabilities {
  return {
    input: {
      audio: values.every((value) => value.input.audio),
      documents: values.every((value) => value.input.documents),
      images: values.every((value) => value.input.images),
      text: values.every((value) => value.input.text),
    },
    ...intersectLimits(values),
    output: {
      audio: values.every((value) => value.output.audio),
      structured: values.every((value) => value.output.structured),
      text: values.every((value) => value.output.text),
    },
    realtime: values.every((value) => value.realtime),
    speechSynthesis: values.every((value) => value.speechSynthesis),
    streaming: values.every((value) => value.streaming),
    tools: {
      calls: values.every((value) => value.tools.calls),
      parallelCalls: values.every((value) => value.tools.parallelCalls),
      strictSchemas: values.every((value) => value.tools.strictSchemas),
    },
    transcription: values.every((value) => value.transcription),
  };
}

function intersectLimits(values: readonly ModelCapabilities[]): {
  readonly limits?: NonNullable<ModelCapabilities['limits']>;
} {
  const audioDurationMs = commonMinimum(values.map((value) => value.limits?.audioDurationMs));
  const contextTokens = commonMinimum(values.map((value) => value.limits?.contextTokens));
  const documentBytes = commonMinimum(values.map((value) => value.limits?.documentBytes));
  const outputTokens = commonMinimum(values.map((value) => value.limits?.outputTokens));
  if (
    audioDurationMs === undefined &&
    contextTokens === undefined &&
    documentBytes === undefined &&
    outputTokens === undefined
  ) {
    return {};
  }
  return {
    limits: {
      ...(audioDurationMs === undefined ? {} : { audioDurationMs }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
      ...(documentBytes === undefined ? {} : { documentBytes }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    },
  };
}

function commonMinimum(values: readonly (number | undefined)[]): number | undefined {
  if (values.some((value) => value === undefined)) {
    return undefined;
  }
  return Math.min(...values.flatMap((value) => (value === undefined ? [] : [value])));
}

function cloneOptionalCapabilities(
  value: ModelCapabilities | undefined,
): ModelCapabilities | undefined {
  return value === undefined ? undefined : cloneCapabilities(value);
}

function cloneCapabilities(value: ModelCapabilities): ModelCapabilities {
  return {
    input: { ...value.input },
    ...(value.limits === undefined ? {} : { limits: { ...value.limits } }),
    output: { ...value.output },
    realtime: value.realtime,
    speechSynthesis: value.speechSynthesis,
    streaming: value.streaming,
    tools: { ...value.tools },
    transcription: value.transcription,
  };
}

function requireModelId(value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new AiError('invalid_request', 'A Bedrock capability model ID is invalid.', {
      code: 'bedrock_capability_model_id_empty',
    });
  }
  return value;
}

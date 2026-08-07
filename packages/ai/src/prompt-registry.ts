import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { AiError } from './error.js';
import type { JsonObject, JsonSchema, JsonValue } from './json.js';

export interface PromptRef {
  readonly name: string;
  readonly version: string;
}

export interface PromptDefinition extends PromptRef {
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly template: string;
  readonly variablesSchema: JsonSchema;
}

export interface PromptEnvironmentBinding {
  readonly environment: string;
  readonly name: string;
  readonly version: string;
}

export type PromptSelector =
  | { readonly environment: string; readonly name: string }
  | { readonly name: string; readonly version: string };

export interface RenderedPrompt extends PromptRef {
  readonly fingerprint: string;
  readonly text: string;
  readonly variables: JsonObject;
}

interface RegisteredPrompt {
  readonly definition: PromptDefinition;
  readonly validate: ValidateFunction;
}

/** Immutable prompt versions with validated rendering and explicit environment routing. */
export class PromptRegistry {
  readonly #ajv = new Ajv2020({ allErrors: true, strict: true });
  readonly #bindings = new Map<string, PromptRef>();
  readonly #prompts = new Map<string, RegisteredPrompt>();

  public constructor(definitions: readonly PromptDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  public register(definition: PromptDefinition): void {
    validateIdentifier('prompt name', definition.name);
    validateIdentifier('prompt version', definition.version);
    const key = promptKey(definition);
    if (this.#prompts.has(key)) {
      throw new AiError('invalid_request', `Prompt ${key} is already registered.`, {
        code: 'duplicate_prompt_version',
        details: { name: definition.name, version: definition.version },
      });
    }
    validateTemplate(definition.template);
    let validate: ValidateFunction;
    try {
      validate = this.#ajv.compile(definition.variablesSchema);
    } catch (cause) {
      throw new AiError('invalid_request', `Prompt ${key} has an invalid variables schema.`, {
        cause,
        code: 'invalid_prompt_schema',
        details: { name: definition.name, version: definition.version },
      });
    }
    this.#prompts.set(key, { definition: clone(definition), validate });
  }

  public bindEnvironment(binding: PromptEnvironmentBinding): void {
    validateIdentifier('environment', binding.environment);
    const prompt = this.#require({ name: binding.name, version: binding.version });
    this.#bindings.set(environmentKey(binding.name, binding.environment), {
      name: prompt.definition.name,
      version: prompt.definition.version,
    });
  }

  public get(reference: PromptRef): PromptDefinition | undefined {
    const definition = this.#prompts.get(promptKey(reference))?.definition;
    return definition === undefined ? undefined : clone(definition);
  }

  public resolve(selector: PromptSelector): PromptDefinition {
    if ('version' in selector) {
      return clone(this.#require(selector).definition);
    }
    const reference = this.#bindings.get(environmentKey(selector.name, selector.environment));
    if (reference === undefined) {
      throw new AiError(
        'invalid_request',
        `Prompt ${selector.name} has no binding for ${selector.environment}.`,
        {
          code: 'prompt_environment_not_bound',
          details: { environment: selector.environment, name: selector.name },
        },
      );
    }
    return clone(this.#require(reference).definition);
  }

  public async render(selector: PromptSelector, variables: JsonObject): Promise<RenderedPrompt> {
    const prompt = this.#requireSelector(selector);
    if (!prompt.validate(variables)) {
      throw promptValidationError(prompt.definition, prompt.validate.errors);
    }
    const text = renderTemplate(prompt.definition.template, variables);
    const fingerprint = await sha256(
      canonicalJson({
        name: prompt.definition.name,
        text,
        variables,
        version: prompt.definition.version,
      }),
    );
    return {
      fingerprint,
      name: prompt.definition.name,
      text,
      variables: clone(variables),
      version: prompt.definition.version,
    };
  }

  #require(reference: PromptRef): RegisteredPrompt {
    const prompt = this.#prompts.get(promptKey(reference));
    if (prompt === undefined) {
      throw new AiError(
        'invalid_request',
        `Prompt ${reference.name}@${reference.version} is not registered.`,
        {
          code: 'prompt_not_found',
          details: { name: reference.name, version: reference.version },
        },
      );
    }
    return prompt;
  }

  #requireSelector(selector: PromptSelector): RegisteredPrompt {
    if ('version' in selector) {
      return this.#require(selector);
    }
    const reference = this.#bindings.get(environmentKey(selector.name, selector.environment));
    if (reference === undefined) {
      throw new AiError(
        'invalid_request',
        `Prompt ${selector.name} has no binding for ${selector.environment}.`,
        {
          code: 'prompt_environment_not_bound',
          details: { environment: selector.environment, name: selector.name },
        },
      );
    }
    return this.#require(reference);
  }
}

function renderTemplate(template: string, variables: JsonObject): string {
  return template.replaceAll(promptVariablePattern, (_placeholder, path: string): string => {
    const value = readPath(variables, path.split('.'));
    if (value === undefined) {
      throw new AiError('invalid_request', `Prompt variable ${path} is missing.`, {
        code: 'prompt_variable_missing',
        details: { path },
      });
    }
    if (value !== null && typeof value === 'object') {
      throw new AiError('invalid_request', `Prompt variable ${path} is not scalar.`, {
        code: 'prompt_variable_not_scalar',
        details: { path },
      });
    }
    return String(value);
  });
}

function readPath(value: JsonValue, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || isJsonArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function validateTemplate(template: string): void {
  if (template.length === 0) {
    throw new AiError('invalid_request', 'Prompt templates cannot be empty.', {
      code: 'empty_prompt_template',
    });
  }
  const withoutValidPlaceholders = template.replaceAll(promptVariablePattern, '');
  if (withoutValidPlaceholders.includes('{{') || withoutValidPlaceholders.includes('}}')) {
    throw new AiError('invalid_request', 'Prompt template contains an invalid placeholder.', {
      code: 'invalid_prompt_placeholder',
    });
  }
}

function validateIdentifier(label: string, value: string): void {
  if (!identifierPattern.test(value)) {
    throw new AiError('invalid_request', `Invalid ${label}: ${value}.`, {
      code: 'invalid_prompt_identifier',
      details: { label, value },
    });
  }
}

function promptValidationError(
  definition: PromptDefinition,
  errors: readonly ErrorObject[] | null | undefined,
): AiError {
  return new AiError('invalid_request', `Variables for ${promptKey(definition)} are invalid.`, {
    code: 'prompt_variables_invalid',
    details: {
      issues: (errors ?? []).map((error): JsonObject => ({
        instancePath: error.instancePath,
        keyword: error.keyword,
        message: error.message ?? 'Schema validation failed.',
        schemaPath: error.schemaPath,
      })),
      name: definition.name,
      version: definition.version,
    },
  });
}

function promptKey(reference: PromptRef): string {
  return `${reference.name}@${reference.version}`;
}

function environmentKey(name: string, environment: string): string {
  return `${name}\u0000${environment}`;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const promptVariablePattern =
  /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/gu;

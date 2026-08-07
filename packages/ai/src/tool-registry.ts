import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

import { AiError } from './error.js';
import type { JsonObject, JsonSchema, JsonValue } from './json.js';
import type { ToolCall, ToolDefinition } from './tool.js';
import type { ToolResultContentPart } from './content.js';

export interface ToolExecutionContext {
  readonly callId: string;
  readonly deadline: string;
  readonly runId: string;
  readonly signal: AbortSignal;
}

export interface ToolExecutionOutput {
  readonly content?: readonly ToolResultContentPart[];
  readonly structuredContent?: JsonValue;
}

export type ToolHandler = (
  arguments_: JsonObject,
  context: ToolExecutionContext,
) => Promise<ToolExecutionOutput> | ToolExecutionOutput;

export interface LocalTool {
  readonly definition: ToolDefinition;
  readonly execute: ToolHandler;
}

interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly execute: ToolHandler;
  readonly inputValidator: ValidateFunction;
  readonly outputValidator?: ValidateFunction;
}

/** Registry for validated local or remotely-backed tool executors. */
export class ToolRegistry {
  readonly #ajv: Ajv2020;
  readonly #tools = new Map<string, RegisteredTool>();

  public constructor(tools: readonly LocalTool[] = []) {
    this.#ajv = new Ajv2020({ allErrors: true, strict: true });
    for (const tool of tools) {
      this.register(tool);
    }
  }

  public get definitions(): readonly ToolDefinition[] {
    return [...this.#tools.values()].map(({ definition }) => definition);
  }

  public register(tool: LocalTool): void {
    const { definition } = tool;
    if (this.#tools.has(definition.name)) {
      throw new AiError('invalid_request', `Tool ${definition.name} is already registered.`, {
        code: 'duplicate_tool_name',
        details: { toolName: definition.name },
      });
    }

    const inputValidator = this.#compileSchema(definition.name, 'input', definition.inputSchema);
    const outputValidator =
      definition.outputSchema === undefined
        ? undefined
        : this.#compileSchema(definition.name, 'output', definition.outputSchema);

    this.#tools.set(definition.name, {
      definition,
      execute: tool.execute,
      inputValidator,
      ...(outputValidator === undefined ? {} : { outputValidator }),
    });
  }

  public definition(name: string): ToolDefinition | undefined {
    return this.#tools.get(name)?.definition;
  }

  public validate(call: ToolCall): void {
    const tool = this.#requireTool(call.name);
    if (!tool.inputValidator(call.arguments)) {
      throw validationError(call.name, 'input', tool.inputValidator.errors);
    }
  }

  public validateOutput(name: string, output: ToolExecutionOutput): void {
    const tool = this.#requireTool(name);
    if (tool.outputValidator !== undefined && !tool.outputValidator(output.structuredContent)) {
      throw validationError(name, 'output', tool.outputValidator.errors);
    }
  }

  public async execute(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionOutput> {
    const tool = this.#requireTool(call.name);
    if (!tool.inputValidator(call.arguments)) {
      throw validationError(call.name, 'input', tool.inputValidator.errors);
    }

    throwIfAborted(context.signal, call.name);
    const output = await tool.execute(call.arguments, context);
    throwIfAborted(context.signal, call.name);

    this.validateOutput(call.name, output);
    return output;
  }

  #compileSchema(
    toolName: string,
    boundary: 'input' | 'output',
    schema: JsonSchema,
  ): ValidateFunction {
    try {
      return this.#ajv.compile(schema);
    } catch (error) {
      throw new AiError('invalid_request', `Tool ${toolName} has an invalid ${boundary} schema.`, {
        cause: error,
        code: 'invalid_tool_schema',
        details: { boundary, toolName },
      });
    }
  }

  #requireTool(name: string): RegisteredTool {
    const tool = this.#tools.get(name);
    if (tool === undefined) {
      throw new AiError('tool_validation', `Tool ${name} is not registered.`, {
        code: 'tool_not_found',
        details: { toolName: name },
      });
    }
    return tool;
  }
}

function throwIfAborted(signal: AbortSignal, toolName: string): void {
  if (signal.aborted) {
    throw new AiError('cancelled', `Tool ${toolName} was cancelled.`, {
      cause: signal.reason,
      code: 'tool_cancelled',
      details: { toolName },
    });
  }
}

function validationError(
  toolName: string,
  boundary: 'input' | 'output',
  errors: readonly ErrorObject[] | null | undefined,
): AiError {
  return new AiError('tool_validation', `Tool ${toolName} failed ${boundary} validation.`, {
    code: `tool_${boundary}_validation_failed`,
    details: {
      boundary,
      issues: (errors ?? []).map((error): JsonObject => ({
        instancePath: error.instancePath,
        keyword: error.keyword,
        message: error.message ?? 'Schema validation failed.',
        schemaPath: error.schemaPath,
      })),
      toolName,
    },
  });
}

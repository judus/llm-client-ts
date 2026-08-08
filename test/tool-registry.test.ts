import { describe, expect, it, vi } from 'vitest';

import {
  ToolRegistry,
  type AiError,
  type LocalTool,
  type ToolCall,
  type ToolExecutionContext,
} from '../src/index.js';

const definition: LocalTool['definition'] = {
  annotations: { readOnly: true },
  description: 'Looks up a value.',
  inputSchema: {
    additionalProperties: false,
    properties: { id: { type: 'integer' } },
    required: ['id'],
    type: 'object',
  },
  name: 'lookup',
  outputSchema: {
    additionalProperties: false,
    properties: { value: { type: 'string' } },
    required: ['value'],
    type: 'object',
  },
};

const call: ToolCall = { arguments: { id: 42 }, id: 'call-1', name: 'lookup' };

function context(signal: AbortSignal = new AbortController().signal): ToolExecutionContext {
  return {
    callId: call.id,
    deadline: '2026-08-07T12:01:00.000Z',
    runId: 'run-1',
    signal,
  };
}

describe('ToolRegistry', () => {
  it('validates input before calling an executor and validates structured output', async () => {
    const execute = vi.fn(() => ({ structuredContent: { value: 'answer' } }));
    const registry = new ToolRegistry([{ definition, execute }]);

    await expect(registry.execute(call, context())).resolves.toEqual({
      structuredContent: { value: 'answer' },
    });
    expect(execute).toHaveBeenCalledOnce();

    await expect(
      registry.execute({ ...call, arguments: { id: 'invalid' } }, context()),
    ).rejects.toMatchObject({ category: 'tool_validation', code: 'tool_input_validation_failed' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects invalid executor output', async () => {
    const registry = new ToolRegistry([
      { definition, execute: () => ({ structuredContent: { value: 42 } }) },
    ]);

    await expect(registry.execute(call, context())).rejects.toMatchObject({
      category: 'tool_validation',
      code: 'tool_output_validation_failed',
    });
  });

  it('rejects duplicate names and invalid schemas at registration', () => {
    const tool: LocalTool = { definition, execute: () => ({}) };
    const registry = new ToolRegistry([tool]);

    expect(() => {
      registry.register(tool);
    }).toThrow(expect.objectContaining({ code: 'duplicate_tool_name' }));
    expect(
      () =>
        new ToolRegistry([
          {
            definition: { ...definition, inputSchema: { type: 'not-a-json-schema-type' } },
            execute: () => ({}),
          },
        ]),
    ).toThrow(expect.objectContaining({ code: 'invalid_tool_schema' }));
  });

  it('supports JSON Schema draft 2020-12', () => {
    expect(
      () =>
        new ToolRegistry([
          {
            definition: {
              ...definition,
              inputSchema: {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                properties: { value: { type: 'string' } },
                type: 'object',
                unevaluatedProperties: false,
              },
            },
            execute: () => ({}),
          },
        ]),
    ).not.toThrow();
  });

  it('normalizes unknown tools and pre-execution cancellation', async () => {
    const registry = new ToolRegistry();
    expect(() => {
      registry.validate(call);
    }).toThrow(expect.objectContaining({ code: 'tool_not_found' }));

    const controller = new AbortController();
    controller.abort('stop');
    const configured = new ToolRegistry([{ definition, execute: () => ({}) }]);
    await expect(configured.execute(call, context(controller.signal))).rejects.toEqual(
      expect.objectContaining<Partial<AiError>>({ category: 'cancelled', code: 'tool_cancelled' }),
    );
  });

  it('lists definitions and observes cancellation triggered during execution', async () => {
    const controller = new AbortController();
    const registry = new ToolRegistry([
      {
        definition: {
          annotations: { readOnly: true },
          description: definition.description,
          inputSchema: definition.inputSchema,
          name: definition.name,
        },
        execute: () => {
          controller.abort('finished too late');
          return {};
        },
      },
    ]);

    expect(registry.definitions).toHaveLength(1);
    await expect(registry.execute(call, context(controller.signal))).rejects.toMatchObject({
      category: 'cancelled',
      code: 'tool_cancelled',
    });
  });
});

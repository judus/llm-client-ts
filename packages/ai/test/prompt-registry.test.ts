import { describe, expect, it } from 'vitest';

import { PromptRegistry, type PromptDefinition } from '../src/index.js';

function definition(version = '1.0.0'): PromptDefinition {
  return {
    description: 'Greeting prompt.',
    name: 'support.greeting',
    template: 'Hello {{ user.name }}. Active: {{active}}. Count: {{ count }}.',
    variablesSchema: {
      additionalProperties: false,
      properties: {
        active: { type: 'boolean' },
        count: { type: 'integer' },
        user: {
          additionalProperties: false,
          properties: { name: { type: 'string' } },
          required: ['name'],
          type: 'object',
        },
      },
      required: ['active', 'count', 'user'],
      type: 'object',
    },
    version,
  };
}

describe('PromptRegistry', () => {
  it('validates, renders nested scalar variables, and fingerprints canonical content', async () => {
    const prompts = new PromptRegistry([definition()]);
    const first = await prompts.render(
      { name: 'support.greeting', version: '1.0.0' },
      { active: false, count: 2, user: { name: 'Ada' } },
    );
    const second = await prompts.render(
      { name: 'support.greeting', version: '1.0.0' },
      { user: { name: 'Ada' }, count: 2, active: false },
    );

    expect(first.text).toBe('Hello Ada. Active: false. Count: 2.');
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it('routes environments to immutable semantic versions', async () => {
    const prompts = new PromptRegistry([definition('1.0.0'), definition('2.0.0')]);
    prompts.bindEnvironment({
      environment: 'production',
      name: 'support.greeting',
      version: '1.0.0',
    });
    expect(prompts.resolve({ environment: 'production', name: 'support.greeting' }).version).toBe(
      '1.0.0',
    );

    prompts.bindEnvironment({
      environment: 'production',
      name: 'support.greeting',
      version: '2.0.0',
    });
    const rendered = await prompts.render(
      { environment: 'production', name: 'support.greeting' },
      { active: true, count: 1, user: { name: 'Grace' } },
    );
    expect(rendered).toMatchObject({ name: 'support.greeting', version: '2.0.0' });
  });

  it('defensively copies registered definitions and rendered variables', async () => {
    const source = definition();
    const prompts = new PromptRegistry([source]);
    Reflect.set(source, 'template', 'Changed');
    const fetched = prompts.get({ name: 'support.greeting', version: '1.0.0' });
    expect(fetched?.template).toContain('Hello');
    if (fetched !== undefined) {
      Reflect.set(fetched, 'template', 'Also changed');
    }
    expect(prompts.resolve({ name: 'support.greeting', version: '1.0.0' }).template).toContain(
      'Hello',
    );

    const variables = { active: true, count: 1, user: { name: 'Lin' } };
    const rendered = await prompts.render(
      { name: 'support.greeting', version: '1.0.0' },
      variables,
    );
    Reflect.set(variables.user, 'name', 'Changed');
    expect(rendered.variables).toMatchObject({ user: { name: 'Lin' } });
  });

  it('rejects invalid variables before rendering', async () => {
    const prompts = new PromptRegistry([definition()]);
    await expect(
      prompts.render(
        { name: 'support.greeting', version: '1.0.0' },
        { active: true, count: 'wrong', user: { name: 'Ada' } },
      ),
    ).rejects.toMatchObject({ code: 'prompt_variables_invalid' });
  });

  it('rejects missing and non-scalar placeholders even when allowed by schema', async () => {
    const prompts = new PromptRegistry([
      {
        name: 'flexible',
        template: 'Value: {{value}}',
        variablesSchema: { properties: {}, type: 'object' },
        version: '1',
      },
      {
        name: 'object',
        template: 'Value: {{value}}',
        variablesSchema: {
          properties: { value: { type: 'object' } },
          required: ['value'],
          type: 'object',
        },
        version: '1',
      },
    ]);
    await expect(prompts.render({ name: 'flexible', version: '1' }, {})).rejects.toMatchObject({
      code: 'prompt_variable_missing',
    });
    await expect(
      prompts.render({ name: 'object', version: '1' }, { value: {} }),
    ).rejects.toMatchObject({ code: 'prompt_variable_not_scalar' });
  });

  it('rejects duplicate, missing, unbound, and invalid definitions', () => {
    const prompts = new PromptRegistry([definition()]);
    expect(() => {
      prompts.register(definition());
    }).toThrow(expect.objectContaining({ code: 'duplicate_prompt_version' }));
    expect(() => prompts.resolve({ name: 'missing', version: '1' })).toThrow(
      expect.objectContaining({ code: 'prompt_not_found' }),
    );
    expect(() => prompts.resolve({ environment: 'test', name: 'support.greeting' })).toThrow(
      expect.objectContaining({ code: 'prompt_environment_not_bound' }),
    );
    expect(() => {
      prompts.bindEnvironment({ environment: 'test', name: 'missing', version: '1' });
    }).toThrow(expect.objectContaining({ code: 'prompt_not_found' }));
    expect(() => {
      prompts.register({ ...definition(), name: 'not valid!' });
    }).toThrow(expect.objectContaining({ code: 'invalid_prompt_identifier' }));
    expect(() => {
      prompts.register({ ...definition('2'), template: '' });
    }).toThrow(expect.objectContaining({ code: 'empty_prompt_template' }));
    expect(() => {
      prompts.register({ ...definition('3'), template: 'Bad {{ value-name }}' });
    }).toThrow(expect.objectContaining({ code: 'invalid_prompt_placeholder' }));
    expect(() => {
      prompts.register({ ...definition('4'), variablesSchema: { type: 'invalid' } });
    }).toThrow(expect.objectContaining({ code: 'invalid_prompt_schema' }));
    expect(prompts.get({ name: 'missing', version: '1' })).toBeUndefined();
  });
});

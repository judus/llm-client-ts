import { describe, expect, it } from 'vitest';

import {
  SafeDefaultToolPolicy,
  type PolicyEvaluationContext,
  type ToolAnnotations,
} from '../src/index.js';

function context(annotations?: ToolAnnotations): PolicyEvaluationContext {
  return {
    agentId: 'agent-1',
    call: { arguments: {}, id: 'call-1', name: 'tool' },
    runId: 'run-1',
    tool: {
      ...(annotations === undefined ? {} : { annotations }),
      description: 'A tool.',
      inputSchema: { type: 'object' },
      name: 'tool',
    },
  };
}

describe('SafeDefaultToolPolicy', () => {
  const policy = new SafeDefaultToolPolicy();

  it.each([
    [{ readOnly: true }, 'allow'],
    [{ requiresApproval: true }, 'deny'],
    [{ destructive: true, readOnly: true }, 'deny'],
    [undefined, 'deny'],
  ] as const)('evaluates annotations %j as %s', (annotations, outcome) => {
    expect(policy.evaluate(context(annotations))).toMatchObject({ outcome });
  });
});

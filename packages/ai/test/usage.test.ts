import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { addUsage, type Usage } from '../src/index.js';

describe('addUsage', () => {
  it('preserves absent dimensions instead of reporting zero', () => {
    expect(addUsage({}, {})).toEqual({});
  });

  it('adds provider-specific dimensions', () => {
    expect(
      addUsage(
        { inputTokens: 2, providerUnits: { requests: 1 } },
        { outputTokens: 3, providerUnits: { requests: 2, seconds: 4 } },
      ),
    ).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      providerUnits: { requests: 3, seconds: 4 },
    });
  });

  it('is commutative for normalized numeric usage', () => {
    const optionalCount = fc.option(fc.nat(), { nil: undefined });
    const usage = fc
      .tuple(optionalCount, optionalCount, optionalCount)
      .map(([inputTokens, outputTokens, reasoningTokens]) => ({
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
      }));

    fc.assert(
      fc.property(usage, usage, (left: Usage, right: Usage) => {
        expect(addUsage(left, right)).toEqual(addUsage(right, left));
      }),
    );
  });
});

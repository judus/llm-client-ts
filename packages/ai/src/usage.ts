export interface Money {
  /** A decimal amount represented as a string to avoid floating-point accounting errors. */
  readonly amount: string;
  /** ISO 4217 currency code. */
  readonly currency: string;
}

export interface Usage {
  readonly audioInputMs?: number;
  readonly audioInputTokens?: number;
  readonly audioOutputMs?: number;
  readonly audioOutputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly characters?: number;
  readonly estimatedCost?: Money;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly providerUnits?: Readonly<Record<string, number>>;
  readonly reasoningTokens?: number;
}

const usageKeys = [
  'audioInputMs',
  'audioInputTokens',
  'audioOutputMs',
  'audioOutputTokens',
  'cachedInputTokens',
  'characters',
  'inputTokens',
  'outputTokens',
  'reasoningTokens',
] as const;

type NumericUsageKey = (typeof usageKeys)[number];

/** Adds known usage dimensions without treating absent provider data as zero. */
export function addUsage(left: Usage, right: Usage): Usage {
  const values: Partial<Record<NumericUsageKey, number>> = {};

  for (const key of usageKeys) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue !== undefined || rightValue !== undefined) {
      values[key] = (leftValue ?? 0) + (rightValue ?? 0);
    }
  }

  const providerUnits = addProviderUnits(left.providerUnits, right.providerUnits);

  return {
    ...values,
    ...(providerUnits === undefined ? {} : { providerUnits }),
  };
}

function addProviderUnits(
  left: Readonly<Record<string, number>> | undefined,
  right: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }

  const result: Record<string, number> = { ...left };
  for (const [key, value] of Object.entries(right ?? {})) {
    result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

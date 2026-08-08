import type { JsonObject } from './json.js';

export interface CallOptions {
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly traceContext?: JsonObject;
}

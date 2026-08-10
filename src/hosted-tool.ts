import type { JsonObject } from './json.js';

/** A tool executed by the model provider rather than by the application. */
export interface HostedTool {
  readonly configuration?: JsonObject;
  readonly provider: string;
  readonly type: string;
}

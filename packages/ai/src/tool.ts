import type { JsonObject, JsonSchema } from './json.js';

export interface ToolAnnotations {
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly openWorld?: boolean;
  readonly readOnly?: boolean;
  readonly requiresApproval?: boolean;
}

export interface ToolDefinition {
  readonly annotations?: ToolAnnotations;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly name: string;
  readonly outputSchema?: JsonSchema;
}

export type ToolChoice =
  | { readonly type: 'auto' }
  | { readonly type: 'none' }
  | { readonly name: string; readonly type: 'required_tool' }
  | { readonly type: 'required' };

export interface ToolCall {
  readonly arguments: JsonObject;
  readonly id: string;
  readonly name: string;
}

import type { JsonObject } from './json.js';
import type { ToolExecutionOutput } from './tool-registry.js';
import type { ToolCall, ToolDefinition } from './tool.js';

export type PolicyDecision =
  | { readonly outcome: 'allow'; readonly reason: string }
  | { readonly outcome: 'deny'; readonly reason: string }
  | { readonly outcome: 'dry_run'; readonly reason: string; readonly result?: ToolExecutionOutput };

export interface PolicyEvaluationContext {
  readonly agentId: string;
  readonly call: ToolCall;
  readonly context?: JsonObject;
  readonly runId: string;
  readonly tool: ToolDefinition;
}

export interface ToolPolicy {
  evaluate(context: PolicyEvaluationContext): Promise<PolicyDecision> | PolicyDecision;
}

/**
 * Conservative default: only explicitly read-only, non-destructive tools run
 * without an application-supplied policy.
 */
export class SafeDefaultToolPolicy implements ToolPolicy {
  public evaluate(context: PolicyEvaluationContext): PolicyDecision {
    const annotations = context.tool.annotations;
    if (annotations?.requiresApproval === true) {
      return {
        outcome: 'deny',
        reason: 'The tool requires approval, but no approval policy is configured.',
      };
    }
    if (annotations?.destructive === true) {
      return { outcome: 'deny', reason: 'Destructive tools are denied by the default policy.' };
    }
    if (annotations?.readOnly !== true) {
      return {
        outcome: 'deny',
        reason: 'The default policy only allows explicitly read-only tools.',
      };
    }
    return { outcome: 'allow', reason: 'The tool is explicitly marked read-only.' };
  }
}

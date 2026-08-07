import type { ContentPart } from './content.js';
import type { SerializedAiError } from './error.js';
import type { JsonObject } from './json.js';
import type { ConversationMessage } from './message.js';
import type { ModelSelector } from './model.js';
import type { Usage } from './usage.js';

export interface AgentDefinition {
  readonly id: string;
  readonly instructions?: string;
  readonly model: ModelSelector;
  readonly parallelToolCalls?: boolean;
  readonly tools?: readonly string[];
  readonly version?: string;
}

export interface RunLimits {
  readonly maxCallsPerTool: number;
  readonly maxConcurrentTools: number;
  readonly maxDurationMs: number;
  readonly maxInputTokens: number;
  readonly maxModelSteps: number;
  readonly maxOutputTokens: number;
  readonly maxRepeatedToolFailures: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
}

export const defaultRunLimits: RunLimits = {
  maxCallsPerTool: 4,
  maxConcurrentTools: 4,
  maxDurationMs: 120_000,
  maxInputTokens: 200_000,
  maxModelSteps: 8,
  maxOutputTokens: 32_000,
  maxRepeatedToolFailures: 2,
  maxToolCalls: 16,
  maxTotalTokens: 232_000,
};

export interface AgentRunRequest {
  readonly agent: AgentDefinition;
  readonly context?: JsonObject;
  readonly conversationId?: string;
  readonly input: readonly ContentPart[];
  readonly limits?: Partial<RunLimits>;
}

export interface AgentRunOptions {
  readonly signal?: AbortSignal;
}

export type AgentRunStatus = 'cancelled' | 'completed' | 'failed' | 'limit_exceeded';

export interface AgentResult {
  readonly error?: SerializedAiError;
  readonly messages: readonly ConversationMessage[];
  readonly modelSteps: number;
  readonly output?: ConversationMessage;
  readonly runId: string;
  readonly status: AgentRunStatus;
  readonly toolCalls: number;
  readonly usage: Usage;
}

export interface RunBudgetSnapshot {
  readonly elapsedMs: number;
  readonly inputTokens?: number;
  readonly modelSteps: number;
  readonly outputTokens?: number;
  readonly toolCalls: number;
  readonly totalTokens?: number;
}

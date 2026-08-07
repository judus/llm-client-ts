import type { JsonObject } from './json.js';
import type { ConversationMessage } from './message.js';
import type { ModelSelector } from './model.js';

export interface SummaryLineage {
  readonly firstMessageId: string;
  readonly lastMessageId: string;
  readonly sourceMessagesRetained: boolean;
}

export interface ConversationSummary {
  readonly conversationId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly lineage: SummaryLineage;
  readonly model: ModelSelector;
  readonly promptName: string;
  readonly promptVersion: string;
  readonly structuredState?: JsonObject;
  readonly text: string;
}

export interface ConversationSummarizer {
  summarize(
    request: SummarizationRequest,
    options?: SummarizationOptions,
  ): Promise<ConversationSummary>;
}

export interface SummarizationRequest {
  readonly conversationId: string;
  readonly firstMessageId: string;
  readonly lastMessageId: string;
  readonly messages: readonly ConversationMessage[];
  readonly sourceMessagesRetained: boolean;
}

export interface SummarizationOptions {
  readonly signal?: AbortSignal;
}

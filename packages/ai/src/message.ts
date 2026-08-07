import type { ContentPart } from './content.js';
import type { JsonObject } from './json.js';

export type MessageRole = 'assistant' | 'developer' | 'system' | 'tool' | 'user';

/** A provider-independent message stored in an application-owned conversation. */
export interface ConversationMessage {
  readonly content: readonly ContentPart[];
  readonly conversationId: string;
  readonly createdAt: string;
  readonly id: string;
  readonly metadata?: JsonObject;
  readonly parentId?: string;
  readonly role: MessageRole;
  readonly runId?: string;
}

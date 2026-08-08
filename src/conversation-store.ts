import { AiError } from './error.js';
import type { JsonObject } from './json.js';
import type { ConversationMessage } from './message.js';

export interface Conversation {
  readonly createdAt: string;
  readonly id: string;
  readonly metadata?: JsonObject;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface CreateConversation {
  readonly id?: string;
  readonly metadata?: JsonObject;
}

export interface AppendMessagesOptions {
  readonly expectedRevision: number;
}

export interface MessageQuery {
  readonly afterId?: string;
  readonly beforeId?: string;
  readonly limit?: number;
  readonly order?: 'ascending' | 'descending';
}

export interface ConversationSnapshot {
  readonly conversation: Conversation;
  readonly messages: readonly ConversationMessage[];
}

export interface ConversationStore {
  append(
    id: string,
    messages: readonly ConversationMessage[],
    options: AppendMessagesOptions,
  ): Promise<Conversation>;
  create(input?: CreateConversation): Promise<Conversation>;
  get(id: string): Promise<Conversation | undefined>;
  listMessages(id: string, query?: MessageQuery): Promise<readonly ConversationMessage[]>;
  snapshot(id: string, query?: MessageQuery): Promise<ConversationSnapshot | undefined>;
}

interface ConversationRecord {
  conversation: Conversation;
  messages: ConversationMessage[];
  messageIds: Set<string>;
}

export interface InMemoryConversationStoreOptions {
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

/** In-memory reference store with optimistic revision checks and defensive copies. */
export class InMemoryConversationStore implements ConversationStore {
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #records = new Map<string, ConversationRecord>();

  public constructor(options: InMemoryConversationStoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  public create(input: CreateConversation = {}): Promise<Conversation> {
    const id = input.id ?? this.#idGenerator();
    if (this.#records.has(id)) {
      return Promise.reject(
        new AiError('persistence_conflict', `Conversation ${id} already exists.`, {
          code: 'conversation_already_exists',
          details: { conversationId: id },
        }),
      );
    }
    const occurredAt = this.#clock().toISOString();
    const conversation: Conversation = {
      createdAt: occurredAt,
      id,
      ...(input.metadata === undefined ? {} : { metadata: clone(input.metadata) }),
      revision: 0,
      updatedAt: occurredAt,
    };
    this.#records.set(id, { conversation, messageIds: new Set<string>(), messages: [] });
    return Promise.resolve(clone(conversation));
  }

  public get(id: string): Promise<Conversation | undefined> {
    const conversation = this.#records.get(id)?.conversation;
    return Promise.resolve(conversation === undefined ? undefined : clone(conversation));
  }

  public append(
    id: string,
    messages: readonly ConversationMessage[],
    options: AppendMessagesOptions,
  ): Promise<Conversation> {
    const record = this.#records.get(id);
    if (record === undefined) {
      return Promise.reject(conversationNotFound(id));
    }
    if (record.conversation.revision !== options.expectedRevision) {
      return Promise.reject(
        new AiError('persistence_conflict', `Conversation ${id} changed concurrently.`, {
          code: 'conversation_revision_conflict',
          details: {
            actualRevision: record.conversation.revision,
            conversationId: id,
            expectedRevision: options.expectedRevision,
          },
          retryable: true,
        }),
      );
    }
    if (messages.length === 0) {
      return Promise.resolve(clone(record.conversation));
    }

    const batchIds = new Set<string>();
    for (const message of messages) {
      if (message.conversationId !== id) {
        return Promise.reject(
          new AiError('invalid_request', `Message ${message.id} belongs to another conversation.`, {
            code: 'message_conversation_mismatch',
            details: {
              conversationId: id,
              messageConversationId: message.conversationId,
              messageId: message.id,
            },
          }),
        );
      }
      if (record.messageIds.has(message.id) || batchIds.has(message.id)) {
        return Promise.reject(
          new AiError('persistence_conflict', `Message ${message.id} already exists.`, {
            code: 'duplicate_message_id',
            details: { conversationId: id, messageId: message.id },
          }),
        );
      }
      batchIds.add(message.id);
    }

    const appended = clone(messages);
    record.messages.push(...appended);
    for (const message of appended) {
      record.messageIds.add(message.id);
    }
    record.conversation = {
      ...record.conversation,
      revision: record.conversation.revision + 1,
      updatedAt: this.#clock().toISOString(),
    };
    return Promise.resolve(clone(record.conversation));
  }

  public listMessages(
    id: string,
    query: MessageQuery = {},
  ): Promise<readonly ConversationMessage[]> {
    const record = this.#records.get(id);
    if (record === undefined) {
      return Promise.reject(conversationNotFound(id));
    }
    try {
      return Promise.resolve(selectMessages(record.messages, query));
    } catch (error) {
      return rejectUnknown(error);
    }
  }

  public snapshot(id: string, query: MessageQuery = {}): Promise<ConversationSnapshot | undefined> {
    const record = this.#records.get(id);
    if (record === undefined) {
      return Promise.resolve(undefined);
    }
    try {
      return Promise.resolve({
        conversation: clone(record.conversation),
        messages: selectMessages(record.messages, query),
      });
    } catch (error) {
      return rejectUnknown(error);
    }
  }
}

function selectMessages(
  messages: readonly ConversationMessage[],
  query: MessageQuery,
): readonly ConversationMessage[] {
  validateQuery(query);
  const afterIndex = query.afterId === undefined ? -1 : findMessage(messages, query.afterId);
  const beforeIndex =
    query.beforeId === undefined ? messages.length : findMessage(messages, query.beforeId);
  const selected = messages.slice(afterIndex + 1, beforeIndex);
  if (query.order === 'descending') {
    selected.reverse();
  }
  return clone(query.limit === undefined ? selected : selected.slice(0, query.limit));
}

function findMessage(messages: readonly ConversationMessage[], id: string): number {
  const index = messages.findIndex((message) => message.id === id);
  if (index < 0) {
    throw new AiError('invalid_request', `Message ${id} was not found in the conversation.`, {
      code: 'message_cursor_not_found',
      details: { messageId: id },
    });
  }
  return index;
}

function validateQuery(query: MessageQuery): void {
  if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) {
    throw new AiError('invalid_request', 'Message query limit must be a positive safe integer.', {
      code: 'invalid_message_query_limit',
      details: { limit: query.limit },
    });
  }
}

function conversationNotFound(id: string): AiError {
  return new AiError('invalid_request', `Conversation ${id} was not found.`, {
    code: 'conversation_not_found',
    details: { conversationId: id },
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function rejectUnknown(error: unknown): Promise<never> {
  return Promise.reject(
    error instanceof Error
      ? error
      : new AiError('persistence_conflict', 'Conversation storage failed unexpectedly.', {
          cause: error,
          code: 'conversation_store_failed',
        }),
  );
}

import { AiError } from './error.js';
import type { ConversationMessage } from './message.js';

export interface TokenEstimator {
  estimate(message: ConversationMessage): number;
}

export interface ContextSelectionOptions {
  readonly maxContextTokens: number;
  readonly reserveOutputTokens: number;
  readonly reserveToolResultTokens: number;
}

export type ContextOmissionReason = 'budget' | 'incomplete_tool_group' | 'orphan_tool_result';

export interface OmittedContextMessage {
  readonly messageId: string;
  readonly reason: ContextOmissionReason;
}

export interface ContextSelection {
  readonly availableInputTokens: number;
  readonly estimatedInputTokens: number;
  readonly messages: readonly ConversationMessage[];
  readonly omitted: readonly OmittedContextMessage[];
}

interface MessageGroup {
  readonly complete: boolean;
  readonly messages: readonly ConversationMessage[];
  readonly pinned: boolean;
  readonly reason?: ContextOmissionReason;
  readonly tokens: number;
}

/** Deterministic fallback estimator. Provider-specific estimators can be injected. */
export class CharacterTokenEstimator implements TokenEstimator {
  readonly #charactersPerToken: number;

  public constructor(charactersPerToken = 4) {
    if (!Number.isFinite(charactersPerToken) || charactersPerToken <= 0) {
      throw new AiError('invalid_request', 'charactersPerToken must be greater than zero.', {
        code: 'invalid_token_estimator_ratio',
      });
    }
    this.#charactersPerToken = charactersPerToken;
  }

  public estimate(message: ConversationMessage): number {
    return Math.max(1, Math.ceil(JSON.stringify(message).length / this.#charactersPerToken));
  }
}

/** Selects recent history without separating a tool call from its result messages. */
export class PairSafeHistorySelector {
  readonly #estimator: TokenEstimator;

  public constructor(estimator: TokenEstimator = new CharacterTokenEstimator()) {
    this.#estimator = estimator;
  }

  public select(
    messages: readonly ConversationMessage[],
    options: ContextSelectionOptions,
  ): ContextSelection {
    const availableInputTokens = validateContextBudget(options);
    const groups = groupMessages(messages, this.#estimator);
    const selected = new Set<MessageGroup>();
    let estimatedInputTokens = 0;

    for (const group of groups) {
      if (!group.pinned || !group.complete) {
        continue;
      }
      if (estimatedInputTokens + group.tokens > availableInputTokens) {
        throw new AiError('budget_exceeded', 'Pinned instructions exceed the context budget.', {
          code: 'pinned_context_exceeds_budget',
          details: { availableInputTokens, requiredTokens: estimatedInputTokens + group.tokens },
        });
      }
      selected.add(group);
      estimatedInputTokens += group.tokens;
    }

    for (const group of [...groups].reverse()) {
      if (selected.has(group) || !group.complete || group.pinned) {
        continue;
      }
      if (estimatedInputTokens + group.tokens <= availableInputTokens) {
        selected.add(group);
        estimatedInputTokens += group.tokens;
      }
    }

    const selectedMessages: ConversationMessage[] = [];
    const omitted: OmittedContextMessage[] = [];
    for (const group of groups) {
      if (selected.has(group)) {
        selectedMessages.push(...group.messages);
      } else {
        const reason = group.complete ? 'budget' : (group.reason ?? 'incomplete_tool_group');
        omitted.push(...group.messages.map((message) => ({ messageId: message.id, reason })));
      }
    }

    return {
      availableInputTokens,
      estimatedInputTokens,
      messages: selectedMessages,
      omitted,
    };
  }
}

function groupMessages(
  messages: readonly ConversationMessage[],
  estimator: TokenEstimator,
): readonly MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    const callIds = message.content
      .filter((part) => part.type === 'tool_call')
      .map((part) => part.callId);
    if (callIds.length > 0) {
      const groupMessages = [message];
      const unresolved = new Set(callIds);
      let cursor = index + 1;
      while (cursor < messages.length && unresolved.size > 0) {
        const candidate = messages[cursor];
        if (candidate?.role !== 'tool') {
          break;
        }
        const resultIds = candidate.content.flatMap((part) =>
          part.type === 'tool_result' ? [part.callId] : [],
        );
        if (resultIds.length === 0 || resultIds.some((callId) => !unresolved.has(callId))) {
          break;
        }
        groupMessages.push(candidate);
        for (const callId of resultIds) {
          unresolved.delete(callId);
        }
        cursor += 1;
      }
      groups.push(makeGroup(groupMessages, estimator, unresolved.size === 0));
      index = cursor - 1;
      continue;
    }
    if (message.role === 'tool') {
      groups.push({
        ...makeGroup([message], estimator, false),
        reason: 'orphan_tool_result',
      });
      continue;
    }
    groups.push(makeGroup([message], estimator, true));
  }
  return groups;
}

function makeGroup(
  messages: readonly ConversationMessage[],
  estimator: TokenEstimator,
  complete: boolean,
): MessageGroup {
  return {
    complete,
    messages,
    pinned: messages.every((message) => message.role === 'developer' || message.role === 'system'),
    tokens: messages.reduce((total, message) => total + estimator.estimate(message), 0),
  };
}

function validateContextBudget(options: ContextSelectionOptions): number {
  for (const name of contextBudgetNames) {
    const value = options[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AiError('invalid_request', `${name} must be a non-negative safe integer.`, {
        code: 'invalid_context_budget',
        details: { name, value },
      });
    }
  }
  const available =
    options.maxContextTokens - options.reserveOutputTokens - options.reserveToolResultTokens;
  if (available <= 0) {
    throw new AiError('invalid_request', 'Context reserves leave no input-token capacity.', {
      code: 'context_reserve_exhausted',
      details: { availableInputTokens: available },
    });
  }
  return available;
}

const contextBudgetNames: readonly (keyof ContextSelectionOptions)[] = [
  'maxContextTokens',
  'reserveOutputTokens',
  'reserveToolResultTokens',
];

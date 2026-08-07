import { describe, expect, it } from 'vitest';

import {
  CharacterTokenEstimator,
  PairSafeHistorySelector,
  type ConversationMessage,
  type TokenEstimator,
  type ToolCallPart,
  type ToolResultPart,
} from '../src/index.js';

class FixedEstimator implements TokenEstimator {
  public estimate(): number {
    return 10;
  }
}

function textMessage(id: string, role: ConversationMessage['role']): ConversationMessage {
  return {
    content: [{ text: id, type: 'text' }],
    conversationId: 'conversation-1',
    createdAt: '2026-08-07T12:00:00.000Z',
    id,
    role,
  };
}

function callMessage(id: string, calls: readonly ToolCallPart[]): ConversationMessage {
  return {
    content: calls,
    conversationId: 'conversation-1',
    createdAt: '2026-08-07T12:00:00.000Z',
    id,
    role: 'assistant',
  };
}

function resultMessage(id: string, results: readonly ToolResultPart[]): ConversationMessage {
  return {
    content: results,
    conversationId: 'conversation-1',
    createdAt: '2026-08-07T12:00:00.000Z',
    id,
    role: 'tool',
  };
}

const call = (id: string): ToolCallPart => ({
  arguments: {},
  callId: id,
  name: 'lookup',
  type: 'tool_call',
});

const result = (id: string): ToolResultPart => ({
  callId: id,
  content: [],
  status: 'success',
  type: 'tool_result',
});

describe('PairSafeHistorySelector', () => {
  const selector = new PairSafeHistorySelector(new FixedEstimator());

  it('pins instructions and selects the most recent messages within reserved capacity', () => {
    const selection = selector.select(
      [
        textMessage('system', 'system'),
        textMessage('old', 'user'),
        textMessage('newer', 'assistant'),
        textMessage('latest', 'user'),
      ],
      { maxContextTokens: 35, reserveOutputTokens: 5, reserveToolResultTokens: 0 },
    );

    expect(selection.messages.map(({ id }) => id)).toEqual(['system', 'newer', 'latest']);
    expect(selection.omitted).toEqual([{ messageId: 'old', reason: 'budget' }]);
    expect(selection).toMatchObject({ availableInputTokens: 30, estimatedInputTokens: 30 });
  });

  it('keeps multi-result tool groups atomic', () => {
    const messages = [
      textMessage('older', 'user'),
      callMessage('calls', [call('a'), call('b')]),
      resultMessage('result-a', [result('a')]),
      resultMessage('result-b', [result('b')]),
      textMessage('latest', 'assistant'),
    ];
    const selected = selector.select(messages, {
      maxContextTokens: 45,
      reserveOutputTokens: 5,
      reserveToolResultTokens: 0,
    });
    expect(selected.messages.map(({ id }) => id)).toEqual([
      'calls',
      'result-a',
      'result-b',
      'latest',
    ]);

    const omitted = selector.select(messages, {
      maxContextTokens: 35,
      reserveOutputTokens: 5,
      reserveToolResultTokens: 0,
    });
    expect(omitted.messages.map(({ id }) => id)).toEqual(['older', 'latest']);
    expect(omitted.omitted.filter(({ messageId }) => messageId.startsWith('result'))).toHaveLength(
      2,
    );
  });

  it('omits incomplete and orphaned tool history with explicit reasons', () => {
    const selection = selector.select(
      [
        callMessage('incomplete', [call('a'), call('b')]),
        resultMessage('only-a', [result('a')]),
        resultMessage('orphan', [result('other')]),
      ],
      { maxContextTokens: 100, reserveOutputTokens: 10, reserveToolResultTokens: 10 },
    );

    expect(selection.messages).toEqual([]);
    expect(selection.omitted).toEqual([
      { messageId: 'incomplete', reason: 'incomplete_tool_group' },
      { messageId: 'only-a', reason: 'incomplete_tool_group' },
      { messageId: 'orphan', reason: 'orphan_tool_result' },
    ]);
  });

  it('rejects impossible budgets and oversized pinned instructions', () => {
    expect(() =>
      selector.select([textMessage('system', 'system')], {
        maxContextTokens: 5,
        reserveOutputTokens: 0,
        reserveToolResultTokens: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'pinned_context_exceeds_budget' }));
    expect(() =>
      selector.select([], {
        maxContextTokens: 10,
        reserveOutputTokens: 5,
        reserveToolResultTokens: 5,
      }),
    ).toThrow(expect.objectContaining({ code: 'context_reserve_exhausted' }));
    expect(() =>
      selector.select([], {
        maxContextTokens: -1,
        reserveOutputTokens: 0,
        reserveToolResultTokens: 0,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_context_budget' }));
  });
});

describe('CharacterTokenEstimator', () => {
  it('provides a deterministic non-zero fallback estimate', () => {
    expect(new CharacterTokenEstimator(100_000).estimate(textMessage('x', 'user'))).toBe(1);
  });

  it('rejects invalid ratios', () => {
    expect(() => new CharacterTokenEstimator(0)).toThrow(
      expect.objectContaining({ code: 'invalid_token_estimator_ratio' }),
    );
  });
});

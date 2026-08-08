import { describe, expect, it } from 'vitest';

import { InMemoryConversationStore, type ConversationMessage } from '../src/index.js';

function message(id: string, conversationId = 'conversation-1'): ConversationMessage {
  return {
    content: [{ source: 'typed', text: id, type: 'text' }],
    conversationId,
    createdAt: '2026-08-07T12:00:00.000Z',
    id,
    role: 'user',
  };
}

function store(): InMemoryConversationStore {
  let timestamp = 0;
  return new InMemoryConversationStore({
    clock: () => new Date(1_786_104_000_000 + timestamp++ * 1_000),
    idGenerator: () => 'generated-conversation',
  });
}

describe('InMemoryConversationStore', () => {
  it('creates, reads, appends, and snapshots with optimistic revisions', async () => {
    const conversations = store();
    const created = await conversations.create({
      id: 'conversation-1',
      metadata: { mutable: { value: 1 } },
    });
    expect(created).toMatchObject({ id: 'conversation-1', revision: 0 });

    const updated = await conversations.append(
      created.id,
      [message('message-1'), message('message-2')],
      { expectedRevision: 0 },
    );
    expect(updated).toMatchObject({ id: 'conversation-1', revision: 1 });
    const snapshot = await conversations.snapshot(created.id);
    expect(snapshot?.messages.map(({ id }) => id)).toEqual(['message-1', 'message-2']);
    expect(snapshot?.conversation.revision).toBe(1);
  });

  it('returns defensive copies and generates an ID when none is supplied', async () => {
    const conversations = store();
    const created = await conversations.create({ metadata: { label: 'original' } });
    const fetched = await conversations.get(created.id);
    expect(created.id).toBe('generated-conversation');
    if (fetched?.metadata !== undefined) {
      Reflect.set(fetched.metadata, 'label', 'changed');
    }
    expect((await conversations.get(created.id))?.metadata).toEqual({ label: 'original' });

    const original = message('message-1', created.id);
    await conversations.append(created.id, [original], { expectedRevision: 0 });
    Reflect.set(original.content[0] ?? {}, 'text', 'mutated');
    expect((await conversations.listMessages(created.id))[0]?.content).toEqual([
      { source: 'typed', text: 'message-1', type: 'text' },
    ]);
  });

  it('rejects stale writes, duplicate IDs, and mismatched conversations atomically', async () => {
    const conversations = store();
    await conversations.create({ id: 'conversation-1' });
    await conversations.append('conversation-1', [message('message-1')], {
      expectedRevision: 0,
    });

    await expect(
      conversations.append('conversation-1', [message('message-2')], { expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'conversation_revision_conflict', retryable: true });
    await expect(
      conversations.append('conversation-1', [message('message-1')], { expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: 'duplicate_message_id' });
    await expect(
      conversations.append('conversation-1', [message('same'), message('same')], {
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'duplicate_message_id' });
    await expect(
      conversations.append('conversation-1', [message('foreign', 'other')], {
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'message_conversation_mismatch' });
    expect(await conversations.listMessages('conversation-1')).toHaveLength(1);
  });

  it('supports stable cursors, ordering, limits, and empty appends', async () => {
    const conversations = store();
    const created = await conversations.create({ id: 'conversation-1' });
    const unchanged = await conversations.append('conversation-1', [], { expectedRevision: 0 });
    expect(unchanged).toEqual(created);
    await conversations.append(
      'conversation-1',
      [message('one'), message('two'), message('three')],
      { expectedRevision: 0 },
    );

    await expect(
      conversations.listMessages('conversation-1', {
        afterId: 'one',
        beforeId: 'three',
      }),
    ).resolves.toMatchObject([{ id: 'two' }]);
    await expect(
      conversations.listMessages('conversation-1', { limit: 2, order: 'descending' }),
    ).resolves.toMatchObject([{ id: 'three' }, { id: 'two' }]);
    await expect(
      conversations.listMessages('conversation-1', { afterId: 'missing' }),
    ).rejects.toMatchObject({ code: 'message_cursor_not_found' });
    await expect(conversations.listMessages('conversation-1', { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_message_query_limit',
    });
  });

  it('normalizes missing and duplicate conversations', async () => {
    const conversations = store();
    await conversations.create({ id: 'conversation-1' });
    await expect(conversations.create({ id: 'conversation-1' })).rejects.toMatchObject({
      code: 'conversation_already_exists',
    });
    await expect(
      conversations.append('missing', [message('message-1', 'missing')], { expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'conversation_not_found' });
    await expect(conversations.listMessages('missing')).rejects.toMatchObject({
      code: 'conversation_not_found',
    });
    await expect(conversations.get('missing')).resolves.toBeUndefined();
    await expect(conversations.snapshot('missing')).resolves.toBeUndefined();
  });
});

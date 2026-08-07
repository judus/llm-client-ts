import { describe, expect, it } from 'vitest';

import {
  ApprovalCoordinator,
  InMemoryApprovalStore,
  hashApprovalAction,
  toolApprovalAction,
  type ApprovalAction,
  type ApprovalRequest,
  type JsonObject,
} from '../src/index.js';

const createdAt = '2026-08-07T12:00:00.000Z';
const expiresAt = '2026-08-07T13:00:00.000Z';

function action(arguments_: ApprovalAction['arguments'] = { customerId: 42 }): ApprovalAction {
  return {
    arguments: arguments_,
    context: { tenantId: 'tenant-1' },
    kind: 'external_write',
    target: 'customer.update',
  };
}

interface ApprovalFixture {
  readonly approvals: ApprovalCoordinator;
  readonly setNow: (value: string) => void;
  readonly store: InMemoryApprovalStore;
}

function setup(): ApprovalFixture {
  let now = new Date(createdAt);
  const store = new InMemoryApprovalStore();
  const approvals = new ApprovalCoordinator({
    clock: () => now,
    idGenerator: () => 'approval-1',
    store,
  });
  return {
    approvals,
    setNow(value: string) {
      now = new Date(value);
    },
    store,
  };
}

async function request(
  approvals: ApprovalCoordinator,
  proposed = action(),
): Promise<ApprovalRequest> {
  return approvals.request({
    action: proposed,
    description: 'Update customer 42.',
    expiresAt,
  });
}

describe('approvals', () => {
  it('hashes canonical actions deterministically and binds every action field', async () => {
    const first = action({ nested: { alpha: 1, beta: 2 }, customerId: 42 });
    const reordered = action({ customerId: 42, nested: { beta: 2, alpha: 1 } });

    expect(await hashApprovalAction(first)).toBe(await hashApprovalAction(reordered));
    expect(await hashApprovalAction(first)).toMatch(/^[a-f0-9]{64}$/u);
    await expect(hashApprovalAction(action({ customerId: 43 }))).resolves.not.toBe(
      await hashApprovalAction(first),
    );
    await expect(
      hashApprovalAction({ ...first, context: { tenantId: 'tenant-2' } }),
    ).resolves.not.toBe(await hashApprovalAction(first));
  });

  it('rejects non-JSON numbers and cyclic values at the hash boundary', async () => {
    const invalidNumber = action();
    Reflect.set(invalidNumber.arguments, 'value', Number.NaN);
    await expect(hashApprovalAction(invalidNumber)).rejects.toMatchObject({
      code: 'invalid_approval_action_json',
    });

    const circular: JsonObject = {};
    Reflect.set(circular, 'self', circular);
    await expect(hashApprovalAction(action(circular))).rejects.toMatchObject({
      code: 'invalid_approval_action_json',
    });
  });

  it('creates a pending request and requires a decision before verification', async () => {
    const { approvals } = setup();
    const proposed = action();
    const pending = await request(approvals, proposed);

    expect(pending).toMatchObject({
      action: proposed,
      createdAt,
      description: 'Update customer 42.',
      expiresAt,
      id: 'approval-1',
      status: 'pending',
    });
    await expect(approvals.verify(pending.id, proposed)).rejects.toMatchObject({
      category: 'approval_required',
      code: 'approval_pending',
    });
  });

  it('records one actor-bound approval and verifies only the exact action', async () => {
    const { approvals } = setup();
    const proposed = action();
    const pending = await request(approvals, proposed);
    const approved = await approvals.decide({
      actorId: 'operator-7',
      decidedAt: '2026-08-07T12:05:00.000Z',
      decision: 'approved',
      expectedActionHash: pending.actionHash,
      reason: 'Confirmed with customer.',
      requestId: pending.id,
    });

    expect(approved).toMatchObject({
      resolution: {
        actorId: 'operator-7',
        decision: 'approved',
        reason: 'Confirmed with customer.',
      },
      status: 'approved',
    });
    await expect(approvals.verify(pending.id, proposed)).resolves.toEqual(approved);
    await expect(approvals.verify(pending.id, action({ customerId: 99 }))).rejects.toMatchObject({
      code: 'approval_action_mismatch',
    });
  });

  it('preserves denials and their reason', async () => {
    const { approvals } = setup();
    const pending = await request(approvals);
    await approvals.decide({
      actorId: 'operator-7',
      decision: 'denied',
      expectedActionHash: pending.actionHash,
      reason: 'Customer declined.',
      requestId: pending.id,
    });

    await expect(approvals.verify(pending.id, action())).rejects.toMatchObject({
      category: 'policy_denial',
      code: 'approval_denied',
      details: { reason: 'Customer declined.' },
    });
  });

  it('rejects stale, mismatched, duplicate, and chronologically invalid decisions', async () => {
    const { approvals } = setup();
    const pending = await request(approvals);

    await expect(
      approvals.decide({
        actorId: 'operator-7',
        decidedAt: '2026-08-07T11:59:00.000Z',
        decision: 'approved',
        expectedActionHash: pending.actionHash,
        requestId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'invalid_approval_decision_time' });
    await expect(
      approvals.decide({
        actorId: 'operator-7',
        decision: 'approved',
        expectedActionHash: 'wrong-hash',
        requestId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'approval_action_hash_mismatch' });

    await approvals.decide({
      actorId: 'operator-7',
      decision: 'approved',
      expectedActionHash: pending.actionHash,
      requestId: pending.id,
    });
    await expect(
      approvals.decide({
        actorId: 'operator-8',
        decision: 'denied',
        expectedActionHash: pending.actionHash,
        requestId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'approval_already_resolved' });
  });

  it('enforces expiry both when deciding and when using an approval', async () => {
    const deciding = setup();
    const pending = await request(deciding.approvals);
    deciding.setNow(expiresAt);
    await expect(
      deciding.approvals.decide({
        actorId: 'operator-7',
        decision: 'approved',
        expectedActionHash: pending.actionHash,
        requestId: pending.id,
      }),
    ).rejects.toMatchObject({ code: 'approval_expired' });

    const verifying = setup();
    const approved = await request(verifying.approvals);
    await verifying.approvals.decide({
      actorId: 'operator-7',
      decision: 'approved',
      expectedActionHash: approved.actionHash,
      requestId: approved.id,
    });
    verifying.setNow(expiresAt);
    await expect(verifying.approvals.verify(approved.id, action())).rejects.toMatchObject({
      code: 'approval_expired',
    });
  });

  it('validates request and decision metadata and missing records', async () => {
    const { approvals } = setup();
    await expect(
      approvals.request({ action: action(), description: ' ', expiresAt }),
    ).rejects.toMatchObject({ code: 'empty_approval_description' });
    await expect(
      approvals.request({
        action: { ...action(), target: ' ' },
        description: 'Invalid target.',
        expiresAt,
      }),
    ).rejects.toMatchObject({ code: 'empty_approval_action_target' });
    await expect(
      approvals.request({ action: action(), description: 'Bad date.', expiresAt: 'tomorrow' }),
    ).rejects.toMatchObject({ code: 'invalid_approval_timestamp' });
    await expect(
      approvals.request({
        action: action(),
        description: 'Already expired.',
        expiresAt: createdAt,
      }),
    ).rejects.toMatchObject({ code: 'invalid_approval_expiry' });
    await expect(
      approvals.decide({
        actorId: ' ',
        decision: 'approved',
        expectedActionHash: 'hash',
        requestId: 'missing',
      }),
    ).rejects.toMatchObject({ code: 'empty_approval_actor_id' });
    await expect(approvals.verify('missing', action())).rejects.toMatchObject({
      code: 'approval_not_found',
    });
    await expect(
      approvals.decide({
        actorId: 'operator-7',
        decision: 'approved',
        expectedActionHash: 'hash',
        requestId: 'missing',
      }),
    ).rejects.toMatchObject({ code: 'approval_not_found' });
  });

  it('stores defensive copies and rejects duplicate request IDs', async () => {
    const { approvals, store } = setup();
    const proposed = action({ customerId: 42, nested: { value: 'original' } });
    const pending = await request(approvals, proposed);
    const nested = proposed.arguments['nested'];
    if (nested !== null && typeof nested === 'object') {
      Reflect.set(nested, 'value', 'changed');
    }
    Reflect.set(pending.action.arguments, 'customerId', 99);

    expect((await store.get('approval-1'))?.action.arguments).toEqual({
      customerId: 42,
      nested: { value: 'original' },
    });
    await expect(request(approvals)).rejects.toMatchObject({ code: 'duplicate_approval_request' });
  });

  it('builds a tool action containing the complete run identity', () => {
    expect(
      toolApprovalAction('agent-1', 'run-1', {
        arguments: { path: '/report.csv' },
        id: 'call-1',
        name: 'document.upload',
      }),
    ).toEqual({
      arguments: { path: '/report.csv' },
      context: { agentId: 'agent-1', callId: 'call-1', runId: 'run-1' },
      kind: 'tool_call',
      target: 'document.upload',
    });
  });
});

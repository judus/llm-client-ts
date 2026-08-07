import { AiError } from './error.js';
import type { JsonObject, JsonValue } from './json.js';
import type { ToolCall } from './tool.js';

export type ApprovalActionKind =
  'custom' | 'external_write' | 'provider_file_upload' | 'sensitive_document_access' | 'tool_call';

/** Exact operation that an approval grants authority to perform. */
export interface ApprovalAction {
  readonly arguments: JsonObject;
  readonly context?: JsonObject;
  readonly kind: ApprovalActionKind;
  readonly target: string;
}

export interface ApprovalRequestInput {
  readonly action: ApprovalAction;
  readonly description: string;
  readonly expiresAt: string;
}

export interface ApprovalResolution {
  readonly actorId: string;
  readonly decidedAt: string;
  readonly decision: 'approved' | 'denied';
  readonly reason?: string;
}

export interface ApprovalRequest {
  readonly action: ApprovalAction;
  readonly actionHash: string;
  readonly createdAt: string;
  readonly description: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly resolution?: ApprovalResolution;
  readonly status: 'approved' | 'denied' | 'pending';
}

export interface DecideApproval {
  readonly actorId: string;
  readonly decidedAt?: string;
  readonly decision: 'approved' | 'denied';
  readonly expectedActionHash: string;
  readonly reason?: string;
  readonly requestId: string;
}

/** Fully timestamped decision command accepted by approval persistence. */
export interface RecordApprovalDecision {
  readonly actorId: string;
  readonly decidedAt: string;
  readonly decision: 'approved' | 'denied';
  readonly expectedActionHash: string;
  readonly reason?: string;
  readonly requestId: string;
}

export interface ApprovalStore {
  create(request: ApprovalRequest): Promise<void>;
  decide(command: RecordApprovalDecision): Promise<ApprovalRequest>;
  get(id: string): Promise<ApprovalRequest | undefined>;
}

export interface ApprovalCoordinatorOptions {
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly store?: ApprovalStore;
}

/** Creates, resolves, and verifies approvals bound to canonical action hashes. */
export class ApprovalCoordinator {
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #store: ApprovalStore;

  public constructor(options: ApprovalCoordinatorOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#store = options.store ?? new InMemoryApprovalStore();
  }

  public async request(input: ApprovalRequestInput): Promise<ApprovalRequest> {
    const createdAt = this.#clock().toISOString();
    assertTimestamp(input.expiresAt, 'expiresAt');
    assertApprovalAction(input.action);
    if (Date.parse(input.expiresAt) <= Date.parse(createdAt)) {
      throw new AiError('invalid_request', 'Approval expiry must be in the future.', {
        code: 'invalid_approval_expiry',
        details: { createdAt, expiresAt: input.expiresAt },
      });
    }
    if (input.description.trim().length === 0) {
      throw new AiError('invalid_request', 'Approval description cannot be empty.', {
        code: 'empty_approval_description',
      });
    }
    const request: ApprovalRequest = {
      action: clone(input.action),
      actionHash: await hashApprovalAction(input.action),
      createdAt,
      description: input.description,
      expiresAt: input.expiresAt,
      id: this.#idGenerator(),
      status: 'pending',
    };
    await this.#store.create(request);
    return clone(request);
  }

  public async decide(command: DecideApproval): Promise<ApprovalRequest> {
    const decidedAt = command.decidedAt ?? this.#clock().toISOString();
    assertTimestamp(decidedAt, 'decidedAt');
    if (command.actorId.trim().length === 0) {
      throw new AiError('invalid_request', 'Approval actor ID cannot be empty.', {
        code: 'empty_approval_actor_id',
      });
    }
    return this.#store.decide({
      actorId: command.actorId,
      decidedAt,
      decision: command.decision,
      expectedActionHash: command.expectedActionHash,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
      requestId: command.requestId,
    });
  }

  public async verify(requestId: string, action: ApprovalAction): Promise<ApprovalRequest> {
    const request = await this.#store.get(requestId);
    if (request === undefined) {
      throw new AiError('invalid_request', `Approval ${requestId} was not found.`, {
        code: 'approval_not_found',
        details: { requestId },
      });
    }
    const actualHash = await hashApprovalAction(action);
    if (actualHash !== request.actionHash) {
      throw new AiError(
        'authorization',
        'The proposed action does not match the approved action.',
        {
          code: 'approval_action_mismatch',
          details: { actualHash, expectedHash: request.actionHash, requestId },
        },
      );
    }
    if (Date.parse(this.#clock().toISOString()) >= Date.parse(request.expiresAt)) {
      throw new AiError('approval_expired', `Approval ${requestId} has expired.`, {
        code: 'approval_expired',
        details: { expiresAt: request.expiresAt, requestId },
      });
    }
    if (request.status === 'pending') {
      throw new AiError('approval_required', `Approval ${requestId} is still pending.`, {
        code: 'approval_pending',
        details: { requestId },
      });
    }
    if (request.status === 'denied') {
      throw new AiError('policy_denial', `Approval ${requestId} was denied.`, {
        code: 'approval_denied',
        details: {
          ...(request.resolution?.reason === undefined
            ? {}
            : { reason: request.resolution.reason }),
          requestId,
        },
      });
    }
    return request;
  }
}

/** In-memory approval persistence with single-decision concurrency semantics. */
export class InMemoryApprovalStore implements ApprovalStore {
  readonly #requests = new Map<string, ApprovalRequest>();

  public create(request: ApprovalRequest): Promise<void> {
    if (this.#requests.has(request.id)) {
      return Promise.reject(
        new AiError('persistence_conflict', `Approval ${request.id} already exists.`, {
          code: 'duplicate_approval_request',
          details: { requestId: request.id },
        }),
      );
    }
    this.#requests.set(request.id, clone(request));
    return Promise.resolve();
  }

  public get(id: string): Promise<ApprovalRequest | undefined> {
    const request = this.#requests.get(id);
    return Promise.resolve(request === undefined ? undefined : clone(request));
  }

  public decide(command: RecordApprovalDecision): Promise<ApprovalRequest> {
    const request = this.#requests.get(command.requestId);
    if (request === undefined) {
      return Promise.reject(
        new AiError('invalid_request', `Approval ${command.requestId} was not found.`, {
          code: 'approval_not_found',
          details: { requestId: command.requestId },
        }),
      );
    }
    if (request.actionHash !== command.expectedActionHash) {
      return Promise.reject(
        new AiError('authorization', 'Approval action hash does not match.', {
          code: 'approval_action_hash_mismatch',
          details: {
            actualHash: command.expectedActionHash,
            expectedHash: request.actionHash,
            requestId: command.requestId,
          },
        }),
      );
    }
    if (request.status !== 'pending') {
      return Promise.reject(
        new AiError('persistence_conflict', `Approval ${command.requestId} is already resolved.`, {
          code: 'approval_already_resolved',
          details: { requestId: command.requestId, status: request.status },
        }),
      );
    }
    if (Date.parse(command.decidedAt) < Date.parse(request.createdAt)) {
      return Promise.reject(
        new AiError('invalid_request', 'Approval decision predates its request.', {
          code: 'invalid_approval_decision_time',
          details: {
            createdAt: request.createdAt,
            decidedAt: command.decidedAt,
            requestId: command.requestId,
          },
        }),
      );
    }
    if (Date.parse(command.decidedAt) >= Date.parse(request.expiresAt)) {
      return Promise.reject(
        new AiError('approval_expired', `Approval ${command.requestId} has expired.`, {
          code: 'approval_expired',
          details: { expiresAt: request.expiresAt, requestId: command.requestId },
        }),
      );
    }
    const resolution: ApprovalResolution = {
      actorId: command.actorId,
      decidedAt: command.decidedAt,
      decision: command.decision,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    };
    const resolved: ApprovalRequest = {
      ...request,
      resolution,
      status: command.decision,
    };
    this.#requests.set(request.id, resolved);
    return Promise.resolve(clone(resolved));
  }
}

export function toolApprovalAction(agentId: string, runId: string, call: ToolCall): ApprovalAction {
  return {
    arguments: call.arguments,
    context: { agentId, callId: call.id, runId },
    kind: 'tool_call',
    target: call.name,
  };
}

export async function hashApprovalAction(action: ApprovalAction): Promise<string> {
  assertApprovalAction(action);
  const canonicalAction: JsonObject = {
    arguments: action.arguments,
    ...(action.context === undefined ? {} : { context: action.context }),
    kind: action.kind,
    target: action.target,
  };
  const bytes = new TextEncoder().encode(canonicalJson(canonicalAction));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value: JsonValue, ancestors = new Set<object>()): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new AiError('invalid_request', 'Approval actions must contain finite JSON numbers.', {
        code: 'invalid_approval_action_json',
      });
    }
    return JSON.stringify(value);
  }
  if (ancestors.has(value)) {
    throw new AiError('invalid_request', 'Approval actions cannot contain cyclic values.', {
      code: 'invalid_approval_action_json',
    });
  }
  ancestors.add(value);
  try {
    if (isJsonArray(value)) {
      return `[${Array.from(value, (_item, index) => {
        const item = Reflect.get(value, index) as JsonValue | undefined;
        if (item === undefined) {
          throw new AiError('invalid_request', 'Approval actions must contain only JSON values.', {
            code: 'invalid_approval_action_json',
            details: { index },
          });
        }
        return canonicalJson(item, ancestors);
      }).join(',')}]`;
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        const item = value[key];
        if (item === undefined) {
          throw new AiError('invalid_request', 'Approval actions must contain only JSON values.', {
            code: 'invalid_approval_action_json',
            details: { key },
          });
        }
        return `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function assertApprovalAction(action: ApprovalAction): void {
  if (action.target.trim().length === 0) {
    throw new AiError('invalid_request', 'Approval action target cannot be empty.', {
      code: 'empty_approval_action_target',
    });
  }
}

function assertTimestamp(value: string, field: string): void {
  const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
  if (!iso8601.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new AiError('invalid_request', `${field} must be an ISO-8601 timestamp.`, {
      code: 'invalid_approval_timestamp',
      details: { field, value },
    });
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

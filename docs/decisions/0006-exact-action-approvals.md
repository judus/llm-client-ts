# ADR 0006: Bind approvals to exact actions

- Status: accepted
- Date: 2026-08-07

## Decision

Approval is a core, application-interface-neutral contract. An approval request stores the complete proposed action: kind, target, arguments, and execution context. A canonical JSON representation of that action is hashed with SHA-256 when the request is created.

Every decision supplies the expected action hash and records one actor, decision timestamp, outcome, and optional reason. Stores must atomically allow only one decision. Verification recalculates the action hash and rejects changed actions, pending requests, denials, and approvals at or beyond their expiry.

The core provides an in-memory reference store. Applications inject durable implementations and their own terminal, desktop, web, or mobile approval surfaces. Approval does not change workflow budgets, retry policy, or the authority of any other action.

## Consequences

- Arguments and context cannot be edited between review and execution.
- Approval records are independently auditable without depending on a user-interface implementation.
- A resumed workflow can verify authority without rerunning completed stages.
- Durable stores need atomic create and compare-and-decide operations.
- Expired and denied requests cannot be reused.

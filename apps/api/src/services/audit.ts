import type { Tx } from '../db.ts';
import type { Prisma } from '../generated/prisma/client.ts';

/**
 * The audit log: who did what to which record, and when. Append-only. The database rejects
 * UPDATE and DELETE on `AuditEvent` (see the credit policy v2 migration), so a mistake is
 * corrected by writing another event, never by editing one.
 *
 * Write the event inside the same transaction as the change it describes, so the log and
 * the data cannot disagree.
 */
export const AUDIT_EVENTS = [
  'DECISION_MADE',
  'APPLICATION_REFERRED',
  'REVIEW_RECORDED',
  'DECISION_OVERRIDDEN',
  'LIMIT_FEE_SET',
  'PLAN_CREATED',
  'PLAN_STATUS_CHANGED',
  'PLAN_ADVANCE_FROZEN',
] as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[number];

export type AuditActor =
  | { type: 'system'; id?: string }
  | { type: 'job'; id: string }
  | { type: 'user'; id: string }
  | { type: 'reviewer'; id: string };

export interface AuditInput {
  actor: AuditActor;
  eventType: AuditEventType;
  subjectType: 'application' | 'rent_plan' | 'business';
  subjectId: string;
  payload?: Record<string, unknown>;
}

export function recordAudit(tx: Tx, input: AuditInput) {
  return tx.auditEvent.create({
    data: {
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      eventType: input.eventType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
    },
  });
}

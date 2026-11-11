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
  // Servicing (Phase R3). All are written on the rent plan they concern.
  /** A reviewer cleared a freeze. */
  'PLAN_ADVANCE_RELEASED',
  /** The plan moved between delinquency buckets. Payload: from, to, daysPastDue. */
  'DELINQUENCY_CHANGED',
  /** A landlord payout fell due and was not paid. Payload: payoutId, reason, releaseBy. */
  'PAYOUT_HELD',
  /** A held payout was paid after the hold cleared. */
  'PAYOUT_RELEASED',
  /** A payout was cancelled and its installments voided. */
  'PAYOUT_CANCELLED',
  /** A paid landlord payout came back from the landlord's bank. High severity. */
  'PAYOUT_RETURNED',
  /** A collected installment came back from the business's bank. */
  'PAYMENT_RETURNED',
  /** A return, or a rejection, coded as unauthorized. High severity. */
  'UNAUTHORIZED_RETURN',
  /** A bank link was disabled by a hard or unauthorized return. */
  'BANK_LINK_DISABLED',
  /** An installment has used every automatic attempt. Only a manual payment can clear it. */
  'COLLECTION_ATTEMPTS_EXHAUSTED',
  /** A scheduled debit was put off: the balance could not cover it, or there is no bank link. */
  'COLLECTION_SKIPPED',
  /** The plan's unpaid balance was written off and the plan closed. High severity. */
  'PLAN_CHARGED_OFF',
  /** A payment arrived on a written off installment. */
  'RECOVERY_RECEIVED',
  'BUSINESS_STATUS_CHANGED',
] as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[number];

export type AuditActor =
  | { type: 'system'; id?: string }
  | { type: 'job'; id: string }
  | { type: 'user'; id: string }
  | { type: 'reviewer'; id: string };

/**
 * How loudly an event should be heard. Stored in the payload as `severity`, and only when it
 * is not `info`. Monitoring (Phase R4) turns `high` events into alerts.
 */
export type AuditSeverity = 'info' | 'warning' | 'high';

export interface AuditInput {
  actor: AuditActor;
  eventType: AuditEventType;
  subjectType: 'application' | 'rent_plan' | 'business';
  subjectId: string;
  payload?: Record<string, unknown>;
  severity?: AuditSeverity;
  /**
   * When the event happened. Defaults to now. Jobs pass `effectiveAt(asOf)` so replayed
   * history is dated on the day it describes.
   */
  at?: Date;
}

export function recordAudit(tx: Tx, input: AuditInput) {
  return tx.auditEvent.create({
    data: {
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      eventType: input.eventType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      payload: {
        ...(input.payload ?? {}),
        ...(input.severity && input.severity !== 'info' ? { severity: input.severity } : {}),
      } as Prisma.InputJsonValue,
      ...(input.at ? { at: input.at } : {}),
    },
  });
}

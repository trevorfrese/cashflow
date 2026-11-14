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
  // Identity, screening, lease change control, monitoring, access (Phase R4).
  /** Business and owners went through the identity provider. Payload: status, reasons. */
  'IDENTITY_CHECKED',
  /** A party was screened against sanctions and watchlists. Payload: partyType, result. */
  'PARTY_SCREENED',
  /** A screening came back POSSIBLE_MATCH or MATCH. High severity. */
  'SCREENING_HIT',
  /** A reviewer cleared a screening hit. Payload: who and why. */
  'SCREENING_CLEARED',
  /** A landlord or payout change was requested on a lease with a running plan. */
  'LEASE_CHANGE_REQUESTED',
  /** The owner cancelled a pending change. */
  'LEASE_CHANGE_CANCELLED',
  /** A pending change took effect: the cooling-off ended, or a reviewer approved it. */
  'LEASE_CHANGE_APPLIED',
  /** A reviewer rejected a pending change. */
  'LEASE_CHANGE_REJECTED',
  /** Lease details changed with no running plan, or details that are not controlled. */
  'LEASE_UPDATED',
  /** The rent on a lease changed and the plan follows it from the next period. */
  'RENT_CHANGED',
  /** A rent increase needs a new decision before the plan fronts the higher rent. */
  'RENT_INCREASE_PENDING',
  /** A reviewer sent a returned landlord payout again, to corrected details. */
  'PAYOUT_RESENT',
  'ALERT_OPENED',
  'ALERT_ACKNOWLEDGED',
  'ALERT_RESOLVED',
  /** The circuit breaker on automatic approvals was tripped by a monitoring rule or an admin. */
  'CIRCUIT_BREAKER_TRIPPED',
  /** An admin reset the circuit breaker. */
  'CIRCUIT_BREAKER_RESET',
  /** An admin lowered a business's limit below its decision's from the console. */
  'LIMIT_CAP_SET',
  /** An admin took that cap off: the decision's limit applies again. */
  'LIMIT_CAP_REMOVED',
  /** Capital was added to the pool through the operator route. */
  'POOL_FUNDED',
  /** An admin ran the jobs by hand. */
  'JOBS_RUN_REQUESTED',
  /** Too many failed sign ins in a row: the account is locked for a while. */
  'LOGIN_LOCKED',
  // Data connections (data veracity phase). Written on the connection. Never a token, never
  // pulled data: counts, hashes, ids, scopes, and reasons only.
  /** A bank or platform connection was made. Payload: kind, method, provider, platform. */
  'CONNECTION_CONNECTED',
  /** What the owner consented to. Payload: scopes, expiry. */
  'CONSENT_GRANTED',
  /** A pull was stored as a snapshot. Payload: snapshot id, hash, counts, window, reason. */
  'DATA_PULLED',
  /** A pull failed and nothing was stored. Payload: reason. */
  'DATA_PULL_FAILED',
  /** An access token was refreshed before it expired. */
  'TOKEN_REFRESHED',
  /** A refresh was refused: the owner has to reconnect. */
  'TOKEN_REFRESH_FAILED',
  /** Disconnected: access revoked at the platform and tokens deleted. */
  'CONNECTION_REVOKED',
  /** A delegated seat invitation was issued. Payload: the service user. */
  'SEAT_INVITED',
  /** The seat was checked. Payload: active, reason. */
  'SEAT_VERIFIED',
  /** A decision's veracity assessment. Payload: outcome, finding codes, snapshot ids and hashes. */
  'VERACITY_ASSESSED',
  /** A pull found the platform paying out somewhere other than it did before. */
  'PAYOUT_DESTINATION_CHANGED',
  // Pass-through plans and graduation (Phase 6). Written on the rent plan.
  /** A declined business started a free pass-through plan on a lease. */
  'PASS_THROUGH_PLAN_CREATED',
  /** A month's rent was debited from the business. Payload: periodId, amount, settlesOn. */
  'PASS_THROUGH_COLLECTED',
  /** Nothing could be collected in time, or the debit came back before the landlord was paid. */
  'PASS_THROUGH_MISSED',
  /** A settled collection was paid to the landlord. */
  'PASS_THROUGH_LANDLORD_PAID',
  /** A settled collection's landlord payout is held. Payload: reason. */
  'PASS_THROUGH_HELD',
  /** A held collection was sent back to the business after the release window. */
  'PASS_THROUGH_REFUNDED',
  /** A collection came back after the landlord was paid. High severity. */
  'PASS_THROUGH_RETURNED_AFTER_PAYOUT',
  /** The refresh-eligibility job offered a financed plan. */
  'GRADUATION_OFFERED',
  /** The owner accepted a graduation offer. */
  'GRADUATION_ACCEPTED',
  /** The financed plan opened and the pass-through plan closed. */
  'GRADUATION_COMPLETED',
  /** An offer was not accepted in time. */
  'GRADUATION_EXPIRED',
  /** An offer was taken back before it took effect. Payload: reason. */
  'GRADUATION_WITHDRAWN',
  /** A landlord payment was refused because the month was already paid. High severity. */
  'DUPLICATE_PAYOUT_PREVENTED',
  // Reasons and adverse action notices (Phase 7). Written on the application.
  /** A notice was stored and delivered in the app. Payload: noticeId, kind, reason codes, deadline, late. */
  'ADVERSE_ACTION_NOTICE_SENT',
  /** The owner declined a counter offer. */
  'COUNTER_OFFER_DECLINED',
] as const;
export type AuditEventType = (typeof AUDIT_EVENTS)[number];

export type AuditActor =
  | { type: 'system'; id?: string }
  | { type: 'job'; id: string }
  | { type: 'user'; id: string }
  | { type: 'reviewer'; id: string }
  | { type: 'admin'; id: string };

/**
 * How loudly an event should be heard. Stored in the payload as `severity`, and only when it
 * is not `info`. Monitoring (Phase R4) turns `high` events into alerts.
 */
export type AuditSeverity = 'info' | 'warning' | 'high';

export const AUDIT_SUBJECT_TYPES = [
  'application',
  'rent_plan',
  'business',
  'lease',
  'screening',
  'alert',
  'circuit_breaker',
  'user',
  'system',
  'connection',
] as const;
export type AuditSubjectType = (typeof AUDIT_SUBJECT_TYPES)[number];

export interface AuditInput {
  actor: AuditActor;
  eventType: AuditEventType;
  subjectType: AuditSubjectType;
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

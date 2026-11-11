import type { AdminIdentity, CircuitBreakerStatus } from '@cashflow/shared';

import { clockNow } from '../dates.ts';
import type { Db, Tx } from '../db.ts';
import { unprocessable } from '../errors.ts';
import type { CircuitBreaker } from '../generated/prisma/client.ts';
import { recordAudit, type AuditActor } from './audit.ts';

/**
 * The circuit breaker on automatic approvals.
 *
 * One mechanism: while the breaker is tripped, an application the engine would approve is
 * referred to a reviewer instead (trigger `CIRCUIT_BREAKER`). Declines and requests for
 * information are unaffected. It is a persisted row, tripped by a monitoring rule whose
 * breach means the book is behaving outside what the credit policy was evaluated for, and
 * reset only by an admin.
 *
 * Why refer rather than stop new plans: the rules that trip it (first payment defaults,
 * delinquency, losses over expectation, pool over-commitment) say that recent automatic
 * decisions may be wrong, so the fix is a person on every new approval, which the review
 * queue already provides. It does not strand an owner mid onboarding with an error, and it
 * leaves good applicants a way through. Approvals made before the trip stay valid;
 * `createRentPlan` still applies the exposure and pool rules to them on the day.
 */
export const APPROVALS_BREAKER = 'new_approvals';

const EMPTY = (id: string): CircuitBreakerStatus => ({
  id,
  tripped: false,
  reason: null,
  trippedAt: null,
  trippedByRule: null,
  trippedAlertId: null,
  resetAt: null,
  resetBy: null,
  resetReason: null,
});

export function toBreakerStatus(row: CircuitBreaker | null, id = APPROVALS_BREAKER) {
  if (!row) return EMPTY(id);
  return {
    id: row.id,
    tripped: row.tripped,
    reason: row.reason,
    trippedAt: row.trippedAt?.toISOString() ?? null,
    trippedByRule: row.trippedByRule,
    trippedAlertId: row.trippedAlertId,
    resetAt: row.resetAt?.toISOString() ?? null,
    resetBy: row.resetBy,
    resetReason: row.resetReason,
  } satisfies CircuitBreakerStatus;
}

export async function breakerStatus(tx: Tx): Promise<CircuitBreakerStatus> {
  return toBreakerStatus(await tx.circuitBreaker.findUnique({ where: { id: APPROVALS_BREAKER } }));
}

export async function approvalsPaused(tx: Tx): Promise<boolean> {
  const row = await tx.circuitBreaker.findUnique({
    where: { id: APPROVALS_BREAKER },
    select: { tripped: true },
  });
  return row?.tripped ?? false;
}

/** Trip the breaker. Does nothing, and returns false, when it is already tripped. */
export async function tripBreaker(
  tx: Tx,
  args: { rule: string; reason: string; alertId: string | null; actor: AuditActor; at: Date },
): Promise<boolean> {
  const current = await tx.circuitBreaker.findUnique({ where: { id: APPROVALS_BREAKER } });
  if (current?.tripped) return false;
  const data = {
    tripped: true,
    reason: args.reason,
    trippedAt: args.at,
    trippedByRule: args.rule,
    trippedAlertId: args.alertId,
  };
  await tx.circuitBreaker.upsert({
    where: { id: APPROVALS_BREAKER },
    update: data,
    create: { id: APPROVALS_BREAKER, ...data },
  });
  await recordAudit(tx, {
    actor: args.actor,
    eventType: 'CIRCUIT_BREAKER_TRIPPED',
    subjectType: 'circuit_breaker',
    subjectId: APPROVALS_BREAKER,
    payload: { rule: args.rule, reason: args.reason, alertId: args.alertId },
    severity: 'high',
    at: args.at,
  });
  return true;
}

export async function resetBreaker(db: Db, args: { identity: AdminIdentity; reason: string }) {
  return db.$transaction(async (tx) => {
    const current = await tx.circuitBreaker.findUnique({ where: { id: APPROVALS_BREAKER } });
    if (!current?.tripped) {
      throw unprocessable('BREAKER_NOT_TRIPPED', 'The circuit breaker is not tripped');
    }
    const at = clockNow();
    const row = await tx.circuitBreaker.update({
      where: { id: APPROVALS_BREAKER },
      data: {
        tripped: false,
        resetAt: at,
        resetBy: args.identity.actor,
        resetReason: args.reason,
      },
    });
    await recordAudit(tx, {
      actor: { type: args.identity.role, id: args.identity.actor },
      eventType: 'CIRCUIT_BREAKER_RESET',
      subjectType: 'circuit_breaker',
      subjectId: APPROVALS_BREAKER,
      payload: {
        reason: args.reason,
        trippedByRule: current.trippedByRule,
        trippedAt: current.trippedAt?.toISOString() ?? null,
        trippedReason: current.reason,
      },
      at,
    });
    return toBreakerStatus(row);
  });
}

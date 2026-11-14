import type { AdminIdentity, CircuitBreakerStatus } from '@cashflow/shared';
import { principalReason } from '@cashflow/shared';

import { clockNow } from '../dates.ts';
import type { Db } from '../db.ts';
import { notFound, unprocessable } from '../errors.ts';
import { createFreezeNoticeTx } from '../services/adverse-action.ts';
import { recordAudit } from '../services/audit.ts';
import { breakerStatus, tripBreaker } from '../services/circuit-breaker.ts';

/**
 * Controls an admin uses from the operations console. Each one only makes the system
 * stricter, needs a typed reason, writes an audit event in the same transaction as the
 * change, and has an undo an admin can use:
 *
 *   pause approvals   `pauseApprovals`      undone by `resetBreaker` (circuit-breaker/reset)
 *   freeze a plan     `freezePlanAdvance`   undone by `releaseAdvanceFreeze` (release-freeze)
 *   lower a limit     `lowerBusinessLimit`  undone by `removeBusinessLimitCap` (limit-cap.ts)
 *
 * The routes are admin only (`routes/admin.ts`); the console hiding a button is not the
 * control.
 */

/** The rule name a hand trip records, so the breaker shows who tripped it and why. */
export const MANUAL_TRIP_RULE = 'manual';

/**
 * `RentPlan.advanceFrozenReason` for a freeze an admin set by hand. Releasing it needs an
 * admin too (`releaseAdvanceFreeze`).
 */
export const OPERATOR_FREEZE_REASON = 'OPERATOR_HOLD';

/**
 * Pause new automatic approvals by tripping the circuit breaker by hand. The breaker works
 * as it does when a rule trips it: applications the engine would approve go to a reviewer.
 * Declines, requests for information, and running plans are untouched.
 */
export async function pauseApprovals(
  db: Db,
  args: { identity: AdminIdentity; reason: string },
): Promise<CircuitBreakerStatus> {
  return db.$transaction(async (tx) => {
    const tripped = await tripBreaker(tx, {
      rule: MANUAL_TRIP_RULE,
      reason: args.reason,
      alertId: null,
      actor: { type: args.identity.role, id: args.identity.actor },
      at: clockNow(),
    });
    if (!tripped) {
      throw unprocessable(
        'BREAKER_ALREADY_TRIPPED',
        'Automatic approvals are already paused by the circuit breaker',
      );
    }
    return breakerStatus(tx);
  });
}

/**
 * Freeze a plan's next period by hand: the same freeze a failed periodic review sets. From
 * the next job run no new period is generated and a payout that falls due is held, then
 * cancelled once its release window passes. Installments for rent already paid to the
 * landlord are still collected. A plan that is already frozen, for any reason, is refused:
 * it is already as strict as this makes it.
 */
export async function freezePlanAdvance(
  db: Db,
  args: { planId: string; identity: AdminIdentity; reason: string },
) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "RentPlan" WHERE "id" = ${args.planId} FOR UPDATE`;
    const plan = await tx.rentPlan.findUnique({
      where: { id: args.planId },
      include: { application: true, business: { select: { legalName: true } } },
    });
    if (!plan) throw notFound('Rent plan');
    if (plan.status === 'CLOSED') throw unprocessable('PLAN_CLOSED', 'This plan is closed');
    if (plan.advanceFrozenAt !== null) {
      throw unprocessable('PLAN_ALREADY_FROZEN', 'This plan is already frozen', {
        frozenReason: plan.advanceFrozenReason,
      });
    }
    const at = clockNow();
    const updated = await tx.rentPlan.update({
      where: { id: plan.id },
      data: { advanceFrozenAt: at, advanceFrozenReason: OPERATOR_FREEZE_REASON },
    });
    const actor = { type: args.identity.role, id: args.identity.actor };
    const event = await recordAudit(tx, {
      actor,
      eventType: 'PLAN_ADVANCE_FROZEN',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        reason: OPERATOR_FREEZE_REASON,
        note: args.reason,
        businessId: plan.businessId,
        monthlyRentCents: plan.monthlyRentCents,
      },
      severity: 'warning',
      at,
    });
    // Stopping the advances on a running plan is an unfavorable change to existing credit:
    // the owner gets the notice a periodic review freeze sends. The admin's typed reason is
    // internal; the owner is told the plan is on hold for a review.
    await createFreezeNoticeTx(tx, {
      application: plan.application,
      businessName: plan.business.legalName,
      plan,
      decision: { id: event.id, decidedAt: at },
      principalReasons: [principalReason('PLAN_UNDER_REVIEW')],
      actor,
      byOperator: true,
      generatedBy: `${args.identity.role}:${args.identity.actor}`,
    });
    return updated;
  });
}

import type { AdminIdentity, BusinessLimitView } from '@cashflow/shared';
import { formatCents } from '@cashflow/shared';

import { clockNow } from '../dates.ts';
import type { Db, Tx } from '../db.ts';
import { notFound, unprocessable } from '../errors.ts';
import { recordAudit } from '../services/audit.ts';
import { CURRENT_DECISION } from '../services/decisions.ts';

/**
 * An admin's cap on a business's limit.
 *
 * Underwriting sets a monthly limit on each approved decision. An admin can put a lower
 * ceiling on the whole business from the operations console when something says the
 * business should get less than it was approved for (a phone call, a news item, a pattern a
 * rule does not catch). It only ever lowers: the limit in force is the smaller of the
 * decision's limit and the cap, so a cap can never give a business more than underwriting
 * did, and the console has no way to raise a limit. Raising goes through underwriting: a new
 * application or a reviewer's decision.
 *
 * What it governs: a new plan, a rent increase on a running plan, and a pending increase a
 * new approval would cover. What it does not: a running plan already above the cap keeps its
 * rent. The console shows those plans beside the cap, and an admin who wants one stopped
 * freezes its next period.
 *
 * The cap lives on the business row (`limitCapCents` and who, when, why), and every change
 * writes an audit event, so its history is the audit log.
 */

/** The decision's limit with any admin cap applied. Every limit check goes through this. */
export async function cappedLimitCents(
  tx: Tx,
  businessId: string,
  decisionLimitCents: number,
): Promise<number> {
  const business = await tx.business.findUnique({
    where: { id: businessId },
    select: { limitCapCents: true },
  });
  const cap = business?.limitCapCents ?? null;
  return cap === null ? decisionLimitCents : Math.min(decisionLimitCents, cap);
}

/** The largest limit among the business's current approved decisions, and whose it is. */
async function approvedLimit(tx: Tx, businessId: string) {
  const decision = await tx.underwritingDecision.findFirst({
    where: {
      ...CURRENT_DECISION,
      outcome: 'APPROVED',
      approvedMonthlyLimitCents: { not: null },
      application: { businessId },
    },
    orderBy: [{ approvedMonthlyLimitCents: 'desc' }, { decidedAt: 'desc' }],
    select: { applicationId: true, approvedMonthlyLimitCents: true },
  });
  return decision
    ? { applicationId: decision.applicationId, cents: decision.approvedMonthlyLimitCents! }
    : null;
}

export async function businessLimitView(tx: Tx, businessId: string): Promise<BusinessLimitView> {
  const business = await tx.business.findUnique({ where: { id: businessId } });
  if (!business) throw notFound('Business');
  const approved = await approvedLimit(tx, businessId);
  const cap = business.limitCapCents;
  const effective =
    approved === null ? cap : cap === null ? approved.cents : Math.min(approved.cents, cap);
  const above =
    effective === null
      ? []
      : await tx.rentPlan.findMany({
          where: {
            businessId,
            kind: 'FINANCED',
            status: { not: 'CLOSED' },
            monthlyRentCents: { gt: effective },
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true, monthlyRentCents: true },
        });
  return {
    businessId,
    decisionLimitCents: approved?.cents ?? null,
    applicationId: approved?.applicationId ?? null,
    capCents: cap,
    capSetAt: business.limitCapSetAt?.toISOString() ?? null,
    capSetBy: business.limitCapSetBy,
    capReason: business.limitCapReason,
    effectiveLimitCents: effective,
    plansAboveLimit: above,
  };
}

/**
 * Lower the limit in force to `limitCents`. Refused unless it is strictly below the limit in
 * force today, so a call can never raise one. Zero is allowed: no new rent at all.
 */
export async function lowerBusinessLimit(
  db: Db,
  args: { businessId: string; limitCents: number; reason: string; identity: AdminIdentity },
): Promise<BusinessLimitView> {
  return db.$transaction(async (tx) => {
    // Lock the business row so two lowers at once cannot both read the old limit.
    await tx.$queryRaw`SELECT "id" FROM "Business" WHERE "id" = ${args.businessId} FOR UPDATE`;
    const before = await businessLimitView(tx, args.businessId);
    if (before.effectiveLimitCents === null) {
      throw unprocessable(
        'NO_LIMIT_TO_LOWER',
        'This business has no approved limit to lower. Nothing can be fronted for it now',
      );
    }
    if (args.limitCents >= before.effectiveLimitCents) {
      throw unprocessable(
        'LIMIT_NOT_LOWER',
        `The limit in force is ${formatCents(before.effectiveLimitCents)}. The console can only lower it; raising a limit goes through underwriting`,
        { effectiveLimitCents: before.effectiveLimitCents },
      );
    }
    const at = clockNow();
    await tx.business.update({
      where: { id: args.businessId },
      data: {
        limitCapCents: args.limitCents,
        limitCapSetAt: at,
        limitCapSetBy: args.identity.actor,
        limitCapReason: args.reason,
      },
    });
    await recordAudit(tx, {
      actor: { type: args.identity.role, id: args.identity.actor },
      eventType: 'LIMIT_CAP_SET',
      subjectType: 'business',
      subjectId: args.businessId,
      payload: {
        reason: args.reason,
        capCents: args.limitCents,
        previousCapCents: before.capCents,
        decisionLimitCents: before.decisionLimitCents,
        previousEffectiveLimitCents: before.effectiveLimitCents,
      },
      severity: 'warning',
      at,
    });
    return businessLimitView(tx, args.businessId);
  });
}

/** Take the cap off: the decision's limit applies again. The undo for `lowerBusinessLimit`. */
export async function removeBusinessLimitCap(
  db: Db,
  args: { businessId: string; reason: string; identity: AdminIdentity },
): Promise<BusinessLimitView> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Business" WHERE "id" = ${args.businessId} FOR UPDATE`;
    const before = await businessLimitView(tx, args.businessId);
    if (before.capCents === null) {
      throw unprocessable('NO_LIMIT_CAP', 'This business has no cap on its limit');
    }
    const at = clockNow();
    await tx.business.update({
      where: { id: args.businessId },
      data: { limitCapCents: null, limitCapSetAt: null, limitCapSetBy: null, limitCapReason: null },
    });
    await recordAudit(tx, {
      actor: { type: args.identity.role, id: args.identity.actor },
      eventType: 'LIMIT_CAP_REMOVED',
      subjectType: 'business',
      subjectId: args.businessId,
      payload: {
        reason: args.reason,
        removedCapCents: before.capCents,
        capSetBy: before.capSetBy,
        capSetAt: before.capSetAt,
        decisionLimitCents: before.decisionLimitCents,
      },
      at,
    });
    return businessLimitView(tx, args.businessId);
  });
}

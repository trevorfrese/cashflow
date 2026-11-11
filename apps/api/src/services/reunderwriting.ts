import { addDays, daysBetween, type IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import type { EngineInput, EngineResult } from '../underwriting/engine.ts';
import { CURRENT_POLICY, type CreditPolicy } from '../underwriting/policy.ts';
import { recordAudit } from './audit.ts';
import { gatherExposureContext } from './portfolio-state.ts';
import { gatherBankData, UNDERWRITING_LOOKBACK_DAYS } from './underwriting.ts';

export type ReunderwriteOutcome =
  /** A periodic review already exists for this plan and month. Nothing was done. */
  | 'already_reviewed'
  /** Reviewed and still inside policy. */
  | 'ok'
  /** Reviewed and the next period is now frozen (or stays frozen). */
  | 'frozen'
  /**
   * Could not be scored: no bank link, a stale feed, or too little data. The plan is left
   * as it is. Without fresh data nothing is stored, so the next run tries again.
   */
  | 'unscored';

/**
 * Decline reasons that mean the business itself has deteriorated. A periodic review that
 * comes back declined for one of these freezes the next period. Declines for origination
 * rules (an exposure cap, a fee above the cap, rent not matching the account) say nothing
 * about a customer who is already repaying, so they do not.
 */
export const DETERIORATION_CODES: ReadonlySet<string> = new Set([
  'EXCESSIVE_OVERDRAFTS',
  'NEGATIVE_BALANCE_DAYS',
  'REVENUE_DECLINING',
  'DECLINE_WITH_THIN_BUFFER',
  'REVENUE_TOO_LOW',
  'RENT_EXCEEDS_REVENUE_SHARE',
  'NEGATIVE_FREE_CASH_FLOW',
  'INSUFFICIENT_CAPACITY',
  'SCORE_BELOW_MINIMUM',
  'UNVERIFIED_DEPOSITS',
]);

/**
 * A periodic review needs fresh data. When the newest transaction the bank returns is more
 * than this many days older than the review date, the feed is stale: a quiet week would
 * read as a collapse in revenue. The review is skipped and tried again on the next run.
 */
export const MAX_DATA_AGE_DAYS = 7;

/** Days between the newest transaction and the review date, or null without transactions. */
export function dataAgeDays(bankData: EngineInput['bankData'], asOf: IsoDate): number | null {
  if (!bankData || bankData.transactions.length === 0) return null;
  let latest = bankData.transactions[0]!.date;
  for (const t of bankData.transactions) if (t.date > latest) latest = t.date;
  return Math.max(0, daysBetween(latest, asOf));
}

/** Why a periodic review freezes the next period, or null when it does not. Pure. */
export function watchReason(result: EngineResult, policy: CreditPolicy): string | null {
  if (result.score === null) return null;
  if (result.outcome === 'DECLINED') {
    const reason = result.reasons.find((r) => DETERIORATION_CODES.has(r.code));
    if (reason) return reason.code;
  }
  if (result.score < policy.reunderwriting.watchScore) return 'SCORE_BELOW_WATCH';
  return null;
}

/**
 * Re-score one active plan as of `asOf` and store the result. A result below the watch
 * threshold, or a credit decline, freezes the plan: `advanceFrozenAt` is set, and from then
 * on no new period is generated and a payout that falls due is held. Rent already paid to the
 * landlord is still collected. Runs at most once per plan per
 * calendar month: the review is keyed by application and month, and the database enforces
 * that with a unique index, so a concurrent second run cannot double up either.
 */
export async function reunderwritePlan(
  ctx: AppContext,
  planId: string,
  asOf: IsoDate,
): Promise<ReunderwriteOutcome> {
  const { db, providers } = ctx;
  const period = asOf.slice(0, 7);
  const plan = await db.rentPlan.findUnique({
    where: { id: planId },
    include: {
      application: true,
      business: {
        include: {
          bankLinks: { where: { status: 'LINKED' }, orderBy: { createdAt: 'desc' }, take: 1 },
          commerceLinks: { where: { status: 'LINKED' }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });
  if (!plan || plan.status !== 'ACTIVE') return 'already_reviewed';
  const existing = await db.underwritingDecision.findUnique({
    where: {
      applicationId_reviewPeriod: { applicationId: plan.applicationId, reviewPeriod: period },
    },
  });
  if (existing) return 'already_reviewed';

  const bankLink = plan.business.bankLinks[0] ?? null;
  const commerceLink = plan.business.commerceLinks[0] ?? null;
  const bankData: EngineInput['bankData'] = bankLink
    ? await gatherBankData(providers, bankLink, asOf)
    : null;
  // No link, or a feed that has not caught up: nothing is stored, so the next run of the
  // job tries again, and the plan is left exactly as it is.
  const age = dataAgeDays(bankData, asOf);
  if (age === null || age > MAX_DATA_AGE_DAYS) {
    ctx.log.warn(
      { planId: plan.id, asOf, dataAgeDays: age },
      'periodic review skipped: bank data is stale',
    );
    return 'unscored';
  }
  const commerceData: EngineInput['commerceData'] = commerceLink
    ? {
        platform: commerceLink.platform,
        connectedSince: commerceLink.connectedSince,
        dailySales: await providers.commerce.getDailySales(commerceLink.providerItemId, {
          from: addDays(asOf, -(UNDERWRITING_LOOKBACK_DAYS - 1)),
          to: asOf,
        }),
      }
    : null;
  // The plan under review is left out of the exposure totals: the question is whether we
  // would carry this rent today, not whether we would add it on top of itself.
  const exposureContext = await gatherExposureContext(db, providers, {
    businessId: plan.businessId,
    industry: plan.business.industry,
    excludePlanId: plan.id,
  });
  const policy = CURRENT_POLICY;
  const result = await providers.underwriting.decide({
    statedMonthlyRevenueCents: plan.application.statedMonthlyRevenueCents,
    // Time in business moves on with the calendar. The stated figure is a floor.
    timeInBusinessMonths: plan.application.timeInBusinessMonths,
    requestedMonthlyRentCents: plan.monthlyRentCents,
    bankData,
    commerceData,
    // CashFlow now pays this rent, so the account no longer shows it the way it did at
    // application. The lease is known good: skip the rent anchoring checks.
    integrityContext: { leaseVerified: true },
    exposureContext,
    periodicReview: true,
  });

  const reason = watchReason(result, policy);
  const unscored = result.score === null;
  const wasFrozen = plan.advanceFrozenAt !== null;
  const freeze = reason !== null;

  return db.$transaction(async (tx) => {
    const decision = await tx.underwritingDecision.create({
      data: {
        applicationId: plan.applicationId,
        kind: 'PERIODIC_REVIEW',
        reviewPeriod: period,
        outcome: result.outcome,
        approvedMonthlyLimitCents: result.approvedMonthlyLimitCents,
        feeBps: result.feeBps,
        score: result.score,
        grade: result.grade,
        recommendedInstallmentsPerMonth: result.recommendedInstallmentsPerMonth,
        reasons: result.reasons as unknown as Prisma.InputJsonValue,
        cashFlow: (result.cashFlow ?? null) as unknown as Prisma.InputJsonValue,
        policyVersion: result.policyVersion,
        snapshot: {
          ...result.snapshot,
          periodicReview: { planId: plan.id, asOf, period, watchReason: reason },
        } as unknown as Prisma.InputJsonValue,
        provider: providers.underwriting.name,
        decidedAt: effectiveAt(asOf),
      },
    });
    const actor = { type: 'job' as const, id: 'reunderwrite' };
    await recordAudit(tx, {
      actor,
      eventType: 'DECISION_MADE',
      subjectType: 'application',
      subjectId: plan.applicationId,
      payload: {
        decisionId: decision.id,
        kind: 'PERIODIC_REVIEW',
        period,
        planId: plan.id,
        outcome: result.outcome,
        policyVersion: result.policyVersion,
        score: result.score,
        grade: result.grade,
        watchReason: reason,
      },
      at: effectiveAt(asOf),
    });
    if (freeze && !wasFrozen) {
      await tx.rentPlan.update({
        where: { id: plan.id },
        data: { advanceFrozenAt: effectiveAt(asOf), advanceFrozenReason: reason },
      });
      await recordAudit(tx, {
        actor,
        eventType: 'PLAN_ADVANCE_FROZEN',
        subjectType: 'rent_plan',
        subjectId: plan.id,
        payload: { decisionId: decision.id, period, reason, score: result.score },
        at: effectiveAt(asOf),
      });
      ctx.log.warn(
        { planId: plan.id, reason, score: result.score },
        'rent plan frozen by periodic review',
      );
    }
    if (unscored) return 'unscored';
    // A freeze is not lifted here. A later review that passes is stored like any other, and
    // releasing the plan is a reviewer's call (`releaseAdvanceFreeze`). While frozen, a
    // payout that falls due is HELD and then cancelled once its release window has passed,
    // so a period skipped by a freeze is never paid late.
    return freeze || wasFrozen ? 'frozen' : 'ok';
  });
}

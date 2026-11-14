import {
  daysBetween,
  principalReason,
  selectPrincipalReasons,
  type IsoDate,
  type PrincipalReason,
} from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt, monthsBetween } from '../dates.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { openAlert } from '../monitoring/service.ts';
import type { EngineInput, EngineResult } from '../underwriting/engine.ts';
import { CURRENT_POLICY, type CreditPolicy } from '../underwriting/policy.ts';
import { createFreezeNoticeTx } from './adverse-action.ts';
import { recordAudit } from './audit.ts';
import { gatherExposureContext } from './portfolio-state.ts';
import { gatherDecisionData } from './connections.ts';
import { recordVeracityAssessed } from './underwriting.ts';

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
]);

/**
 * Decline reasons that question the data itself, not the business's finances: deposits that
 * round trip, connected accounts held by someone else, and a bank history that was rewritten
 * between pulls. A periodic review that declines for one of these freezes the next period
 * like a deterioration, and also opens an alert, because a person has to look at it.
 */
export const TRUST_CODES: ReadonlySet<string> = new Set([
  'UNVERIFIED_DEPOSITS',
  'ACCOUNT_OWNERSHIP_NOT_CONFIRMED',
  'ACCOUNT_HISTORY_NOT_VERIFIED',
]);

/**
 * Veracity findings that say the bank or sales history changed between pulls for days that
 * were already final. On an application only `HISTORY_REWRITTEN` declines; the other two
 * refer. A running plan has no review queue to refer to, so at periodic review all three
 * freeze the next period and open an alert, and a reviewer decides whether to lift it.
 */
export const REWRITE_FINDINGS: ReadonlySet<string> = new Set([
  'HISTORY_REWRITTEN',
  'HISTORY_CHANGED',
  'SALES_HISTORY_CHANGED',
]);

/** The catalog reason the owner is told for each rewrite finding. */
const REWRITE_REASON: Readonly<Record<string, string>> = {
  HISTORY_REWRITTEN: 'ACCOUNT_HISTORY_NOT_VERIFIED',
  HISTORY_CHANGED: 'ACCOUNT_HISTORY_NOT_VERIFIED',
  SALES_HISTORY_CHANGED: 'SALES_HISTORY_NOT_VERIFIED',
};

/** A freeze reason that is about trust in the data: it opens an alert as well. */
export function isTrustReason(reason: string | null): boolean {
  return reason !== null && (TRUST_CODES.has(reason) || REWRITE_FINDINGS.has(reason));
}

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

/**
 * Why a periodic review freezes the next period, or null when it does not. Pure. Trust comes
 * first: a rewritten history freezes whatever the score says, and whether the engine declined
 * on it (bank history) or referred (sales history, or a change that is not all one way).
 */
export function watchReason(result: EngineResult, policy: CreditPolicy): string | null {
  if (result.outcome === 'DECLINED') {
    const trust = result.reasons.find((r) => TRUST_CODES.has(r.code));
    if (trust) return trust.code;
  }
  const rewrite = result.snapshot.veracity?.findings.find((f) => REWRITE_FINDINGS.has(f.code));
  if (rewrite) return rewrite.code;
  if (result.score === null) return null;
  if (result.outcome === 'DECLINED') {
    const reason = result.reasons.find((r) => DETERIORATION_CODES.has(r.code));
    if (reason) return reason.code;
  }
  if (result.score < policy.reunderwriting.watchScore) return 'SCORE_BELOW_WATCH';
  return null;
}

/**
 * What the owner is told on the notice for a freeze: the catalog reasons behind it, at most
 * four. A trust reason is stated as itself. A credit reason is stated the way a decline is,
 * with the factors that cost the most points in place of the score. Pure.
 */
export function freezePrincipalReasons(result: EngineResult, reason: string): PrincipalReason[] {
  const messages = new Map(result.reasons.map((r) => [r.code, r.message]));
  if (REWRITE_FINDINGS.has(reason)) return [principalReason(REWRITE_REASON[reason]!)];
  if (TRUST_CODES.has(reason)) return [principalReason(reason, messages.get(reason))];
  return selectPrincipalReasons({
    outcome: 'DECLINED',
    counterOffer: false,
    reasons: result.reasons,
    factors: result.snapshot.factors,
  });
}

/**
 * Time in business on the review date: what was stated at application, plus the months
 * since. The stated figure is a floor, and the business has kept trading since. Pure.
 */
export function timeInBusinessAt(
  application: { timeInBusinessMonths: number; submittedAt: Date | null; createdAt: Date },
  asOf: IsoDate,
): number {
  const statedOn = (application.submittedAt ?? application.createdAt)
    .toISOString()
    .slice(0, 10) as IsoDate;
  return application.timeInBusinessMonths + monthsBetween(statedOn, asOf);
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
  const timeInBusinessMonths = timeInBusinessAt(plan.application, asOf);
  // The same path as an application: snapshots, the freshness rule, and the veracity facts.
  const { bankData, commerceData, veracity } = bankLink
    ? await gatherDecisionData(ctx, {
        businessId: plan.businessId,
        bankLink,
        commerceLink,
        timeInBusinessMonths,
        asOf,
        reason: 'REUNDERWRITE',
        periodicReview: true,
      })
    : { bankData: null, commerceData: null, veracity: null };
  // No link, a pull that failed, or a feed that has not caught up: nothing is stored, so the
  // next run of the job tries again, and the plan is left exactly as it is.
  const age = dataAgeDays(bankData, asOf);
  if (age === null || age > MAX_DATA_AGE_DAYS) {
    ctx.log.warn(
      { planId: plan.id, asOf, dataAgeDays: age },
      'periodic review skipped: bank data is stale',
    );
    return 'unscored';
  }
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
    // Time in business moves on with the calendar from what was stated at application.
    timeInBusinessMonths,
    requestedMonthlyRentCents: plan.monthlyRentCents,
    bankData,
    commerceData,
    // CashFlow now pays this rent, so the account no longer shows it the way it did at
    // application. The lease is known good: skip the rent anchoring checks.
    integrityContext: { leaseVerified: true },
    exposureContext,
    periodicReview: true,
    veracity,
  });

  const reason = watchReason(result, policy);
  const trust = isTrustReason(reason);
  const unscored = result.score === null && !trust;
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
    await recordVeracityAssessed(tx, result, {
      actor,
      subjectType: 'application',
      subjectId: plan.applicationId,
      decisionId: decision.id,
      businessId: plan.businessId,
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
      // Stopping the advances on a running plan is an unfavorable change to existing credit:
      // the owner gets a notice with the reasons, stored with the freeze.
      await createFreezeNoticeTx(tx, {
        application: plan.application,
        businessName: plan.business.legalName,
        plan,
        decision,
        principalReasons: freezePrincipalReasons(result, reason!),
        actor,
      });
    }
    if (trust) {
      // A rewritten history or accounts that are not the business's own is a fraud question.
      // A person has to look, whether or not the plan was already frozen. One alert per plan
      // and month.
      await openAlert(
        tx,
        {
          type: 'fraud.periodic_review_trust_failure',
          category: 'FRAUD',
          severity:
            reason === 'HISTORY_REWRITTEN' || reason === 'ACCOUNT_HISTORY_NOT_VERIFIED'
              ? 'CRITICAL'
              : 'HIGH',
          subjectType: 'rent_plan',
          subjectId: plan.id,
          title: `Periodic review could not trust the data: ${plan.business.legalName}`,
          detail: {
            planId: plan.id,
            businessId: plan.businessId,
            decisionId: decision.id,
            period,
            reason,
            findings: result.snapshot.veracity?.findings.map((f) => f.code) ?? [],
            frozenNow: freeze && !wasFrozen,
          },
          dedupeKey: `periodic_review_trust:${plan.id}:${period}`,
        },
        effectiveAt(asOf),
        actor,
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

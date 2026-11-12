import {
  addDays,
  feeForRent,
  formatCents,
  nextRentDueDate,
  periodMonthOf,
  type IsoDate,
} from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt, monthsBetween } from '../dates.ts';
import type { Tx } from '../db.ts';
import { AppError, forbidden, notFound, unprocessable } from '../errors.ts';
import type { GraduationOffer, Prisma } from '../generated/prisma/client.ts';
import { CURRENT_POLICY } from '../underwriting/policy.ts';
import { recordAudit, type AuditActor } from './audit.ts';
import { approvalsPaused } from './circuit-breaker.ts';
import { gatherDecisionData } from './connections.ts';
import { supersedeCurrentDecision } from './decisions.ts';
import { gatherIdentityFacts } from './identity.ts';
import { paymentHistorySummary } from './payment-history.ts';
import { gatherExposureContext, gatherIntegrityContext } from './portfolio-state.ts';
import { createRentPlanTx } from './rent-plan.ts';
import { dataAgeDays, MAX_DATA_AGE_DAYS } from './reunderwriting.ts';
import { recordVeracityAssessed } from './underwriting.ts';

/**
 * Graduation: from a free pass-through plan to a financed one.
 *
 * Once a pass-through customer has `minOnTimeMonths` on time months in a row, the
 * refresh-eligibility job re-underwrites it, at most once a calendar month, on freshly pulled
 * data and its payment history, through the same engine and the same data path as an
 * application. The result is stored as an ELIGIBILITY_REVIEW decision beside the decline
 * (never the current decision). An approval for at least the lease rent becomes an offer.
 * A referral does not: nothing is sent to the review queue, so the payment history factor
 * never adds referrals, and the job looks again next month.
 *
 * The owner accepts the offer through the API. Nothing switches mid-cycle: the financed plan
 * opens only once no pass-through month is in flight (being collected, settling, or waiting
 * for its due date), and takes over from the next month. In one database transaction the
 * offer's terms become the application's current decision (kind GRADUATION), the pass-through
 * plan closes, its months not yet started are cancelled, and the financed plan opens through
 * the same checks as any plan (`createRentPlanTx`), so the exposure caps and the funding
 * rules apply. A refusal that can clear (the pool is full, a landlord change is waiting, an
 * account review) leaves the pass-through plan running and is tried again the next day.
 */

const JOB: AuditActor = { type: 'job', id: 'refresh-eligibility' };

export type EligibilityOutcome =
  /** Not a running pass-through plan, or the policy has no graduation. */
  | 'skipped'
  /** Fewer on time months in a row than the policy asks for. */
  | 'not_ready'
  /** An offer is already open. */
  | 'offer_open'
  /** Reviewed already this month. */
  | 'already_reviewed'
  /** No fresh bank data. Nothing stored; the next run tries again. */
  | 'unscored'
  /** Reviewed, and does not qualify yet. */
  | 'not_qualified'
  /** Reviewed, and offered a financed plan. */
  | 'offered';

/** Re-underwrite one pass-through plan if it is due, and make an offer if it qualifies. */
export async function reviewEligibility(
  ctx: AppContext,
  planId: string,
  asOf: IsoDate,
): Promise<EligibilityOutcome> {
  const { db, providers } = ctx;
  const policy = CURRENT_POLICY;
  const rules = policy.graduation;
  if (!rules) return 'skipped';
  const plan = await db.rentPlan.findUnique({
    where: { id: planId },
    include: {
      application: true,
      lease: true,
      business: {
        include: {
          bankLinks: { where: { status: 'LINKED' }, orderBy: { createdAt: 'desc' }, take: 1 },
          commerceLinks: { where: { status: 'LINKED' }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
      },
    },
  });
  if (!plan || plan.kind !== 'PASS_THROUGH' || plan.status !== 'ACTIVE') return 'skipped';
  if (plan.advanceFrozenAt !== null) return 'skipped';
  const open = await db.graduationOffer.findFirst({
    where: { passThroughPlanId: plan.id, status: { in: ['OFFERED', 'ACCEPTED'] } },
  });
  if (open) return 'offer_open';
  // Months completed before today. A month paid later today, by the payout job that runs
  // after this one, counts from tomorrow, so a second run of the same day sees the same
  // history as the first.
  const history = await paymentHistorySummary(db, plan.businessId, addDays(asOf, -1), policy);
  if (history.currentOnTimeStreak < rules.minOnTimeMonths) return 'not_ready';
  const period = asOf.slice(0, 7);
  const existing = await db.underwritingDecision.findUnique({
    where: {
      applicationId_reviewPeriod: { applicationId: plan.applicationId, reviewPeriod: period },
    },
  });
  if (existing) return 'already_reviewed';

  const bankLink = plan.business.bankLinks[0] ?? null;
  const commerceLink = plan.business.commerceLinks[0] ?? null;
  // Time in business moves on with the calendar from what was stated at application.
  const decidedOn = (plan.application.submittedAt ?? plan.application.createdAt)
    .toISOString()
    .slice(0, 10);
  const timeInBusinessMonths =
    plan.application.timeInBusinessMonths + monthsBetween(decidedOn, asOf);
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
  const age = dataAgeDays(bankData, asOf);
  if (age === null || age > MAX_DATA_AGE_DAYS) return 'unscored';

  const [integrityBase, identity, exposureContext, paused] = await Promise.all([
    gatherIntegrityContext(db, plan.business, { bankLink, lease: plan.lease }),
    gatherIdentityFacts(db, plan.businessId),
    gatherExposureContext(db, providers, {
      businessId: plan.businessId,
      industry: plan.business.industry,
    }),
    approvalsPaused(db),
  ]);
  const result = await providers.underwriting.decide({
    statedMonthlyRevenueCents: plan.application.statedMonthlyRevenueCents,
    timeInBusinessMonths,
    requestedMonthlyRentCents: plan.monthlyRentCents,
    bankData,
    commerceData,
    // CashFlow has paid this landlord from the business's own money for months: the lease is
    // known. Every other integrity check runs as on an application.
    integrityContext: { ...integrityBase, identity, leaseVerified: true },
    exposureContext,
    controls: { approvalsPaused: paused },
    // The stated revenue is months old: score what the bank shows now.
    periodicReview: true,
    veracity,
    paymentHistory: history,
  });
  const limit = result.approvedMonthlyLimitCents ?? 0;
  const qualifies = result.outcome === 'APPROVED' && limit >= plan.monthlyRentCents;
  const at = effectiveAt(asOf);

  return db.$transaction(async (tx) => {
    const decision = await tx.underwritingDecision.create({
      data: {
        applicationId: plan.applicationId,
        kind: 'ELIGIBILITY_REVIEW',
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
          eligibilityReview: {
            planId: plan.id,
            asOf,
            period,
            onTimeStreak: history.currentOnTimeStreak,
            offered: qualifies,
          },
        } as unknown as Prisma.InputJsonValue,
        provider: providers.underwriting.name,
        decidedAt: at,
      },
    });
    await recordAudit(tx, {
      actor: JOB,
      eventType: 'DECISION_MADE',
      subjectType: 'application',
      subjectId: plan.applicationId,
      payload: {
        decisionId: decision.id,
        kind: 'ELIGIBILITY_REVIEW',
        period,
        planId: plan.id,
        outcome: result.outcome,
        policyVersion: result.policyVersion,
        score: result.score,
        grade: result.grade,
        paymentHistoryPoints: result.snapshot.paymentHistory?.factor.points ?? 0,
      },
      at,
    });
    await recordVeracityAssessed(tx, result, {
      actor: JOB,
      subjectType: 'application',
      subjectId: plan.applicationId,
      decisionId: decision.id,
      businessId: plan.businessId,
      at,
    });
    if (!qualifies) return 'not_qualified';
    const offer = await tx.graduationOffer.create({
      data: {
        businessId: plan.businessId,
        passThroughPlanId: plan.id,
        applicationId: plan.applicationId,
        decisionId: decision.id,
        approvedMonthlyLimitCents: limit,
        feeBps: result.feeBps ?? 0,
        installmentsPerMonth: result.recommendedInstallmentsPerMonth ?? 2,
        score: result.score ?? 0,
        grade: result.grade ?? 'F',
        onTimeMonths: history.currentOnTimeStreak,
        offeredOn: asOf,
        expiresOn: addDays(asOf, rules.offerValidDays),
      },
    });
    await recordAudit(tx, {
      actor: JOB,
      eventType: 'GRADUATION_OFFERED',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        offerId: offer.id,
        decisionId: decision.id,
        approvedMonthlyLimitCents: limit,
        feeBps: offer.feeBps,
        score: offer.score,
        grade: offer.grade,
        onTimeMonths: offer.onTimeMonths,
        expiresOn: offer.expiresOn,
      },
      at,
    });
    return 'offered';
  });
}

/** Offers past their date that were never accepted. */
export async function expireGraduationOffers(ctx: AppContext, asOf: IsoDate): Promise<number> {
  const stale = await ctx.db.graduationOffer.findMany({
    where: { status: 'OFFERED', expiresOn: { lt: asOf } },
  });
  for (const offer of stale) {
    await ctx.db.$transaction(async (tx) => {
      const updated = await tx.graduationOffer.updateMany({
        where: { id: offer.id, status: 'OFFERED' },
        data: { status: 'EXPIRED' },
      });
      if (updated.count === 0) return;
      await recordAudit(tx, {
        actor: JOB,
        eventType: 'GRADUATION_EXPIRED',
        subjectType: 'rent_plan',
        subjectId: offer.passThroughPlanId,
        payload: { offerId: offer.id, expiresOn: offer.expiresOn },
        at: effectiveAt(asOf),
      });
    });
  }
  return stale.length;
}

/** The owner accepts. The financed plan opens now if no month is in flight, else later. */
export async function acceptGraduationOffer(
  ctx: AppContext,
  args: { offerId: string; userId: string; installmentsPerMonth?: number; asOf: IsoDate },
): Promise<{ offer: GraduationOffer; completed: boolean }> {
  await ctx.db.$transaction(async (tx) => {
    const offer = await tx.graduationOffer.findUnique({
      where: { id: args.offerId },
      include: { passThroughPlan: { include: { business: true } } },
    });
    if (!offer) throw notFound('Offer');
    if (offer.passThroughPlan.business.ownerUserId !== args.userId) throw forbidden();
    if (offer.status !== 'OFFERED') {
      throw unprocessable('OFFER_NOT_OPEN', 'This offer is no longer open');
    }
    if (offer.expiresOn < args.asOf) {
      throw unprocessable('OFFER_EXPIRED', 'This offer has expired');
    }
    if (offer.passThroughPlan.status !== 'ACTIVE') {
      throw unprocessable('PLAN_NOT_ACTIVE', 'The pass-through plan is not active');
    }
    await tx.graduationOffer.update({
      where: { id: offer.id },
      data: {
        status: 'ACCEPTED',
        acceptedAt: effectiveAt(args.asOf),
        acceptedOn: args.asOf,
        ...(args.installmentsPerMonth ? { installmentsPerMonth: args.installmentsPerMonth } : {}),
      },
    });
    await recordAudit(tx, {
      actor: { type: 'user', id: args.userId },
      eventType: 'GRADUATION_ACCEPTED',
      subjectType: 'rent_plan',
      subjectId: offer.passThroughPlanId,
      payload: {
        offerId: offer.id,
        approvedMonthlyLimitCents: offer.approvedMonthlyLimitCents,
        feeBps: offer.feeBps,
        installmentsPerMonth: args.installmentsPerMonth ?? offer.installmentsPerMonth,
        asOf: args.asOf,
      },
      at: effectiveAt(args.asOf),
    });
  });
  const outcome = await completeGraduation(ctx, args.offerId, args.asOf);
  const offer = await ctx.db.graduationOffer.findUniqueOrThrow({ where: { id: args.offerId } });
  return { offer, completed: outcome === 'completed' };
}

export type CompletionOutcome = 'completed' | 'waiting' | 'withdrawn' | 'skipped';

/** Refusals from `createRentPlanTx` that can clear on their own: try again tomorrow. */
const TRANSIENT_REFUSALS = new Set([
  'FUNDING_UNAVAILABLE',
  'LEASE_CHANGE_PENDING',
  'ACCOUNT_UNDER_REVIEW',
  'EXPOSURE_CAP_EXCEEDED',
]);

/**
 * Open the financed plan for an accepted offer, if no pass-through month is in flight.
 * Idempotent: an offer that is not ACCEPTED is skipped.
 */
export async function completeGraduation(
  ctx: AppContext,
  offerId: string,
  asOf: IsoDate,
): Promise<CompletionOutcome> {
  try {
    return await ctx.db.$transaction((tx) => completeGraduationTx(ctx, tx, offerId, asOf));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    if (TRANSIENT_REFUSALS.has(err.code)) {
      ctx.log.info(
        { offerId, code: err.code },
        'graduation waiting: the financed plan cannot open yet',
      );
      return 'waiting';
    }
    await ctx.db.$transaction(async (tx) => {
      const offer = await tx.graduationOffer.update({
        where: { id: offerId },
        data: { status: 'WITHDRAWN', withdrawnReason: err.code },
      });
      await recordAudit(tx, {
        actor: JOB,
        eventType: 'GRADUATION_WITHDRAWN',
        subjectType: 'rent_plan',
        subjectId: offer.passThroughPlanId,
        payload: { offerId, reason: err.code, message: err.message },
        severity: 'warning',
        at: effectiveAt(asOf),
      });
    });
    return 'withdrawn';
  }
}

async function completeGraduationTx(
  ctx: AppContext,
  tx: Tx,
  offerId: string,
  asOf: IsoDate,
): Promise<CompletionOutcome> {
  await tx.$queryRaw`SELECT "id" FROM "GraduationOffer" WHERE "id" = ${offerId} FOR UPDATE`;
  const offer = await tx.graduationOffer.findUnique({
    where: { id: offerId },
    include: { passThroughPlan: { include: { business: true, lease: true } } },
  });
  if (!offer || offer.status !== 'ACCEPTED') return 'skipped';
  const plan = offer.passThroughPlan;
  // Never mid-cycle: a month being collected, settling, or waiting for its due date runs to
  // the end on the pass-through plan. So does a month whose collection window has opened.
  const inFlight = await tx.passThroughPeriod.findFirst({
    where: {
      rentPlanId: plan.id,
      OR: [
        { status: { in: ['COLLECTING', 'SETTLED'] } },
        { status: 'SCHEDULED', collectOn: { lte: asOf } },
      ],
    },
  });
  if (inFlight) return 'waiting';

  const eligibility = await tx.underwritingDecision.findUniqueOrThrow({
    where: { id: offer.decisionId },
  });
  const at = effectiveAt(asOf);
  // The offer's terms become the application's decision.
  const previousDecisionId = await supersedeCurrentDecision(tx, offer.applicationId, at);
  const decision = await tx.underwritingDecision.create({
    data: {
      applicationId: offer.applicationId,
      kind: 'GRADUATION',
      outcome: 'APPROVED',
      approvedMonthlyLimitCents: offer.approvedMonthlyLimitCents,
      feeBps: offer.feeBps,
      score: offer.score,
      grade: offer.grade,
      recommendedInstallmentsPerMonth: offer.installmentsPerMonth,
      reasons: eligibility.reasons as Prisma.InputJsonValue,
      cashFlow: (eligibility.cashFlow ?? undefined) as Prisma.InputJsonValue | undefined,
      policyVersion: eligibility.policyVersion,
      snapshot: {
        ...((eligibility.snapshot as Record<string, unknown> | null) ?? {}),
        graduation: { offerId: offer.id, eligibilityDecisionId: eligibility.id, asOf },
      } as Prisma.InputJsonValue,
      provider: eligibility.provider,
      decidedAt: at,
    },
  });
  await tx.underwritingApplication.update({
    where: { id: offer.applicationId },
    data: { status: 'APPROVED' },
  });
  await tx.business.update({ where: { id: plan.businessId }, data: { status: 'ACTIVE' } });
  await recordAudit(tx, {
    actor: JOB,
    eventType: 'DECISION_MADE',
    subjectType: 'application',
    subjectId: offer.applicationId,
    payload: {
      decisionId: decision.id,
      previousDecisionId,
      kind: 'GRADUATION',
      outcome: 'APPROVED',
      offerId: offer.id,
      eligibilityDecisionId: eligibility.id,
    },
    at,
  });
  await recordAudit(tx, {
    actor: JOB,
    eventType: 'LIMIT_FEE_SET',
    subjectType: 'application',
    subjectId: offer.applicationId,
    payload: {
      decisionId: decision.id,
      approvedMonthlyLimitCents: offer.approvedMonthlyLimitCents,
      feeBps: offer.feeBps,
      source: 'graduation',
    },
    at,
  });

  // The pass-through plan ends with its last completed month.
  const cancelled = await tx.passThroughPeriod.updateMany({
    where: { rentPlanId: plan.id, status: 'SCHEDULED' },
    data: { status: 'CANCELLED', cancelledReason: 'GRADUATED' },
  });
  await tx.rentPlan.update({
    where: { id: plan.id },
    data: { status: 'CLOSED', closedAt: at, closedReason: 'GRADUATED' },
  });
  await recordAudit(tx, {
    actor: JOB,
    eventType: 'PLAN_STATUS_CHANGED',
    subjectType: 'rent_plan',
    subjectId: plan.id,
    payload: { from: plan.status, to: 'CLOSED', reason: 'GRADUATED', offerId: offer.id },
    at,
  });

  const financed = await createRentPlanTx(tx, ctx.providers, {
    userId: plan.business.ownerUserId,
    leaseId: plan.leaseId,
    applicationId: offer.applicationId,
    installmentsPerMonth: offer.installmentsPerMonth,
    asOf,
  });
  const firstDue = nextRentDueDate(financed.dueDayOfMonth, asOf);
  await tx.graduationOffer.update({
    where: { id: offer.id },
    data: {
      status: 'COMPLETED',
      completedAt: at,
      financedPlanId: financed.id,
      effectivePeriod: periodMonthOf(firstDue),
    },
  });
  await recordAudit(tx, {
    actor: JOB,
    eventType: 'GRADUATION_COMPLETED',
    subjectType: 'rent_plan',
    subjectId: plan.id,
    payload: {
      offerId: offer.id,
      financedPlanId: financed.id,
      effectivePeriod: periodMonthOf(firstDue),
      passThroughMonthsCancelled: cancelled.count,
      feeCentsPerMonth: feeForRent(financed.monthlyRentCents, financed.feeBps),
    },
    at,
  });
  return 'completed';
}

/** Complete every accepted offer that can be completed today. */
export async function completeAcceptedOffers(ctx: AppContext, asOf: IsoDate) {
  const accepted = await ctx.db.graduationOffer.findMany({
    where: { status: 'ACCEPTED' },
    select: { id: true },
  });
  const counts = { accepted: accepted.length, completed: 0, waiting: 0, withdrawn: 0 };
  for (const { id } of accepted) {
    const outcome = await completeGraduation(ctx, id, asOf);
    if (outcome === 'completed') counts.completed += 1;
    else if (outcome === 'waiting') counts.waiting += 1;
    else if (outcome === 'withdrawn') counts.withdrawn += 1;
  }
  return counts;
}

/** The offer as the owner sees it, with the fee in dollars at the lease rent. */
export function graduationMessage(
  offer: Pick<GraduationOffer, 'status' | 'feeBps' | 'expiresOn' | 'effectivePeriod'>,
  monthlyRentCents: number,
): string {
  const fee = feeForRent(monthlyRentCents, offer.feeBps);
  switch (offer.status) {
    case 'OFFERED':
      return `Your on-time months qualify you to split your rent. We would pay your landlord in full each month and you repay in installments, for a fee of ${formatCents(fee)} a month. It starts with your next rent month.`;
    case 'ACCEPTED':
      return 'Accepted. Your split plan starts once this month on the free plan is done.';
    case 'COMPLETED':
      return `Your split plan started${offer.effectivePeriod ? ` with ${offer.effectivePeriod}` : ''}.`;
    case 'EXPIRED':
      return 'This offer expired. We will look again after more on time months.';
    case 'WITHDRAWN':
      return 'This offer is no longer available. We will look again after more on time months.';
  }
}

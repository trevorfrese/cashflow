import {
  addDays,
  followingDueDate,
  formatCents,
  nextRentDueDate,
  periodMonthOf,
  type IsoDate,
  type PassThroughOffer,
} from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import type { Tx } from '../db.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { PassThroughPeriod, RentPlan } from '../generated/prisma/client.ts';
import { ACCOUNTS, ensureReceivableAccount, receivableCode } from '../ledger/accounts.ts';
import { postTransaction, reverseTransaction } from '../ledger/service.ts';
import type { PaymentReturn } from '../providers/payments/index.ts';
import {
  ACTIVE_PASS_THROUGH_POLICY,
  collectionAction,
  passThroughBalanceCovers,
  passThroughPayoutAction,
  passThroughSchedule,
  settlesOn,
} from '../servicing/pass-through.ts';
import { landlordIsApplicant } from '../underwriting/integrity.ts';
import { passThroughEligibility, snapshotKnockouts } from '../underwriting/pass-through.ts';
import { CURRENT_POLICY } from '../underwriting/policy.ts';
import { recordAudit, type AuditActor } from './audit.ts';
import { currentDecision } from './decisions.ts';
import {
  claimDisbursement,
  confirmDisbursement,
  isUniqueViolation,
  markDisbursementReturned,
  releaseDisbursement,
} from './disbursements.ts';
import { openHitsForPlan } from './identity.ts';
import type { ReturnOutcome } from './returns.ts';

/**
 * Pass-through rent plans.
 *
 * A business declined for credit capacity can have CashFlow pay its landlord anyway, for
 * free, as long as the money is the business's own and has arrived first:
 *
 *   1. generate     A month is created 30 days ahead, like a financed period.
 *   2. collect      From `collectOn` (5 business days before the due date) the whole rent is
 *                   debited, after a balance check. Posted DR pass_through_cash /
 *                   CR landlord_payable. A debit the balance cannot cover is put off a day,
 *                   until `lastCollectOn`; after that, or after the last attempt, the month
 *                   is MISSED.
 *   3. settle       The debit is SETTLED once it is past the return window the policy
 *                   models (3 business days). A return that arrives before then makes the
 *                   month MISSED, with the reversing posting.
 *   4. pay          On the due date a settled month is paid to the landlord: DR
 *                   landlord_payable / CR pass_through_cash, after a disbursement claim, so a
 *                   month is never paid twice. A landlord change in its cooling-off period or a
 *                   frozen plan holds it; past the release window the money goes back to the
 *                   business (REFUNDED).
 *
 * Nothing here reads or writes the capital pool, the exposure caps, or fee revenue. The one
 * exception is a collection that comes back after the landlord was paid (an unauthorized
 * return weeks later): then CashFlow's own money has covered the rent, the pool makes the
 * pass-through account whole, and the business owes the amount on its receivable account.
 *
 * A missed month is not paid by CashFlow. The owner is told plainly to pay the landlord
 * directly, and the month is recorded in the payment history. There is no fee and no late fee.
 */

const POLICY = ACTIVE_PASS_THROUGH_POLICY;

/** How far ahead months are generated, the same as financed periods. */
export const PASS_THROUGH_HORIZON_DAYS = 30;

const usd = (cents: number) => formatCents(cents, { showCents: false });

export const collectKey = (periodId: string, attempt: number) =>
  `pass_through:${periodId}:collect:${attempt}`;
export const payoutKeyFor = (periodId: string) => `pass_through:${periodId}:payout`;

/** What the owner is told about a month, in plain words. */
export function periodMessage(
  p: Pick<
    PassThroughPeriod,
    | 'status'
    | 'amountCents'
    | 'dueDate'
    | 'collectOn'
    | 'lastCollectOn'
    | 'paidOn'
    | 'heldReason'
    | 'settlesOn'
  >,
  landlordName: string,
): string {
  const amount = usd(p.amountCents);
  switch (p.status) {
    case 'SCHEDULED':
      return `We will collect ${amount} from your bank account on ${p.collectOn} and pay ${landlordName} on ${p.dueDate}. Keep that amount in the account by then.`;
    case 'COLLECTING':
      return `We collected ${amount}. Once it clears on ${p.settlesOn ?? p.dueDate}, we pay ${landlordName} on ${p.dueDate}.`;
    case 'SETTLED':
      return p.heldReason
        ? `We have your ${amount}, but the payment to ${landlordName} is on hold while your landlord's details are confirmed. If it cannot go out within a few days, we send the money back to you.`
        : `Your ${amount} has cleared. We pay ${landlordName} on ${p.dueDate}.`;
    case 'PAID':
      return `${landlordName} was paid ${amount} on ${p.paidOn ?? p.dueDate}.`;
    case 'MISSED':
      return `We could not collect this month's rent in time, so we did not pay ${landlordName}. Please pay ${landlordName} ${amount} directly by ${p.dueDate}. There is no fee.`;
    case 'REFUNDED':
      return `We could not pay ${landlordName} this month, so we sent your ${amount} back. Please pay ${landlordName} directly.`;
    case 'RETURNED_AFTER_PAYOUT':
      return `We paid ${landlordName} ${amount}, but your bank later sent the payment back. You owe us ${amount}. Contact support and we will help.`;
    case 'CANCELLED':
      return `This month was not collected. Please pay ${landlordName} directly.`;
  }
}

/** The pass-through offer on an application, for the owner. */
export async function passThroughOffer(tx: Tx, applicationId: string): Promise<PassThroughOffer> {
  const application = await tx.underwritingApplication.findUnique({
    where: { id: applicationId },
  });
  if (!application) throw notFound('Application');
  const decision = await currentDecision(tx, applicationId);
  const eligibility = decision
    ? passThroughEligibility({
        outcome: decision.outcome,
        kind: decision.kind,
        reasons:
          (decision.reasons as Array<{ code: string; impact: 'POSITIVE' | 'NEGATIVE' | 'INFO' }>) ??
          [],
        knockouts: snapshotKnockouts(decision.snapshot),
      })
    : { eligible: false, reason: 'NOT_DECLINED' as const, capacityCodes: [] };
  const existing = await tx.rentPlan.findFirst({
    where: { applicationId, kind: 'PASS_THROUGH', status: { not: 'CLOSED' } },
    select: { id: true },
  });
  const months = CURRENT_POLICY.graduation?.minOnTimeMonths ?? 3;
  return {
    applicationId,
    eligible: eligibility.eligible,
    ineligibleReason: eligibility.reason,
    monthlyRentCents: application.requestedMonthlyRentCents,
    feeCents: 0,
    collectionLeadBusinessDays: POLICY.collectionLeadBusinessDays,
    settlementBusinessDays: POLICY.settlementBusinessDays,
    monthsToReview: months,
    headline: eligibility.eligible
      ? 'We can still pay your landlord on time, for free'
      : 'A free pass-through plan is not available for this application',
    explanation: eligibility.eligible
      ? `We collect your rent from your bank account ${POLICY.collectionLeadBusinessDays} business days before it is due, and pay your landlord on the due date once the money has cleared. There is no fee and no late fee. If we cannot collect in time, we tell you and you pay your landlord directly that month. After ${months} months in a row on time, we look at your application again and may offer to split your rent.`
      : 'Contact support if you have questions about your application.',
    existingPlanId: existing?.id ?? null,
  };
}

export interface StartPassThroughArgs {
  userId: string;
  applicationId: string;
  leaseId: string;
  asOf: IsoDate;
}

/**
 * Open a pass-through plan on a lease for a business whose application was declined for
 * credit capacity. All checks and writes in one database transaction. No limit, no fee, no
 * capital or exposure check: CashFlow never advances anything on this plan.
 */
export async function startPassThroughPlan(ctx: AppContext, args: StartPassThroughArgs) {
  return ctx.db.$transaction(async (tx) => {
    const lease = await tx.lease.findUnique({
      where: { id: args.leaseId },
      include: { business: { include: { bankLinks: { where: { status: 'LINKED' } } } } },
    });
    if (!lease) throw notFound('Lease');
    if (lease.business.ownerUserId !== args.userId) throw forbidden();
    if (lease.status !== 'ACTIVE') throw unprocessable('LEASE_NOT_ACTIVE', 'Lease is not active');
    if (lease.business.status === 'SUSPENDED') {
      throw unprocessable('BUSINESS_SUSPENDED', 'This business cannot open a new rent plan');
    }
    const application = await tx.underwritingApplication.findUnique({
      where: { id: args.applicationId },
    });
    if (!application) throw notFound('Application');
    if (application.businessId !== lease.businessId) {
      throw unprocessable(
        'BUSINESS_MISMATCH',
        'Application and lease belong to different businesses',
      );
    }
    const offer = await passThroughOffer(tx, application.id);
    if (!offer.eligible) {
      throw unprocessable(
        'PASS_THROUGH_NOT_AVAILABLE',
        'A pass-through plan is not available for this application',
        { reason: offer.ineligibleReason },
      );
    }
    if (lease.business.bankLinks.length === 0) {
      throw unprocessable(
        'BANK_LINK_REQUIRED',
        'Connect the bank account your rent will be collected from first',
      );
    }
    const hits = await openHitsForPlan(tx, { businessId: lease.businessId, leaseId: lease.id });
    if (hits.length > 0) {
      throw unprocessable(
        'ACCOUNT_UNDER_REVIEW',
        'Your account is under review, so a new rent plan cannot start yet. Contact support and we will help',
      );
    }
    const pendingChange = await tx.leaseChange.findFirst({
      where: { leaseId: lease.id, status: 'PENDING' },
    });
    if (pendingChange) {
      throw unprocessable(
        'LEASE_CHANGE_PENDING',
        `A change to the landlord details on this lease takes effect on ${pendingChange.effectiveOn}. The plan can start after that`,
      );
    }
    const open = await tx.rentPlan.findFirst({
      where: { leaseId: lease.id, status: { not: 'CLOSED' } },
    });
    if (open) throw conflict('PLAN_EXISTS', 'This lease already has a rent plan');
    if (landlordIsApplicant(lease, lease.business.bankLinks, lease.business)) {
      throw unprocessable(
        'LANDLORD_ACCOUNT_MATCH',
        'The landlord payout account matches a bank account linked to this business. Rent has to be paid to the landlord',
      );
    }

    const plan = await tx.rentPlan.create({
      data: {
        kind: 'PASS_THROUGH',
        businessId: lease.businessId,
        leaseId: lease.id,
        applicationId: application.id,
        installmentsPerMonth: 1,
        feeBps: 0,
        monthlyRentCents: lease.monthlyRentCents,
        dueDayOfMonth: lease.dueDayOfMonth,
        createdAt: effectiveAt(args.asOf),
      },
    });
    await ensureUpcomingPassThroughPeriods(tx, { ...plan, startsOn: lease.startsOn }, args.asOf);
    await recordAudit(tx, {
      actor: { type: 'user', id: args.userId },
      eventType: 'PASS_THROUGH_PLAN_CREATED',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        businessId: lease.businessId,
        leaseId: lease.id,
        applicationId: application.id,
        monthlyRentCents: plan.monthlyRentCents,
      },
      at: effectiveAt(args.asOf),
    });
    return plan;
  });
}

type PlanForPeriods = Pick<RentPlan, 'id' | 'monthlyRentCents' | 'dueDayOfMonth'> & {
  startsOn: IsoDate;
};

/**
 * Make sure every month with a due date up to `asOf + horizon` exists. A month whose last
 * collection day has already passed is never created: the rent could not be collected and
 * settled in time, so the business pays that month itself. Returns how many were created.
 */
export async function ensureUpcomingPassThroughPeriods(
  tx: Tx,
  plan: PlanForPeriods,
  asOf: IsoDate,
  horizonDays = PASS_THROUGH_HORIZON_DAYS,
): Promise<number> {
  const horizon = addDays(asOf, horizonDays);
  const latest = await tx.passThroughPeriod.findFirst({
    where: { rentPlanId: plan.id },
    orderBy: { dueDate: 'desc' },
  });
  let nextDue: IsoDate = latest
    ? followingDueDate(latest.dueDate, plan.dueDayOfMonth)
    : nextRentDueDate(plan.dueDayOfMonth, plan.startsOn > asOf ? plan.startsOn : asOf);
  while (passThroughSchedule(POLICY, nextDue).lastCollectOn < asOf) {
    nextDue = followingDueDate(nextDue, plan.dueDayOfMonth);
  }
  let created = 0;
  while (nextDue <= horizon) {
    const schedule = passThroughSchedule(POLICY, nextDue);
    const periodMonth = periodMonthOf(nextDue);
    const exists = await tx.passThroughPeriod.findUnique({
      where: { rentPlanId_periodMonth: { rentPlanId: plan.id, periodMonth } },
    });
    if (!exists) {
      await tx.passThroughPeriod.create({
        data: {
          rentPlanId: plan.id,
          periodMonth,
          amountCents: plan.monthlyRentCents,
          dueDate: nextDue,
          collectOn: schedule.collectOn,
          lastCollectOn: schedule.lastCollectOn,
        },
      });
      created += 1;
    }
    nextDue = followingDueDate(nextDue, plan.dueDayOfMonth);
  }
  return created;
}

/**
 * Generate months for every active pass-through plan that is not frozen and has no accepted
 * graduation offer (the financed plan takes over from the next month).
 */
export async function generatePassThroughPeriods(ctx: AppContext, asOf: IsoDate) {
  const plans = await ctx.db.rentPlan.findMany({
    where: {
      kind: 'PASS_THROUGH',
      status: 'ACTIVE',
      advanceFrozenAt: null,
      graduationOffers: { none: { status: 'ACCEPTED' } },
    },
    include: { lease: true },
  });
  let created = 0;
  for (const plan of plans) {
    created += await ctx.db.$transaction((tx) =>
      ensureUpcomingPassThroughPeriods(tx, { ...plan, startsOn: plan.lease.startsOn }, asOf),
    );
  }
  return { passThroughPlans: plans.length, passThroughPeriodsCreated: created };
}

const JOB_ACTOR: AuditActor = { type: 'job', id: 'pass-through' };

async function lockPeriod(tx: Tx, periodId: string) {
  await tx.$queryRaw`SELECT "id" FROM "PassThroughPeriod" WHERE "id" = ${periodId} FOR UPDATE`;
}

export type PassThroughCollectionOutcome =
  'collected' | 'deferred' | 'failed' | 'missed' | 'cancelled' | 'skipped';

/** Mark a month missed: CashFlow will not pay the landlord, and the owner is told so. */
async function missPeriod(
  tx: Tx,
  period: PassThroughPeriod,
  planId: string,
  reason: string,
  asOf: IsoDate,
  actor: AuditActor,
  extra: Record<string, unknown> = {},
) {
  await tx.passThroughPeriod.update({
    where: { id: period.id },
    data: { status: 'MISSED', missedReason: reason },
  });
  await recordAudit(tx, {
    actor,
    eventType: 'PASS_THROUGH_MISSED',
    subjectType: 'rent_plan',
    subjectId: planId,
    payload: {
      periodId: period.id,
      periodMonth: period.periodMonth,
      amountCents: period.amountCents,
      dueDate: period.dueDate,
      reason,
      ownerToldToPayDirectly: true,
      asOf,
      ...extra,
    },
    severity: 'warning',
    at: effectiveAt(asOf),
  });
  // An open graduation offer is taken back: the run of on time months has ended.
  const offers = await tx.graduationOffer.findMany({
    where: { passThroughPlanId: planId, status: { in: ['OFFERED', 'ACCEPTED'] } },
  });
  for (const offer of offers) {
    // An accepted offer whose pass-through months are done goes ahead: the miss is history
    // the financed plan was not priced on, but the owner accepted terms we offered.
    if (offer.status === 'ACCEPTED') continue;
    await tx.graduationOffer.update({
      where: { id: offer.id },
      data: { status: 'WITHDRAWN', withdrawnReason: 'MISSED_MONTH' },
    });
    await recordAudit(tx, {
      actor,
      eventType: 'GRADUATION_WITHDRAWN',
      subjectType: 'rent_plan',
      subjectId: planId,
      payload: { offerId: offer.id, reason: 'MISSED_MONTH', periodMonth: period.periodMonth },
      at: effectiveAt(asOf),
    });
  }
}

/**
 * Collect one month if the policy schedules a debit today. Idempotent: a month is debited at
 * most once a day, and a month already collected, missed, or closed is skipped.
 */
export async function collectPassThroughPeriod(
  ctx: AppContext,
  periodId: string,
  asOf: IsoDate,
): Promise<PassThroughCollectionOutcome> {
  const { db, providers } = ctx;
  const at = effectiveAt(asOf);
  return db.$transaction(async (tx) => {
    await lockPeriod(tx, periodId);
    const period = await tx.passThroughPeriod.findUnique({
      where: { id: periodId },
      include: {
        rentPlan: {
          include: {
            lease: true,
            business: {
              include: {
                bankLinks: { where: { status: 'LINKED' }, orderBy: { createdAt: 'desc' }, take: 1 },
              },
            },
          },
        },
      },
    });
    if (!period || period.status !== 'SCHEDULED') return 'skipped';
    const plan = period.rentPlan;
    const action = collectionAction(
      POLICY,
      {
        collectOn: period.collectOn,
        lastCollectOn: period.lastCollectOn,
        attempts: period.collectionAttempts,
        lastAttemptOn: period.lastAttemptOn,
      },
      asOf,
    );
    if (action === 'wait') return 'skipped';

    // A plan that is no longer running collects nothing new. The month is closed without
    // any money moving, and the owner pays the landlord directly.
    if (plan.status !== 'ACTIVE' || plan.advanceFrozenAt !== null) {
      const reason =
        plan.status === 'CLOSED'
          ? 'PLAN_CLOSED'
          : plan.status === 'PAUSED'
            ? 'PLAN_PAUSED'
            : 'ADVANCE_FROZEN';
      await tx.passThroughPeriod.update({
        where: { id: period.id },
        data: { status: 'CANCELLED', cancelledReason: reason },
      });
      return 'cancelled';
    }

    if (action === 'miss') {
      const reason =
        period.collectionAttempts > 0
          ? 'COLLECTION_FAILED'
          : (period.collectionSkipReason ?? 'NOT_COLLECTED');
      await missPeriod(tx, period, plan.id, reason, asOf, JOB_ACTOR);
      return 'missed';
    }

    const bankLink = plan.business.bankLinks[0] ?? null;
    const defer = async (reason: string): Promise<PassThroughCollectionOutcome> => {
      if (period.collectionSkipReason !== reason) {
        await recordAudit(tx, {
          actor: JOB_ACTOR,
          eventType: 'COLLECTION_SKIPPED',
          subjectType: 'rent_plan',
          subjectId: plan.id,
          payload: { passThroughPeriodId: period.id, reason, asOf },
          at,
        });
      }
      await tx.passThroughPeriod.update({
        where: { id: period.id },
        data: { collectionSkipReason: reason, collectionSkippedOn: asOf },
      });
      return 'deferred';
    };
    if (!bankLink) return defer('NO_BANK_LINK');

    if (POLICY.balancePreCheck) {
      let balance: number | null = null;
      try {
        balance = await providers.bankLink.refreshBalance(bankLink.providerItemId);
      } catch (err) {
        ctx.log.warn({ bankLinkId: bankLink.id, err }, 'balance check failed');
      }
      if (!passThroughBalanceCovers(POLICY, balance, period.amountCents)) {
        return defer('INSUFFICIENT_BALANCE');
      }
    }

    const attempt = period.collectionAttempts + 1;
    const result = await providers.payments.charge({
      amountCents: period.amountCents,
      sourceToken: bankLink.providerAccountToken,
      idempotencyKey: collectKey(period.id, attempt),
      description: `Rent ${period.periodMonth} for ${plan.lease.landlordName} (pass-through)`,
      effectiveDate: asOf,
    });
    if (!result.ok) {
      await tx.passThroughPeriod.update({
        where: { id: period.id },
        data: {
          collectionAttempts: attempt,
          lastAttemptOn: asOf,
          collectionBankLinkId: bankLink.id,
          collectionSkipReason: null,
          collectionSkippedOn: null,
        },
      });
      // Out of attempts: missed today, not tomorrow, so the owner hears at once.
      if (attempt >= POLICY.maxCollectionAttempts) {
        await missPeriod(
          tx,
          { ...period, collectionAttempts: attempt },
          plan.id,
          'COLLECTION_FAILED',
          asOf,
          JOB_ACTOR,
          { failureReason: result.failureReason, returnCode: result.returnCode ?? null },
        );
        return 'missed';
      }
      return 'failed';
    }

    const settles = settlesOn(POLICY, asOf);
    await postTransaction(tx, {
      description: `Pass-through rent ${period.periodMonth} collected: ${plan.business.legalName}`,
      effectiveDate: asOf,
      referenceType: 'pass_through_collection',
      referenceId: period.id,
      idempotencyKey: collectKey(period.id, attempt),
      entries: [
        {
          accountCode: ACCOUNTS.PASS_THROUGH_CASH,
          direction: 'DEBIT',
          amountCents: period.amountCents,
        },
        {
          accountCode: ACCOUNTS.LANDLORD_PAYABLE,
          direction: 'CREDIT',
          amountCents: period.amountCents,
        },
      ],
    });
    await tx.passThroughPeriod.update({
      where: { id: period.id },
      data: {
        status: 'COLLECTING',
        collectionAttempts: attempt,
        lastAttemptOn: asOf,
        collectedOn: asOf,
        collectionProviderRef: result.providerRef,
        collectionBankLinkId: bankLink.id,
        settlesOn: settles,
        collectionSkipReason: null,
        collectionSkippedOn: null,
      },
    });
    await recordAudit(tx, {
      actor: JOB_ACTOR,
      eventType: 'PASS_THROUGH_COLLECTED',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        periodId: period.id,
        periodMonth: period.periodMonth,
        amountCents: period.amountCents,
        settlesOn: settles,
        attempt,
      },
      at,
    });
    return 'collected';
  });
}

/** Collect every month whose collection window is open. */
export async function collectPassThroughPeriods(ctx: AppContext, asOf: IsoDate) {
  const due = await ctx.db.passThroughPeriod.findMany({
    where: { status: 'SCHEDULED', collectOn: { lte: asOf } },
    orderBy: { collectOn: 'asc' },
    select: { id: true },
  });
  const counts = {
    passThroughDue: due.length,
    passThroughCollected: 0,
    passThroughDeferred: 0,
    passThroughFailed: 0,
    passThroughMissed: 0,
    passThroughCancelled: 0,
  };
  for (const { id } of due) {
    const outcome = await collectPassThroughPeriod(ctx, id, asOf);
    if (outcome === 'collected') counts.passThroughCollected += 1;
    else if (outcome === 'deferred') counts.passThroughDeferred += 1;
    else if (outcome === 'failed') counts.passThroughFailed += 1;
    else if (outcome === 'missed') counts.passThroughMissed += 1;
    else if (outcome === 'cancelled') counts.passThroughCancelled += 1;
  }
  return counts;
}

/** Collections past the return window are settled. A status change only: no money moves. */
export async function settlePassThroughPeriods(ctx: AppContext, asOf: IsoDate): Promise<number> {
  const result = await ctx.db.passThroughPeriod.updateMany({
    where: { status: 'COLLECTING', settlesOn: { lte: asOf } },
    data: { status: 'SETTLED', settledOn: asOf },
  });
  return result.count;
}

/** Why a settled month's landlord payout must wait, or null. */
async function passThroughHoldReason(
  tx: Tx,
  plan: Pick<RentPlan, 'id' | 'leaseId' | 'businessId' | 'advanceFrozenAt'>,
): Promise<string | null> {
  if (plan.advanceFrozenAt !== null) return 'ADVANCE_FROZEN';
  const pending = await tx.leaseChange.findFirst({
    where: { leaseId: plan.leaseId, status: 'PENDING' },
    select: { id: true },
  });
  if (pending) return 'LEASE_CHANGE_PENDING';
  const hits = await openHitsForPlan(tx, plan);
  if (hits.length > 0) return 'ADVANCE_FROZEN';
  return null;
}

export type PassThroughPayoutOutcome = 'paid' | 'held' | 'refunded' | 'failed' | 'skipped';

/**
 * Pay one settled month to the landlord, hold it, or send it back. The landlord is paid
 * only from a settled collection: a month in any other state is skipped, which is what the
 * `pass_through_payout_before_settlement` monitoring rule checks never happened.
 */
export async function payPassThroughPeriod(
  ctx: AppContext,
  periodId: string,
  asOf: IsoDate,
): Promise<PassThroughPayoutOutcome> {
  try {
    return await payPassThroughPeriodTx(ctx, periodId, asOf);
  } catch (err) {
    if (isUniqueViolation(err)) {
      ctx.log.warn({ periodId }, 'pass-through payout skipped: the month was claimed concurrently');
      return 'skipped';
    }
    throw err;
  }
}

async function payPassThroughPeriodTx(
  ctx: AppContext,
  periodId: string,
  asOf: IsoDate,
): Promise<PassThroughPayoutOutcome> {
  const { db, providers } = ctx;
  const at = effectiveAt(asOf);
  return db.$transaction(async (tx) => {
    await lockPeriod(tx, periodId);
    const period = await tx.passThroughPeriod.findUnique({
      where: { id: periodId },
      include: { rentPlan: { include: { lease: true, business: true } } },
    });
    if (!period || period.status !== 'SETTLED') return 'skipped';
    const plan = period.rentPlan;
    const holdReason = await passThroughHoldReason(tx, plan);
    const action = passThroughPayoutAction(
      POLICY,
      { dueDate: period.dueDate, settled: true, held: holdReason !== null },
      asOf,
    );
    if (action === 'wait') return 'skipped';
    if (action === 'hold') {
      if (period.heldReason !== holdReason) {
        await tx.passThroughPeriod.update({
          where: { id: period.id },
          data: { heldReason: holdReason, heldAt: period.heldAt ?? at },
        });
        await recordAudit(tx, {
          actor: JOB_ACTOR,
          eventType: 'PASS_THROUGH_HELD',
          subjectType: 'rent_plan',
          subjectId: plan.id,
          payload: {
            periodId: period.id,
            periodMonth: period.periodMonth,
            reason: holdReason,
            asOf,
          },
          severity: 'warning',
          at,
        });
      }
      return 'held';
    }
    if (action === 'refund') {
      return refundPeriod(ctx, tx, period, plan, holdReason ?? 'HELD', asOf);
    }

    const key = payoutKeyFor(period.id);
    const claim = await claimDisbursement(tx, {
      leaseId: plan.leaseId,
      periodMonth: period.periodMonth,
      rentPlanId: plan.id,
      kind: 'PASS_THROUGH',
      sourceId: period.id,
      idempotencyKey: key,
      amountCents: period.amountCents,
      effectiveDate: asOf,
    });
    if (!claim.ok) {
      // The landlord was already paid for this month. The business's money goes back.
      await recordAudit(tx, {
        actor: JOB_ACTOR,
        eventType: 'DUPLICATE_PAYOUT_PREVENTED',
        subjectType: 'rent_plan',
        subjectId: plan.id,
        payload: {
          passThroughPeriodId: period.id,
          leaseId: plan.leaseId,
          periodMonth: period.periodMonth,
          amountCents: period.amountCents,
          alreadyPaidBy: claim.existing,
          asOf,
        },
        severity: 'high',
        at,
      });
      return refundPeriod(ctx, tx, period, plan, 'PERIOD_ALREADY_PAID', asOf);
    }
    const result = await providers.payments.payout({
      amountCents: period.amountCents,
      destinationToken: plan.lease.landlordPayoutToken,
      idempotencyKey: key,
      description: `Rent ${period.periodMonth} for ${plan.business.legalName} to ${plan.lease.landlordName} (pass-through)`,
      effectiveDate: asOf,
    });
    if (!result.ok) {
      // Tried again on the next run, inside the release window, then refunded.
      await releaseDisbursement(tx, claim.id);
      ctx.log.warn(
        { periodId: period.id, reason: result.failureReason },
        'pass-through payout failed',
      );
      return 'failed';
    }
    await confirmDisbursement(tx, claim.id, result.providerRef);
    await postTransaction(tx, {
      description: `Pass-through rent ${period.periodMonth} paid to ${plan.lease.landlordName}: ${plan.business.legalName}`,
      effectiveDate: asOf,
      referenceType: 'pass_through_payout',
      referenceId: period.id,
      idempotencyKey: key,
      entries: [
        {
          accountCode: ACCOUNTS.LANDLORD_PAYABLE,
          direction: 'DEBIT',
          amountCents: period.amountCents,
        },
        {
          accountCode: ACCOUNTS.PASS_THROUGH_CASH,
          direction: 'CREDIT',
          amountCents: period.amountCents,
        },
      ],
    });
    await tx.passThroughPeriod.update({
      where: { id: period.id },
      data: {
        status: 'PAID',
        paidOn: asOf,
        paidAt: at,
        payoutProviderRef: result.providerRef,
        heldReason: null,
      },
    });
    await recordAudit(tx, {
      actor: JOB_ACTOR,
      eventType: 'PASS_THROUGH_LANDLORD_PAID',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        periodId: period.id,
        periodMonth: period.periodMonth,
        amountCents: period.amountCents,
        collectedOn: period.collectedOn,
        settledOn: period.settledOn,
        wasHeld: period.heldAt !== null,
        asOf,
      },
      at,
    });
    return 'paid';
  });
}

/** Send a collected month back to the business: the landlord could not be paid in time. */
async function refundPeriod(
  ctx: AppContext,
  tx: Tx,
  period: PassThroughPeriod,
  plan: RentPlan & { business: { legalName: string } },
  reason: string,
  asOf: IsoDate,
): Promise<PassThroughPayoutOutcome> {
  const bankLink = period.collectionBankLinkId
    ? await tx.bankLink.findUnique({ where: { id: period.collectionBankLinkId } })
    : null;
  const key = `pass_through:${period.id}:refund`;
  const result = bankLink
    ? await ctx.providers.payments.payout({
        amountCents: period.amountCents,
        destinationToken: bankLink.providerAccountToken,
        idempotencyKey: key,
        description: `Refund of pass-through rent ${period.periodMonth}: ${plan.business.legalName}`,
        effectiveDate: asOf,
      })
    : ({ ok: false, providerRef: null, failureReason: 'No bank account to refund to' } as const);
  if (!result.ok) {
    ctx.log.error(
      { periodId: period.id, reason: result.failureReason },
      'pass-through refund failed',
    );
    return 'failed';
  }
  await postTransaction(tx, {
    description: `Pass-through rent ${period.periodMonth} refunded: ${plan.business.legalName}`,
    effectiveDate: asOf,
    referenceType: 'pass_through_refund',
    referenceId: period.id,
    idempotencyKey: key,
    entries: [
      {
        accountCode: ACCOUNTS.LANDLORD_PAYABLE,
        direction: 'DEBIT',
        amountCents: period.amountCents,
      },
      {
        accountCode: ACCOUNTS.PASS_THROUGH_CASH,
        direction: 'CREDIT',
        amountCents: period.amountCents,
      },
    ],
  });
  await tx.passThroughPeriod.update({
    where: { id: period.id },
    data: {
      status: 'REFUNDED',
      refundedOn: asOf,
      refundProviderRef: result.providerRef,
      heldReason: reason,
    },
  });
  await recordAudit(tx, {
    actor: JOB_ACTOR,
    eventType: 'PASS_THROUGH_REFUNDED',
    subjectType: 'rent_plan',
    subjectId: plan.id,
    payload: {
      periodId: period.id,
      periodMonth: period.periodMonth,
      amountCents: period.amountCents,
      reason,
      asOf,
    },
    severity: 'warning',
    at: effectiveAt(asOf),
  });
  return 'refunded';
}

/** Settle what has cleared, then pay, hold, or refund every settled month that is due. */
export async function processPassThroughPayouts(ctx: AppContext, asOf: IsoDate) {
  const settled = await settlePassThroughPeriods(ctx, asOf);
  const due = await ctx.db.passThroughPeriod.findMany({
    where: { status: 'SETTLED', dueDate: { lte: asOf } },
    orderBy: { dueDate: 'asc' },
    select: { id: true },
  });
  const counts = {
    passThroughSettled: settled,
    passThroughPayoutsDue: due.length,
    passThroughPaid: 0,
    passThroughHeld: 0,
    passThroughRefunded: 0,
    passThroughPayoutsFailed: 0,
  };
  for (const { id } of due) {
    const outcome = await payPassThroughPeriod(ctx, id, asOf);
    if (outcome === 'paid') counts.passThroughPaid += 1;
    else if (outcome === 'held') counts.passThroughHeld += 1;
    else if (outcome === 'refunded') counts.passThroughRefunded += 1;
    else if (outcome === 'failed') counts.passThroughPayoutsFailed += 1;
  }
  return counts;
}

const RETURN_ACTOR: AuditActor = { type: 'job', id: 'reconcile-payments' };

/**
 * A pass-through collection the business's bank sent back.
 *
 * Before the landlord was paid (inside the settlement window, or settled and not yet due):
 * the collection is reversed, the month is MISSED, and CashFlow does not pay the landlord.
 * The owner is told to pay directly.
 *
 * After the landlord was paid (an unauthorized return can arrive weeks later): the rent has
 * gone out and cannot be taken back. CashFlow's own money covers it: the pool makes the
 * pass-through account whole, and the business owes the amount on its receivable account.
 * The plan is closed, and a high severity event opens an alert.
 */
export async function reversePassThroughCollection(
  ctx: AppContext,
  ret: PaymentReturn,
  asOf: IsoDate,
): Promise<ReturnOutcome> {
  return ctx.db.$transaction(async (tx) => {
    const period = await tx.passThroughPeriod.findFirst({
      where: { collectionProviderRef: ret.providerRef },
      include: { rentPlan: { include: { business: true } } },
    });
    if (!period) return 'unknown';
    await lockPeriod(tx, period.id);
    const fresh = await tx.passThroughPeriod.findUniqueOrThrow({ where: { id: period.id } });
    const plan = period.rentPlan;
    const at = effectiveAt(asOf);
    const originalKey = collectKey(period.id, fresh.collectionAttempts);
    if (fresh.status === 'COLLECTING' || fresh.status === 'SETTLED') {
      await reverseTransaction(tx, originalKey, {
        description: `Return ${ret.returnCode}: pass-through rent ${period.periodMonth}`,
        effectiveDate: ret.returnedOn,
        referenceType: 'pass_through_collection_return',
        referenceId: period.id,
        idempotencyKey: `${originalKey}:return`,
      });
      await tx.passThroughPeriod.update({
        where: { id: period.id },
        data: { returnCode: ret.returnCode, returnedOn: ret.returnedOn },
      });
      await missPeriod(tx, fresh, plan.id, 'COLLECTION_RETURNED', asOf, RETURN_ACTOR, {
        returnCode: ret.returnCode,
        returnedOn: ret.returnedOn,
      });
      return 'reversed';
    }
    if (fresh.status !== 'PAID') return 'already_handled';

    await ensureReceivableAccount(tx, plan.businessId, plan.business.legalName);
    await postTransaction(tx, {
      description: `Return ${ret.returnCode} after the landlord was paid: pass-through rent ${period.periodMonth}, ${plan.business.legalName}`,
      effectiveDate: ret.returnedOn,
      referenceType: 'pass_through_returned_after_payout',
      referenceId: period.id,
      idempotencyKey: `${originalKey}:return_after_payout`,
      entries: [
        // The business owes the rent CashFlow has now paid for it...
        {
          accountCode: receivableCode(plan.businessId),
          direction: 'DEBIT',
          amountCents: period.amountCents,
        },
        // ...the bank took the collection back out of the pass-through account...
        {
          accountCode: ACCOUNTS.PASS_THROUGH_CASH,
          direction: 'CREDIT',
          amountCents: period.amountCents,
        },
        // ...and CashFlow's own money makes that account whole.
        {
          accountCode: ACCOUNTS.PASS_THROUGH_CASH,
          direction: 'DEBIT',
          amountCents: period.amountCents,
        },
        {
          accountCode: ACCOUNTS.CAPITAL_POOL,
          direction: 'CREDIT',
          amountCents: period.amountCents,
        },
      ],
    });
    await tx.passThroughPeriod.update({
      where: { id: period.id },
      data: {
        status: 'RETURNED_AFTER_PAYOUT',
        returnCode: ret.returnCode,
        returnedOn: ret.returnedOn,
      },
    });
    if (plan.status !== 'CLOSED') {
      await tx.rentPlan.update({
        where: { id: plan.id },
        data: { status: 'CLOSED', closedAt: at, closedReason: 'RETURNED_AFTER_PAYOUT' },
      });
      await tx.passThroughPeriod.updateMany({
        where: { rentPlanId: plan.id, status: 'SCHEDULED' },
        data: { status: 'CANCELLED', cancelledReason: 'PLAN_CLOSED' },
      });
    }
    await recordAudit(tx, {
      actor: RETURN_ACTOR,
      eventType: 'PASS_THROUGH_RETURNED_AFTER_PAYOUT',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        periodId: period.id,
        periodMonth: period.periodMonth,
        amountCents: period.amountCents,
        returnCode: ret.returnCode,
        returnedOn: ret.returnedOn,
        owedCents: period.amountCents,
      },
      severity: 'high',
      at,
    });
    ctx.log.error(
      { periodId: period.id, returnCode: ret.returnCode },
      'pass-through collection returned after the landlord was paid',
    );
    return 'reversed';
  });
}

/**
 * A pass-through landlord payment the landlord's bank sent back. The money is the
 * business's, so it is refunded, and the plan is frozen until the landlord's details are
 * corrected and a reviewer releases it.
 */
export async function reversePassThroughPayout(
  ctx: AppContext,
  ret: PaymentReturn,
  asOf: IsoDate,
): Promise<ReturnOutcome> {
  return ctx.db.$transaction(async (tx) => {
    const period = await tx.passThroughPeriod.findFirst({
      where: { payoutProviderRef: ret.providerRef },
      include: { rentPlan: { include: { business: true } } },
    });
    if (!period) return 'unknown';
    if (period.status !== 'PAID') return 'already_handled';
    const plan = period.rentPlan;
    const at = effectiveAt(asOf);
    const key = payoutKeyFor(period.id);
    await markDisbursementReturned(tx, key, at);
    await reverseTransaction(tx, key, {
      description: `Return ${ret.returnCode}: pass-through landlord payment ${period.periodMonth}`,
      effectiveDate: ret.returnedOn,
      referenceType: 'pass_through_payout_return',
      referenceId: period.id,
      idempotencyKey: `${key}:return`,
    });
    await tx.passThroughPeriod.update({
      where: { id: period.id },
      data: { status: 'SETTLED', paidOn: null, paidAt: null, payoutProviderRef: null },
    });
    if (plan.advanceFrozenAt === null) {
      await tx.rentPlan.update({
        where: { id: plan.id },
        data: { advanceFrozenAt: at, advanceFrozenReason: 'PAYOUT_RETURNED' },
      });
    }
    await recordAudit(tx, {
      actor: RETURN_ACTOR,
      eventType: 'PAYOUT_RETURNED',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        passThroughPeriodId: period.id,
        periodMonth: period.periodMonth,
        amountCents: period.amountCents,
        returnCode: ret.returnCode,
        returnedOn: ret.returnedOn,
      },
      severity: 'high',
      at,
    });
    const refunded = await refundPeriod(
      ctx,
      tx,
      { ...period, status: 'SETTLED' },
      plan,
      'PAYOUT_RETURNED',
      asOf,
    );
    if (refunded !== 'refunded')
      throw new Error(`Could not refund pass-through period ${period.id}`);
    return 'reversed';
  });
}

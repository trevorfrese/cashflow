import {
  addDays,
  buildInstallmentSchedule,
  followingDueDate,
  nextRentDueDate,
  type IsoDate,
} from '@cashflow/shared';

import type { CashFlowSummary } from '@cashflow/shared';

import type { Db, Tx } from '../db.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { ensureReceivableAccount } from '../ledger/accounts.ts';
import type { Providers } from '../providers/index.ts';
import { checkNewPlan } from '../underwriting/exposure.ts';
import { landlordIsApplicant } from '../underwriting/integrity.ts';
import { CURRENT_POLICY } from '../underwriting/policy.ts';
import { planFeeBps } from '../underwriting/pricing.ts';
import { recordAudit } from './audit.ts';
import { currentDecision } from './decisions.ts';
import { gatherExposureContext } from './portfolio-state.ts';

type PlanRow = {
  id: string;
  monthlyRentCents: number;
  feeBps: number;
  dueDayOfMonth: number;
  installmentsPerMonth: number;
};

/** How far ahead the scheduler creates payouts and installments. */
export const PERIOD_HORIZON_DAYS = 30;

/**
 * Creates the payout and installments for the period whose rent is due on `dueDate`.
 * Idempotent: if that period already exists for the plan it is returned unchanged.
 */
export async function generatePeriod(tx: Tx, plan: PlanRow, dueDate: IsoDate) {
  const schedule = buildInstallmentSchedule({
    rentCents: plan.monthlyRentCents,
    feeBps: plan.feeBps,
    dueDate,
    installmentsPerMonth: plan.installmentsPerMonth,
  });

  const existing = await tx.landlordPayout.findUnique({
    where: { rentPlanId_periodMonth: { rentPlanId: plan.id, periodMonth: schedule.periodMonth } },
    include: { installments: { orderBy: { sequence: 'asc' } } },
  });
  if (existing) return existing;

  return tx.landlordPayout.create({
    data: {
      rentPlanId: plan.id,
      periodMonth: schedule.periodMonth,
      amountCents: schedule.payoutCents,
      scheduledFor: schedule.payoutDate,
      installments: {
        create: schedule.installments.map((i) => ({
          rentPlanId: plan.id,
          periodMonth: schedule.periodMonth,
          sequence: i.sequence,
          principalCents: i.principalCents,
          feeCents: i.feeCents,
          totalCents: i.totalCents,
          dueDate: i.dueDate,
        })),
      },
    },
    include: { installments: { orderBy: { sequence: 'asc' } } },
  });
}

/**
 * Makes sure every period with a due date up to `asOf + horizon` exists for the plan.
 * Returns how many new periods were created.
 */
export async function ensureUpcomingPeriods(
  tx: Tx,
  plan: PlanRow & { startsOn: IsoDate },
  asOf: IsoDate,
  horizonDays = PERIOD_HORIZON_DAYS,
): Promise<number> {
  const horizon = addDays(asOf, horizonDays);
  const latest = await tx.landlordPayout.findFirst({
    where: { rentPlanId: plan.id },
    orderBy: { scheduledFor: 'desc' },
  });

  let nextDue: IsoDate = latest
    ? followingDueDate(latest.scheduledFor, plan.dueDayOfMonth)
    : nextRentDueDate(plan.dueDayOfMonth, plan.startsOn > asOf ? plan.startsOn : asOf);

  let created = 0;
  while (nextDue <= horizon) {
    await generatePeriod(tx, plan, nextDue);
    created += 1;
    nextDue = followingDueDate(nextDue, plan.dueDayOfMonth);
  }
  return created;
}

export interface CreateRentPlanArgs {
  userId: string;
  leaseId: string;
  applicationId: string;
  installmentsPerMonth: number;
  asOf: IsoDate;
}

/**
 * Turns an approved application plus a lease into an active rent plan and schedules the first
 * period. All checks and writes happen in one database transaction.
 *
 * The decision may be weeks old by the time a plan is opened, so the exposure rules run
 * again here against today's state: the limit, the ladder and aggregate cap across the
 * business's other plans, single name and industry concentration, and the pool utilization
 * ceiling. The landlord account is checked against the business's own accounts, because the
 * lease is usually linked after the decision. The fee is the decision's, raised to the
 * minimum fee in cents when the lease is small.
 */
export async function createRentPlan(
  { db, providers }: { db: Db; providers: Providers },
  args: CreateRentPlanArgs,
) {
  return db.$transaction(async (tx) => {
    const lease = await tx.lease.findUnique({
      where: { id: args.leaseId },
      include: { business: { include: { bankLinks: { where: { status: 'LINKED' } } } } },
    });
    if (!lease) throw notFound('Lease');
    if (lease.business.ownerUserId !== args.userId) throw forbidden();
    if (lease.status !== 'ACTIVE') throw unprocessable('LEASE_NOT_ACTIVE', 'Lease is not active');

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
    const decision = await currentDecision(tx, application.id);
    if (application.status !== 'APPROVED' || !decision || decision.outcome !== 'APPROVED') {
      throw unprocessable('APPLICATION_NOT_APPROVED', 'Application has not been approved');
    }
    const limit = decision.approvedMonthlyLimitCents ?? 0;
    if (lease.monthlyRentCents > limit) {
      throw unprocessable('RENT_OVER_LIMIT', 'Monthly rent exceeds the approved limit', {
        monthlyRentCents: lease.monthlyRentCents,
        approvedMonthlyLimitCents: limit,
      });
    }

    const active = await tx.rentPlan.findFirst({ where: { leaseId: lease.id, status: 'ACTIVE' } });
    if (active) throw conflict('PLAN_EXISTS', 'This lease already has an active rent plan');

    if (landlordIsApplicant(lease, lease.business.bankLinks, lease.business)) {
      throw unprocessable(
        'LANDLORD_ACCOUNT_MATCH',
        'The landlord payout account matches a bank account linked to this business. Rent has to be paid to the landlord',
      );
    }

    // The rules in force today apply, whichever policy version made the decision.
    const policy = CURRENT_POLICY;
    if (policy.exposure) {
      const context = await gatherExposureContext(tx, providers, {
        businessId: lease.businessId,
        industry: lease.business.industry,
      });
      const refusal = checkNewPlan(policy.exposure, {
        rentCents: lease.monthlyRentCents,
        approvedLimitCents: limit,
        observedRentCents:
          (decision.cashFlow as unknown as CashFlowSummary | null)?.observedRentCents ?? null,
        // A reviewer who set the terms has verified the lease another way.
        leaseVerified: decision.kind === 'REVIEW',
        context,
      });
      if (refusal?.code === 'RENT_OVER_LIMIT') {
        throw unprocessable('RENT_OVER_LIMIT', refusal.message, {
          monthlyRentCents: lease.monthlyRentCents,
          approvedMonthlyLimitCents: limit,
        });
      }
      if (refusal?.code === 'EXPOSURE_CAP') {
        throw unprocessable('EXPOSURE_CAP_EXCEEDED', refusal.message, { cap: refusal.cap });
      }
      if (refusal?.code === 'FUNDING_UNAVAILABLE') {
        throw unprocessable('FUNDING_UNAVAILABLE', refusal.message, { blockers: refusal.blockers });
      }
    }

    const feeBps = planFeeBps(policy, decision.feeBps ?? 0, lease.monthlyRentCents);
    if (feeBps === null) {
      throw unprocessable(
        'RENT_BELOW_MINIMUM',
        'This rent is too small for our minimum fee to stay within the maximum fee rate',
      );
    }

    const plan = await tx.rentPlan.create({
      data: {
        businessId: lease.businessId,
        leaseId: lease.id,
        applicationId: application.id,
        installmentsPerMonth: args.installmentsPerMonth,
        feeBps,
        monthlyRentCents: lease.monthlyRentCents,
        dueDayOfMonth: lease.dueDayOfMonth,
      },
    });

    await ensureReceivableAccount(tx, lease.businessId, lease.business.legalName);
    await ensureUpcomingPeriods(tx, { ...plan, startsOn: lease.startsOn }, args.asOf);
    await recordAudit(tx, {
      actor: { type: 'user', id: args.userId },
      eventType: 'PLAN_CREATED',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        businessId: lease.businessId,
        leaseId: lease.id,
        applicationId: application.id,
        decisionId: decision.id,
        monthlyRentCents: plan.monthlyRentCents,
        feeBps: plan.feeBps,
        installmentsPerMonth: plan.installmentsPerMonth,
      },
    });

    return plan;
  });
}

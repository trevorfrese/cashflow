import {
  addDays,
  buildInstallmentSchedule,
  followingDueDate,
  nextRentDueDate,
  type IsoDate,
} from '@cashflow/shared';

import type { Db, Tx } from '../db.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { ensureReceivableAccount } from '../ledger/accounts.ts';

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
 */
export async function createRentPlan(db: Db, args: CreateRentPlanArgs) {
  return db.$transaction(async (tx) => {
    const lease = await tx.lease.findUnique({
      where: { id: args.leaseId },
      include: { business: true },
    });
    if (!lease) throw notFound('Lease');
    if (lease.business.ownerUserId !== args.userId) throw forbidden();
    if (lease.status !== 'ACTIVE') throw unprocessable('LEASE_NOT_ACTIVE', 'Lease is not active');

    const application = await tx.underwritingApplication.findUnique({
      where: { id: args.applicationId },
      include: { decision: true },
    });
    if (!application) throw notFound('Application');
    if (application.businessId !== lease.businessId) {
      throw unprocessable(
        'BUSINESS_MISMATCH',
        'Application and lease belong to different businesses',
      );
    }
    if (application.status !== 'APPROVED' || !application.decision) {
      throw unprocessable('APPLICATION_NOT_APPROVED', 'Application has not been approved');
    }
    const limit = application.decision.approvedMonthlyLimitCents ?? 0;
    if (lease.monthlyRentCents > limit) {
      throw unprocessable('RENT_OVER_LIMIT', 'Monthly rent exceeds the approved limit', {
        monthlyRentCents: lease.monthlyRentCents,
        approvedMonthlyLimitCents: limit,
      });
    }

    const active = await tx.rentPlan.findFirst({ where: { leaseId: lease.id, status: 'ACTIVE' } });
    if (active) throw conflict('PLAN_EXISTS', 'This lease already has an active rent plan');

    const plan = await tx.rentPlan.create({
      data: {
        businessId: lease.businessId,
        leaseId: lease.id,
        applicationId: application.id,
        installmentsPerMonth: args.installmentsPerMonth,
        feeBps: application.decision.feeBps ?? 0,
        monthlyRentCents: lease.monthlyRentCents,
        dueDayOfMonth: lease.dueDayOfMonth,
      },
    });

    await ensureReceivableAccount(tx, lease.businessId, lease.business.legalName);
    await ensureUpcomingPeriods(tx, { ...plan, startsOn: lease.startsOn }, args.asOf);

    return plan;
  });
}

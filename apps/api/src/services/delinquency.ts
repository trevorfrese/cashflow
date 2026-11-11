import type { DelinquencyStatus, IsoDate } from '@cashflow/shared';

import { effectiveAt } from '../dates.ts';
import type { Tx } from '../db.ts';
import type { InstallmentStatus } from '../generated/prisma/enums.ts';
import {
  ACTIVE_SERVICING_POLICY,
  attemptsExhausted,
  daysPastDue,
  delinquencyBucket,
  isLate,
} from '../servicing/policy.ts';
import { recordAudit, type AuditActor } from './audit.ts';

/**
 * Delinquency state.
 *
 * Days past due is never stored. It is the age of the oldest unpaid installment, and it
 * moves at midnight every day without any event, so a stored number is wrong whenever a job
 * runs late. Everything that needs it derives it from the installments, which are the
 * source of truth.
 *
 * The bucket is stored on the plan (`RentPlan.delinquencyStatus`). A change of bucket is an
 * event: it is written to the audit log, the provision job reserves by it, and the ops
 * summary groups by it. It is refreshed by the `age-receivables` job every day, and in the
 * same transaction as any payment or return that changes what is unpaid, so a cure shows at
 * once. The owner-facing API derives the bucket from days past due on read, so the two it
 * shows always agree even when the aging job has not run yet today.
 */

/** Owed and not written off. A CHARGED_OFF installment is also still owed; see `OWED`. */
export const UNPAID: InstallmentStatus[] = ['SCHEDULED', 'FAILED', 'LATE'];
/** Everything the business still owes, written off or not. */
export const OWED: InstallmentStatus[] = [...UNPAID, 'CHARGED_OFF'];

export interface DelinquencyState {
  bucket: DelinquencyStatus;
  daysPastDue: number;
  changed: boolean;
}

/**
 * Recompute one plan's bucket as of `asOf`, mark its installments LATE once they are past
 * grace, and write an audit event if the bucket changed. A written off plan stays
 * CHARGED_OFF. Idempotent.
 */
export async function refreshDelinquency(
  tx: Tx,
  planId: string,
  asOf: IsoDate,
  actor: AuditActor,
): Promise<DelinquencyState> {
  const policy = ACTIVE_SERVICING_POLICY;
  const plan = await tx.rentPlan.findUniqueOrThrow({
    where: { id: planId },
    select: { id: true, delinquencyStatus: true },
  });
  // Only rent that was actually paid to the landlord can be past due.
  const unpaid = await tx.installment.findMany({
    where: {
      rentPlanId: planId,
      status: { in: UNPAID },
      payout: { status: 'PAID' },
      dueDate: { lte: asOf },
    },
    orderBy: { dueDate: 'asc' },
    select: { id: true, dueDate: true, status: true },
  });
  const days = unpaid.length > 0 ? daysPastDue(unpaid[0]!.dueDate, asOf) : 0;

  const newlyLate = unpaid.filter((i) => i.status !== 'LATE' && isLate(policy, i.dueDate, asOf));
  if (newlyLate.length > 0) {
    await tx.installment.updateMany({
      where: { id: { in: newlyLate.map((i) => i.id) } },
      data: { status: 'LATE' },
    });
  }

  const bucket = delinquencyBucket(policy, days, plan.delinquencyStatus === 'CHARGED_OFF');
  const changed = bucket !== plan.delinquencyStatus;
  if (changed) {
    await tx.rentPlan.update({ where: { id: planId }, data: { delinquencyStatus: bucket } });
    await recordAudit(tx, {
      actor,
      eventType: 'DELINQUENCY_CHANGED',
      subjectType: 'rent_plan',
      subjectId: planId,
      payload: { from: plan.delinquencyStatus, to: bucket, daysPastDue: days, asOf },
      severity: bucket === 'DEFAULT' ? 'warning' : 'info',
      at: effectiveAt(asOf),
    });
  }
  return { bucket, daysPastDue: days, changed };
}

/**
 * Due date of the oldest unpaid installment a business owes on rent already paid to a
 * landlord, across all of its plans, leaving out one payout's own installments. This is
 * what the payout hold rule reads. It looks across plans on purpose: a business behind on
 * one lease does not get the next month fronted on another.
 */
export async function oldestUnpaidDueDate(
  tx: Tx,
  businessId: string,
  excludePayoutId: string,
): Promise<IsoDate | null> {
  const oldest = await tx.installment.findFirst({
    where: {
      rentPlan: { businessId },
      status: { in: UNPAID },
      payout: { status: 'PAID' },
      payoutId: { not: excludePayoutId },
    },
    orderBy: { dueDate: 'asc' },
    select: { dueDate: true },
  });
  return oldest?.dueDate ?? null;
}

/** What the owner is shown about a plan's standing. Derived on read, as of `today`. */
export interface PlanStanding {
  delinquencyStatus: DelinquencyStatus;
  daysPastDue: number;
  pastDueCents: number;
  needsPayment: boolean;
}

const CURRENT_STANDING: PlanStanding = {
  delinquencyStatus: 'CURRENT',
  daysPastDue: 0,
  pastDueCents: 0,
  needsPayment: false,
};

/**
 * Standing for a set of plans in two queries. Past due is everything owed with a due date
 * before `today`, written off balances included: a written off installment is still owed.
 */
export async function planStandings(
  tx: Tx,
  plans: ReadonlyArray<{ id: string; businessId: string; delinquencyStatus: DelinquencyStatus }>,
  today: IsoDate,
): Promise<Map<string, PlanStanding>> {
  const policy = ACTIVE_SERVICING_POLICY;
  const out = new Map<string, PlanStanding>();
  for (const plan of plans) {
    out.set(plan.id, { ...CURRENT_STANDING, delinquencyStatus: plan.delinquencyStatus });
  }
  if (plans.length === 0) return out;
  const [owed, links] = await Promise.all([
    tx.installment.findMany({
      where: {
        rentPlanId: { in: plans.map((p) => p.id) },
        status: { in: OWED },
        payout: { status: 'PAID' },
        dueDate: { lt: today },
      },
      orderBy: { dueDate: 'asc' },
      select: {
        rentPlanId: true,
        dueDate: true,
        totalCents: true,
        status: true,
        attemptCount: true,
        attemptBankLinkId: true,
      },
    }),
    tx.bankLink.findMany({
      where: { businessId: { in: plans.map((p) => p.businessId) }, status: 'LINKED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, businessId: true },
    }),
  ]);
  const linkByBusiness = new Map<string, string>();
  for (const link of links) {
    if (!linkByBusiness.has(link.businessId)) linkByBusiness.set(link.businessId, link.id);
  }
  const byPlan = new Map(plans.map((p) => [p.id, p]));
  for (const i of owed) {
    const plan = byPlan.get(i.rentPlanId)!;
    const standing = out.get(i.rentPlanId)!;
    const days = daysPastDue(i.dueDate, today);
    if (days > standing.daysPastDue) standing.daysPastDue = days;
    standing.pastDueCents += i.totalCents;
    const linkId = linkByBusiness.get(plan.businessId) ?? null;
    const attempts = linkId !== null && i.attemptBankLinkId === linkId ? i.attemptCount : 0;
    if (i.status === 'CHARGED_OFF' || linkId === null || attemptsExhausted(policy, attempts)) {
      standing.needsPayment = true;
    }
  }
  for (const plan of plans) {
    const standing = out.get(plan.id)!;
    standing.delinquencyStatus = delinquencyBucket(
      policy,
      standing.daysPastDue,
      plan.delinquencyStatus === 'CHARGED_OFF',
    );
  }
  return out;
}

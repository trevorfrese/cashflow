import type { DelinquencySummary, IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import type { Tx } from '../db.ts';
import { ACCOUNTS } from '../ledger/accounts.ts';
import {
  accountBalance,
  allowanceBalance,
  findTransactionByKey,
  postTransaction,
  receivablesBalance,
} from '../ledger/service.ts';
import {
  ACTIVE_SERVICING_POLICY,
  DELINQUENCY_BUCKETS,
  OPEN_BUCKETS,
  requiredAllowanceCents,
  reserveCents,
  type DelinquencyBucket,
  type OpenBucket,
} from '../servicing/policy.ts';
import { UNPAID } from './delinquency.ts';

/**
 * Loss provisioning.
 *
 * The allowance for credit losses is the part of receivables the policy does not expect back:
 * outstanding principal in each delinquency bucket times that bucket's reserve rate. Once a
 * month the `provision` job moves the allowance to that figure and posts only the change:
 * DR provision expense / CR allowance to build it, the reverse to release it. A charge-off
 * draws the allowance down (see `chargeOffPlan`), so the next month's provision rebuilds it
 * on whatever is still outstanding.
 */

type BucketTotals = Record<DelinquencyBucket, { plans: number; principalCents: number }>;

/**
 * Outstanding principal by the bucket of the plan that owes it: unpaid installments on rent
 * that was paid to a landlord and has not been written off. The plan's stored bucket is
 * used, which the aging job refreshed earlier in the same run.
 */
export async function outstandingByBucket(tx: Tx): Promise<BucketTotals> {
  const totals = Object.fromEntries(
    DELINQUENCY_BUCKETS.map((b) => [b, { plans: 0, principalCents: 0 }]),
  ) as BucketTotals;
  // One after the other: this runs inside a transaction, which is a single connection.
  const plans = await tx.rentPlan.findMany({ select: { id: true, delinquencyStatus: true } });
  const unpaid = await tx.installment.groupBy({
    by: ['rentPlanId'],
    where: { status: { in: UNPAID }, payout: { status: 'PAID' } },
    _sum: { principalCents: true },
  });
  const owed = new Map(unpaid.map((u) => [u.rentPlanId, u._sum.principalCents ?? 0]));
  for (const plan of plans) {
    const principal = owed.get(plan.id) ?? 0;
    // A written off plan is counted even at zero, so the summary shows how many there are.
    if (principal === 0 && plan.delinquencyStatus !== 'CHARGED_OFF') continue;
    totals[plan.delinquencyStatus].plans += 1;
    totals[plan.delinquencyStatus].principalCents += principal;
  }
  return totals;
}

function openPrincipal(totals: BucketTotals): Record<OpenBucket, number> {
  return Object.fromEntries(OPEN_BUCKETS.map((b) => [b, totals[b].principalCents])) as Record<
    OpenBucket,
    number
  >;
}

export interface ProvisionResult {
  /** YYYY-MM the provision is for. */
  period: string;
  posted: boolean;
  alreadyPosted: boolean;
  requiredCents: number;
  allowanceBeforeCents: number;
  /** Positive builds the allowance, negative releases it. Zero when nothing was posted. */
  changeCents: number;
}

/**
 * Book the month's provision: on the first successful run of the `provision` job in a
 * calendar month, and only then, so the job can run every day. The posting is keyed
 * `provision:YYYY-MM`. A month in which the allowance is already right posts nothing, and
 * the job's own run record is what marks that month as done.
 */
export async function bookProvision(ctx: AppContext, asOf: IsoDate): Promise<ProvisionResult> {
  const policy = ACTIVE_SERVICING_POLICY;
  const period = asOf.slice(0, 7);
  const key = `provision:${period}`;
  return ctx.db.$transaction(async (tx) => {
    const totals = await outstandingByBucket(tx);
    const requiredCents = requiredAllowanceCents(policy, openPrincipal(totals));
    const allowanceBeforeCents = await allowanceBalance(tx);
    const base = { period, requiredCents, allowanceBeforeCents };
    const done =
      (await findTransactionByKey(tx, key)) ??
      (await tx.jobRun.findFirst({
        where: { name: 'provision', ok: true, summary: { path: ['period'], equals: period } },
        select: { id: true },
      }));
    if (done) return { ...base, posted: false, alreadyPosted: true, changeCents: 0 };
    const changeCents = requiredCents - allowanceBeforeCents;
    if (changeCents === 0) return { ...base, posted: false, alreadyPosted: false, changeCents };
    const amountCents = Math.abs(changeCents);
    await postTransaction(tx, {
      description:
        changeCents > 0
          ? `Provision for credit losses ${period}`
          : `Release of allowance for credit losses ${period}`,
      effectiveDate: asOf,
      referenceType: 'provision',
      referenceId: period,
      idempotencyKey: key,
      entries:
        changeCents > 0
          ? [
              { accountCode: ACCOUNTS.PROVISION_EXPENSE, direction: 'DEBIT', amountCents },
              { accountCode: ACCOUNTS.ALLOWANCE, direction: 'CREDIT', amountCents },
            ]
          : [
              { accountCode: ACCOUNTS.ALLOWANCE, direction: 'DEBIT', amountCents },
              { accountCode: ACCOUNTS.PROVISION_EXPENSE, direction: 'CREDIT', amountCents },
            ],
    });
    ctx.log.info({ period, requiredCents, changeCents }, 'provision booked');
    return { ...base, posted: true, alreadyPosted: false, changeCents };
  });
}

/** The operator's view of delinquency and the loss accounts. Read only. */
export async function delinquencySummary(tx: Tx, asOf: IsoDate): Promise<DelinquencySummary> {
  const policy = ACTIVE_SERVICING_POLICY;
  const [
    totals,
    receivableCents,
    allowanceCents,
    provisionExpenseCents,
    recoveredCents,
    chargeOffs,
    heldPayouts,
    frozenPlans,
  ] = await Promise.all([
    outstandingByBucket(tx),
    receivablesBalance(tx),
    allowanceBalance(tx),
    accountBalance(tx, ACCOUNTS.PROVISION_EXPENSE),
    accountBalance(tx, ACCOUNTS.RECOVERY_INCOME),
    // Charge-offs to date are the debits charge-off postings made to the allowance.
    tx.ledgerEntry.aggregate({
      where: {
        direction: 'DEBIT',
        account: { code: ACCOUNTS.ALLOWANCE },
        transaction: { referenceType: 'charge_off' },
      },
      _sum: { amountCents: true },
    }),
    tx.landlordPayout.count({ where: { status: 'HELD' } }),
    tx.rentPlan.count({ where: { advanceFrozenAt: { not: null }, status: { not: 'CLOSED' } } }),
  ]);
  return {
    asOf,
    servicingPolicy: policy.name,
    buckets: DELINQUENCY_BUCKETS.map((status) => {
      const open = status !== 'CHARGED_OFF';
      return {
        status,
        plans: totals[status].plans,
        principalCents: totals[status].principalCents,
        provisionRateBps: open ? policy.provisionRatesBps[status] : null,
        requiredReserveCents: open
          ? reserveCents(policy, status, totals[status].principalCents)
          : 0,
      };
    }),
    receivableCents,
    allowanceCents,
    requiredAllowanceCents: requiredAllowanceCents(policy, openPrincipal(totals)),
    netReceivableCents: receivableCents - allowanceCents,
    provisionExpenseCents,
    chargedOffCents: chargeOffs._sum.amountCents ?? 0,
    chargedOffPlans: totals.CHARGED_OFF.plans,
    recoveredCents,
    heldPayouts,
    frozenPlans,
  };
}

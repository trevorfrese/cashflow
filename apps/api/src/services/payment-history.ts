import type {
  GraduationOffer as GraduationOfferDto,
  IsoDate,
  PaymentHistory as PaymentHistoryDto,
} from '@cashflow/shared';

import { clockNow } from '../dates.ts';
import type { Tx } from '../db.ts';
import { ACTIVE_SERVICING_POLICY } from '../servicing/policy.ts';
import {
  classifyFinancedPeriod,
  classifyPassThroughPeriod,
  EMPTY_PAYMENT_HISTORY,
  sortMonths,
  summarizePaymentHistory,
  type PaymentHistoryMonth,
  type PaymentHistorySummary,
} from '../underwriting/payment-history.ts';
import { CURRENT_POLICY, type CreditPolicy } from '../underwriting/policy.ts';

/**
 * The payment history record of a business, derived on every read.
 *
 * It is a view over facts the system already keeps for other reasons, not a table of its
 * own: financed months come from landlord payouts, installments and their repayments (a
 * returned debit is a repayment row marked RETURNED), and pass-through months from the
 * status of each pass-through period, which only the collection, settlement, payout and
 * return services set. Every one of those is written in the same transaction as the ledger
 * posting it records. A stored history would be a second copy of the same facts that could
 * drift from them; this cannot, and a returned payment stops counting as on time the moment
 * it is reconciled. The cost is a few queries per read, at most a few dozen rows a business.
 */

const dateOf = (d: Date | null): IsoDate | null => (d ? d.toISOString().slice(0, 10) : null);

/** Every month with an outcome, oldest first, on every plan the business has had. */
export async function paymentHistoryMonths(
  tx: Tx,
  businessId: string,
  asOf: IsoDate,
): Promise<PaymentHistoryMonth[]> {
  const policy = ACTIVE_SERVICING_POLICY;
  const [payouts, periods] = await Promise.all([
    tx.landlordPayout.findMany({
      where: { status: 'PAID', scheduledFor: { lte: asOf }, rentPlan: { businessId } },
      select: {
        rentPlanId: true,
        periodMonth: true,
        scheduledFor: true,
        installments: {
          select: {
            status: true,
            dueDate: true,
            paidAt: true,
            chargedOffAt: true,
            repayments: { where: { status: 'RETURNED' }, select: { id: true }, take: 1 },
          },
        },
      },
    }),
    tx.passThroughPeriod.findMany({
      where: { dueDate: { lte: asOf }, rentPlan: { businessId } },
      select: { rentPlanId: true, periodMonth: true, dueDate: true, status: true },
    }),
  ]);
  const months: PaymentHistoryMonth[] = [];
  for (const p of payouts) {
    const outcome = classifyFinancedPeriod(
      p.installments.map((i) => ({
        status: i.status,
        dueDate: i.dueDate,
        paidOn: dateOf(i.paidAt),
        chargedOff: i.chargedOffAt !== null,
        returned: i.repayments.length > 0,
      })),
      asOf,
      policy.lateGraceDays,
      policy.defaultAfterDays,
    );
    if (outcome) {
      months.push({
        rentPlanId: p.rentPlanId,
        kind: 'FINANCED',
        periodMonth: p.periodMonth,
        dueDate: p.scheduledFor,
        outcome,
      });
    }
  }
  for (const p of periods) {
    const outcome = classifyPassThroughPeriod(p.status);
    if (outcome) {
      months.push({
        rentPlanId: p.rentPlanId,
        kind: 'PASS_THROUGH',
        periodMonth: p.periodMonth,
        dueDate: p.dueDate,
        outcome,
      });
    }
  }
  return sortMonths(months);
}

/** The summary the scorecard reads. Empty (neutral) for a business with no history. */
export async function paymentHistorySummary(
  tx: Tx,
  businessId: string,
  asOf: IsoDate,
  policy: CreditPolicy = CURRENT_POLICY,
): Promise<PaymentHistorySummary> {
  if (!policy.paymentHistory) return EMPTY_PAYMENT_HISTORY;
  const months = await paymentHistoryMonths(tx, businessId, asOf);
  return summarizePaymentHistory(months, asOf, policy.paymentHistory.lookbackMonths);
}

/** The view `GET /v1/businesses/:id/payment-history` and the ops console return. */
export async function paymentHistoryView(
  tx: Tx,
  businessId: string,
  asOf: IsoDate,
  graduationOffer: GraduationOfferDto | null,
): Promise<PaymentHistoryDto> {
  const policy = CURRENT_POLICY;
  const lookbackMonths = policy.paymentHistory?.lookbackMonths ?? 12;
  const months = await paymentHistoryMonths(tx, businessId, asOf);
  const summary = summarizePaymentHistory(months, asOf, lookbackMonths);
  const passThrough = await tx.rentPlan.findFirst({
    where: { businessId, kind: 'PASS_THROUGH', status: { not: 'CLOSED' } },
    select: { id: true },
  });
  const needed = policy.graduation?.minOnTimeMonths ?? null;
  return {
    businessId,
    asOf,
    lookbackMonths,
    summary,
    months: [...months].reverse(),
    monthsUntilReview:
      passThrough && needed !== null ? Math.max(0, needed - summary.currentOnTimeStreak) : null,
    graduationOffer,
    generatedAt: clockNow().toISOString(),
  };
}

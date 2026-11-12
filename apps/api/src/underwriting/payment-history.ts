import { addDays, type IsoDate } from '@cashflow/shared';

/**
 * Payment history: how a business has paid its rent through CashFlow, month by month, on
 * either kind of plan. Pure. The service (`src/services/payment-history.ts`) reads the
 * repayment and pass-through facts from the database and hands them here; nothing in a
 * month's outcome is entered by hand.
 *
 *   ON_TIME  Financed: every installment of the period collected inside grace, and no
 *            payment on it ever came back. Pass-through: the rent was collected, settled,
 *            and paid to the landlord.
 *   LATE     Financed only: everything was paid in the end, but something was paid after
 *            grace or was returned and collected again.
 *   MISSED   Financed: written off, or an installment 30 or more days past due.
 *            Pass-through: nothing could be collected in time, or the collection came back.
 *
 * A month still in progress has no outcome yet and is left out. So is a month in which
 * nothing was owed: a payout that was never made, a pass-through month refunded because the
 * landlord payout was held, or a month cancelled before collection.
 */

export type PaymentMonthOutcome = 'ON_TIME' | 'LATE' | 'MISSED';
export type PaymentPlanKind = 'FINANCED' | 'PASS_THROUGH';

export interface PaymentHistoryMonth {
  rentPlanId: string;
  kind: PaymentPlanKind;
  /** YYYY-MM */
  periodMonth: string;
  /** The rent due date of the month. */
  dueDate: IsoDate;
  outcome: PaymentMonthOutcome;
}

export interface PaymentHistorySummary {
  /** Months with an outcome, inside the lookback. */
  months: number;
  onTimeMonths: number;
  lateMonths: number;
  missedMonths: number;
  /** On time months in a row, counting back from the most recent month with an outcome. */
  currentOnTimeStreak: number;
  /** The most recent missed month, YYYY-MM, or null. */
  lastMissedPeriod: string | null;
}

export const EMPTY_PAYMENT_HISTORY: PaymentHistorySummary = {
  months: 0,
  onTimeMonths: 0,
  lateMonths: 0,
  missedMonths: 0,
  currentOnTimeStreak: 0,
  lastMissedPeriod: null,
};

/** Facts about one installment of a financed period. */
export interface InstallmentFacts {
  status: 'SCHEDULED' | 'PAID' | 'FAILED' | 'LATE' | 'CHARGED_OFF' | 'VOIDED';
  dueDate: IsoDate;
  /** The calendar date it was paid, or null. */
  paidOn: IsoDate | null;
  chargedOff: boolean;
  /** A payment on it came back from the bank at some point. */
  returned: boolean;
}

/**
 * The outcome of a financed period whose landlord payout was made, or null while it is
 * still open (and not yet late) or when nothing was owed. `graceDays` and `missedAfterDays`
 * come from the servicing policy: late after grace, missed at the bad threshold.
 */
export function classifyFinancedPeriod(
  installments: readonly InstallmentFacts[],
  asOf: IsoDate,
  graceDays: number,
  missedAfterDays: number,
): PaymentMonthOutcome | null {
  const owed = installments.filter((i) => i.status !== 'VOIDED');
  if (owed.length === 0) return null;
  let late = false;
  let open = false;
  for (const i of owed) {
    if (i.chargedOff) return 'MISSED';
    if (i.status === 'PAID' && i.paidOn !== null) {
      if (i.paidOn > addDays(i.dueDate, graceDays) || i.returned) late = true;
      continue;
    }
    // Unpaid.
    if (asOf >= addDays(i.dueDate, missedAfterDays)) return 'MISSED';
    if (asOf > addDays(i.dueDate, graceDays)) late = true;
    else open = true;
  }
  if (late) return 'LATE';
  return open ? null : 'ON_TIME';
}

export type PassThroughPeriodState =
  | 'SCHEDULED'
  | 'COLLECTING'
  | 'SETTLED'
  | 'PAID'
  | 'MISSED'
  | 'REFUNDED'
  | 'RETURNED_AFTER_PAYOUT'
  | 'CANCELLED';

/** The outcome of a pass-through month, or null while in progress or when nothing was owed. */
export function classifyPassThroughPeriod(
  status: PassThroughPeriodState,
): PaymentMonthOutcome | null {
  if (status === 'PAID') return 'ON_TIME';
  if (status === 'MISSED' || status === 'RETURNED_AFTER_PAYOUT') return 'MISSED';
  return null;
}

/** Order months oldest first, by due date and then plan id. */
export function sortMonths(months: readonly PaymentHistoryMonth[]): PaymentHistoryMonth[] {
  return [...months].sort((a, b) =>
    a.dueDate === b.dueDate
      ? a.rentPlanId < b.rentPlanId
        ? -1
        : 1
      : a.dueDate < b.dueDate
        ? -1
        : 1,
  );
}

/**
 * Summarize months with an outcome. Only months whose due date is inside `lookbackMonths`
 * of `asOf` count toward the totals, so an old miss stops weighing on a business that has
 * paid on time since. The streak is read from the most recent month back.
 */
export function summarizePaymentHistory(
  months: readonly PaymentHistoryMonth[],
  asOf: IsoDate,
  lookbackMonths: number,
): PaymentHistorySummary {
  const from = addDays(asOf, -Math.round(lookbackMonths * 30.44));
  const inWindow = sortMonths(months).filter((m) => m.dueDate >= from && m.dueDate <= asOf);
  let streak = 0;
  for (let i = inWindow.length - 1; i >= 0; i--) {
    if (inWindow[i]!.outcome !== 'ON_TIME') break;
    streak += 1;
  }
  const missed = inWindow.filter((m) => m.outcome === 'MISSED');
  return {
    months: inWindow.length,
    onTimeMonths: inWindow.filter((m) => m.outcome === 'ON_TIME').length,
    lateMonths: inWindow.filter((m) => m.outcome === 'LATE').length,
    missedMonths: missed.length,
    currentOnTimeStreak: streak,
    lastMissedPeriod: missed.length > 0 ? missed[missed.length - 1]!.periodMonth : null,
  };
}

/**
 * The payment history factor of the scorecard (policy version 4). A run of on time months
 * through CashFlow adds points, late and missed months in the lookback take points away.
 * See `apps/api/UNDERWRITING.md`, "Payment history".
 */
export interface PaymentHistoryPolicy {
  /** Months of history that count. */
  lookbackMonths: number;
  /** Points for each on time month in the current run. */
  pointsPerOnTimeMonth: number;
  /** Most points the run can add. */
  maxBonusPoints: number;
  /** Points taken for each late month in the lookback. */
  latePenaltyPoints: number;
  /** Points taken for each missed month in the lookback. */
  missPenaltyPoints: number;
  /** Most points late and missed months together can take. */
  maxPenaltyPoints: number;
}

export interface PaymentHistoryFactor {
  /** Signed: positive helps, negative hurts. Zero with no history. */
  points: number;
  maxPoints: number;
  impact: 'POSITIVE' | 'NEGATIVE' | 'INFO';
  message: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Points from a payment history summary. Null when there is no history: the factor is
 * neutral, so a first time applicant is scored exactly as before version 4.
 */
export function paymentHistoryFactor(
  summary: PaymentHistorySummary | null,
  policy: PaymentHistoryPolicy,
): PaymentHistoryFactor | null {
  if (!summary || summary.months === 0) return null;
  const bonus = Math.min(
    policy.maxBonusPoints,
    summary.currentOnTimeStreak * policy.pointsPerOnTimeMonth,
  );
  const penalty = Math.min(
    policy.maxPenaltyPoints,
    summary.lateMonths * policy.latePenaltyPoints + summary.missedMonths * policy.missPenaltyPoints,
  );
  const points = bonus - penalty;
  const parts: string[] = [];
  if (summary.currentOnTimeStreak > 0) {
    parts.push(
      `${plural(summary.currentOnTimeStreak, 'month')} in a row of rent paid on time through CashFlow`,
    );
  }
  if (summary.missedMonths > 0) parts.push(`${plural(summary.missedMonths, 'missed month')}`);
  if (summary.lateMonths > 0) parts.push(`${plural(summary.lateMonths, 'late month')}`);
  const message =
    parts.length > 0
      ? `Payment history with CashFlow: ${parts.join(', ')} in the last ${policy.lookbackMonths} months.`
      : 'Payment history with CashFlow: no on time months in a row yet.';
  return {
    points,
    maxPoints: policy.maxBonusPoints,
    impact: points > 0 ? 'POSITIVE' : points < 0 ? 'NEGATIVE' : 'INFO',
    message,
  };
}

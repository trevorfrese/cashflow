import type { CashFlowSummary, CreditGrade, DecisionReason } from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS as PLATFORM_LABEL, formatCents } from '@cashflow/shared';

import type { DepthCredit } from '../veracity/assess.ts';
import {
  paymentHistoryFactor,
  type PaymentHistoryFactor,
  type PaymentHistorySummary,
} from './payment-history.ts';
import { CURRENT_POLICY, type CreditPolicy } from './policy.ts';

/**
 * Transparent scorecard. Each factor maps one feature onto points through a piecewise
 * linear curve. Weights sum to 100, so the score is a percentage of the best possible
 * profile. Every factor also yields a reason so the applicant can see what helped and
 * what hurt.
 *
 * The weights and grade floors come from the credit policy (`policy.ts`). The curves below
 * are drawn for the version 1 weights; under another policy each factor is scaled to its
 * weight.
 */

export interface Factor {
  code: string;
  label: string;
  points: number;
  maxPoints: number;
  impact: DecisionReason['impact'];
  message: string;
}

export interface Scorecard {
  score: number;
  grade: CreditGrade;
  factors: Factor[];
  /**
   * The score before the payment history factor: the eight cash flow factors alone. Equal
   * to `score` without history. Escalation reads this one, so payment history can never
   * send an application to a reviewer that would not have gone without it.
   */
  baseScore: number;
  /** The payment history factor, or null when the policy has none or there is no history. */
  paymentHistory: PaymentHistoryFactor | null;
}

/** Piecewise linear interpolation over sorted [x, y] breakpoints, clamped at the ends. */
export function curve(value: number, points: ReadonlyArray<readonly [number, number]>): number {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x0, y0] = points[i - 1]!;
    if (value <= x1) return y0 + ((value - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
}

/** Weights and grade floors of the current policy. */
export const WEIGHTS = CURRENT_POLICY.weights;
export const GRADE_FLOORS = CURRENT_POLICY.gradeFloors;

/** Points each curve below tops out at. A policy weight is applied as a scale on these. */
const CURVE_MAX = {
  rentAffordability: 20,
  cashFlowCoverage: 20,
  cashBuffer: 15,
  accountConduct: 15,
  revenueStability: 10,
  revenueTrend: 10,
  debtLoad: 5,
  dataDepth: 5,
} as const;

export function gradeFor(score: number, policy: CreditPolicy = CURRENT_POLICY): CreditGrade {
  return policy.gradeFloors.find(([, floor]) => score >= floor)![0];
}

function pct(bpsValue: number): string {
  return `${(bpsValue / 100).toFixed(bpsValue % 100 === 0 ? 0 : 1)}%`;
}

function impactFor(points: number, max: number): DecisionReason['impact'] {
  if (points >= max * 0.7) return 'POSITIVE';
  if (points <= max * 0.4) return 'NEGATIVE';
  return 'INFO';
}

export function scoreCashFlow(
  s: CashFlowSummary,
  policy: CreditPolicy = CURRENT_POLICY,
  /** From the veracity assessment. Read by scorecard 3 only. */
  depth: DepthCredit | null = null,
  /** Rent paid through CashFlow so far. Read only under a policy with `paymentHistory`. */
  history: PaymentHistorySummary | null = null,
): Scorecard {
  const factors: Factor[] = [];
  const add = (
    code: string,
    label: string,
    rawOnCurve: number,
    factor: keyof typeof CURVE_MAX,
    message: string,
  ) => {
    const max = policy.weights[factor];
    const scale = max / CURVE_MAX[factor];
    const raw = scale === 1 ? rawOnCurve : rawOnCurve * scale;
    const points = Math.round(Math.min(max, Math.max(0, raw)));
    factors.push({ code, label, points, maxPoints: max, impact: impactFor(points, max), message });
  };

  const v2 = policy.scorecard >= 2;

  // 1. Rent as a share of verified revenue (payment to income).
  const rentPct = s.rentToRevenueBps;
  add(
    'RENT_TO_REVENUE',
    'Rent affordability',
    curve(rentPct, [
      [1000, 20],
      [1500, 16],
      [2000, 12],
      [2500, 7],
      [3000, 3],
      [3500, 0],
    ]),
    'rentAffordability',
    `Requested rent is ${pct(rentPct)} of verified monthly revenue (${formatCents(s.verifiedMonthlyRevenueCents, { showCents: false })}).`,
  );

  // 2. Free cash flow coverage of rent plus fee.
  const cov = s.rentCoverageRatio;
  add(
    'CASH_FLOW_COVERAGE',
    'Cash flow coverage',
    curve(cov, [
      [100, 0],
      [125, 10],
      [150, 15],
      [200, 20],
    ]),
    'cashFlowCoverage',
    cov > 0
      ? cov < 100
        ? `Free cash flow covers only ${Math.round(cov)}% of the monthly ${policy.scoredCoverageFeeBps > 0 ? 'rent and fee' : 'rent'}.`
        : `Free cash flow covers the monthly ${policy.scoredCoverageFeeBps > 0 ? 'rent and fee' : 'rent'} ${(cov / 100).toFixed(2)} times.`
      : 'Monthly outflows currently exceed inflows, leaving no free cash flow for rent.',
  );

  // 3. Cash buffer in days of outflows. Version 2 blends in the low point of the last 90
  // days (40% of the factor): a debit fails on the day the balance is short, so the lowest
  // the balance has been says more about that risk than where it happens to stand today.
  const days = s.daysOfCashOnHand;
  const low = s.lowPointDaysOfCash90 ?? null;
  const todayPoints =
    days === null
      ? 0
      : curve(days, [
          [7, 0],
          [14, 6],
          [30, 11],
          [60, 15],
        ]);
  const lowPoints =
    low === null
      ? 0
      : curve(low, [
          [0, 0],
          [5, 6],
          [15, 11],
          [30, 15],
        ]);
  add(
    'CASH_BUFFER',
    'Cash buffer',
    v2 ? 0.6 * todayPoints + 0.4 * lowPoints : todayPoints,
    'cashBuffer',
    days === null
      ? 'Current balance was not available, so no cash buffer could be verified.'
      : `${days} ${days === 1 ? 'day' : 'days'} of operating expenses on hand (${formatCents(s.currentBalanceCents ?? 0, { showCents: false })})${
          v2 && low !== null
            ? low <= 0
              ? ', and the balance ran out at least once in the last 90 days'
              : `, and never fewer than ${low} ${low === 1 ? 'day' : 'days'} in the last 90 days`
            : ''
        }.`,
  );

  // 4. Account conduct: overdrafts and negative balance days in the last 90 days. Version 2
  // also takes a point for each overdraft fee earlier in the year.
  const olderNsf = v2 ? Math.max(0, s.nsfCount365 - s.nsfCount90) : 0;
  const conductPenalty = s.nsfCount90 * 6 + s.negativeBalanceDays90 * 1.5 + olderNsf;
  add(
    'ACCOUNT_CONDUCT',
    'Account conduct',
    CURVE_MAX.accountConduct - conductPenalty,
    'accountConduct',
    s.nsfCount90 === 0 && s.negativeBalanceDays90 === 0 && olderNsf === 0
      ? 'No overdrafts or negative balance days in the last 90 days.'
      : `${s.nsfCount90} overdraft fee${s.nsfCount90 === 1 ? '' : 's'} and ${s.negativeBalanceDays90} negative balance day${s.negativeBalanceDays90 === 1 ? '' : 's'} in the last 90 days${
          olderNsf > 0
            ? `, and ${olderNsf} overdraft fee${olderNsf === 1 ? '' : 's'} earlier in the year`
            : ''
        }.`,
  );

  // 5. Revenue stability: coefficient of variation of monthly revenue.
  const vol = s.revenueVolatilityBps;
  add(
    'REVENUE_STABILITY',
    'Revenue stability',
    s.monthsOfHistory < 3
      ? 0
      : curve(vol, [
          [1500, 10],
          [2500, 7],
          [3500, 4],
          [5000, 1],
          [6000, 0],
        ]),
    'revenueStability',
    s.monthsOfHistory < 3
      ? 'Not enough months to measure revenue stability.'
      : `Monthly ${s.commerce ? 'sales' : 'revenue'} ${s.commerce ? 'vary' : 'varies'} by ${pct(vol)} around the average${s.commerce ? `, measured from ${PLATFORM_LABEL[s.commerce.platform]}` : ''}.`,
  );

  // 6. Revenue trend. Version 1 reads the last three full months against the prior three.
  // From version 2 it reads the season adjusted composite, so a seasonal trough costs
  // nothing and a real decline is seen sooner.
  const composite = v2 && s.revenueTrend != null;
  const growth = composite ? s.revenueTrend!.compositeBps : s.revenueGrowthBps;
  add(
    'REVENUE_TREND',
    'Revenue trend',
    s.monthsOfHistory < 6
      ? 5
      : curve(growth, [
          [-3000, 0],
          [-2500, 1],
          [-1000, 4],
          [0, 7],
          [1000, 10],
        ]),
    'revenueTrend',
    s.monthsOfHistory < 6
      ? 'Less than six months of history, so the trend is treated as flat.'
      : composite
        ? trendMessage(s)
        : `Revenue over the last three months is ${growth >= 0 ? 'up' : 'down'} ${pct(Math.abs(growth))} versus the prior three.`,
  );

  // 7. Existing debt service as a share of revenue.
  const debt = s.debtToRevenueBps;
  add(
    'DEBT_LOAD',
    'Existing debt',
    curve(debt, [
      [300, 5],
      [800, 3],
      [1500, 1],
      [2000, 0],
    ]),
    'debtLoad',
    debt === 0
      ? 'No loan or merchant cash advance payments detected.'
      : `Existing loan and advance payments take ${pct(debt)} of monthly revenue (${formatCents(s.monthlyDebtServiceCents, { showCents: false })} a month).`,
  );

  // 8. Depth and breadth of data: months of bank history, plus a point for a second
  // source (a point of sale) that verifies sales independently of deposits. Scorecard 3
  // scales the bank credit by the bank's trust tier and gives the second source point only
  // to a platform the veracity checks found independently verified (its payouts reconcile).
  const posMonths = s.commerce?.monthsOfHistory ?? 0;
  const v3 = policy.scorecard >= 3 && depth !== null;
  const bankCredit =
    curve(s.monthsOfHistory, [
      [3, 0],
      [6, 1.5],
      [9, 3],
      [12, 4],
    ]) * (v3 ? depth.bankMultiplier : 1);
  const second = v3 ? depth.verifiedSecondSource && posMonths >= 3 : posMonths >= 3;
  add(
    'DATA_DEPTH',
    'Data history',
    bankCredit + (second ? 1 : 0),
    'dataDepth',
    `${s.monthsOfHistory} month${s.monthsOfHistory === 1 ? '' : 's'} of bank history reviewed${
      second
        ? `, plus ${posMonths} month${posMonths === 1 ? '' : 's'} of ${PLATFORM_LABEL[s.commerce!.platform]} sales${v3 ? ' that match your bank deposits' : ''}.`
        : v3 && posMonths >= 3
          ? `. Your ${PLATFORM_LABEL[s.commerce!.platform]} sales could not be matched to your connected bank deposits, so they were not counted as a second source.`
          : '. Connecting your point of sale adds a second source.'
    }`,
  );

  const baseScore = Math.min(
    100,
    Math.max(
      0,
      factors.reduce((sum, f) => sum + f.points, 0),
    ),
  );

  // 9. Payment history through CashFlow (version 4). Outside the eight weights: it adds or
  // takes points on top of them, and is absent, not zero, with no history, so a first time
  // applicant is scored exactly as under version 3.
  const ph = policy.paymentHistory ? paymentHistoryFactor(history, policy.paymentHistory) : null;
  if (ph) {
    factors.push({
      code: 'PAYMENT_HISTORY',
      label: 'Payment history',
      points: ph.points,
      maxPoints: ph.maxPoints,
      impact: ph.impact,
      message: ph.message,
    });
  }
  const score = Math.min(100, Math.max(0, baseScore + (ph?.points ?? 0)));
  return { score, grade: gradeFor(score, policy), factors, baseScore, paymentHistory: ph };
}

function trendMessage(s: CashFlowSummary): string {
  const t = s.revenueTrend!;
  const growth = t.compositeBps;
  const direction = growth >= 0 ? 'up' : 'down';
  if (t.yearOverYearBps !== null) {
    return `Revenue over the last four weeks is ${direction} ${pct(Math.abs(growth))} on the same weeks a year ago.`;
  }
  if (t.recent12VsPrior12WeeksBps !== null) {
    return `Revenue over the last twelve weeks is ${direction} ${pct(Math.abs(growth))} versus the twelve before.`;
  }
  return `Revenue over the last three months is ${direction} ${pct(Math.abs(growth))} versus the prior three.`;
}

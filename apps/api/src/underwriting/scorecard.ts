import type { CashFlowSummary, CreditGrade, DecisionReason } from '@cashflow/shared';
import { formatCents } from '@cashflow/shared';

/**
 * Transparent scorecard. Each factor maps one feature onto points through a piecewise
 * linear curve. Weights sum to 100, so the score is a percentage of the best possible
 * profile. Every factor also yields a reason so the applicant can see what helped and
 * what hurt.
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

export const WEIGHTS = {
  rentAffordability: 20,
  cashFlowCoverage: 20,
  cashBuffer: 15,
  accountConduct: 15,
  revenueStability: 10,
  revenueTrend: 10,
  debtLoad: 5,
  historyDepth: 5,
} as const;

export const GRADE_FLOORS: ReadonlyArray<readonly [CreditGrade, number]> = [
  ['A', 80],
  ['B', 68],
  ['C', 55],
  ['D', 45],
  ['F', 0],
];

export function gradeFor(score: number): CreditGrade {
  return GRADE_FLOORS.find(([, floor]) => score >= floor)![0];
}

function pct(bpsValue: number): string {
  return `${(bpsValue / 100).toFixed(bpsValue % 100 === 0 ? 0 : 1)}%`;
}

function impactFor(points: number, max: number): DecisionReason['impact'] {
  if (points >= max * 0.7) return 'POSITIVE';
  if (points <= max * 0.4) return 'NEGATIVE';
  return 'INFO';
}

export function scoreCashFlow(s: CashFlowSummary): Scorecard {
  const factors: Factor[] = [];
  const add = (code: string, label: string, raw: number, max: number, message: string) => {
    const points = Math.round(Math.min(max, Math.max(0, raw)));
    factors.push({ code, label, points, maxPoints: max, impact: impactFor(points, max), message });
  };

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
    WEIGHTS.rentAffordability,
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
    WEIGHTS.cashFlowCoverage,
    cov > 0
      ? `Free cash flow covers rent and fee ${(cov / 100).toFixed(2)} times over.`
      : 'Monthly outflows currently exceed inflows, leaving no free cash flow for rent.',
  );

  // 3. Cash buffer in days of operating outflows.
  const days = s.daysOfCashOnHand;
  add(
    'CASH_BUFFER',
    'Cash buffer',
    days === null
      ? 0
      : curve(days, [
          [7, 0],
          [14, 6],
          [30, 11],
          [60, 15],
        ]),
    WEIGHTS.cashBuffer,
    days === null
      ? 'Current balance was not available, so no cash buffer could be verified.'
      : `${days} days of operating expenses on hand (${formatCents(s.currentBalanceCents ?? 0, { showCents: false })}).`,
  );

  // 4. Account conduct: overdrafts and negative balance days in the last 90 days.
  const conductPenalty = s.nsfCount90 * 6 + s.negativeBalanceDays90 * 1.5;
  add(
    'ACCOUNT_CONDUCT',
    'Account conduct',
    WEIGHTS.accountConduct - conductPenalty,
    WEIGHTS.accountConduct,
    s.nsfCount90 === 0 && s.negativeBalanceDays90 === 0
      ? 'No overdrafts or negative balance days in the last 90 days.'
      : `${s.nsfCount90} overdraft fee${s.nsfCount90 === 1 ? '' : 's'} and ${s.negativeBalanceDays90} negative balance day${s.negativeBalanceDays90 === 1 ? '' : 's'} in the last 90 days.`,
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
    WEIGHTS.revenueStability,
    s.monthsOfHistory < 3
      ? 'Not enough months to measure revenue stability.'
      : `Monthly revenue varies by ${pct(vol)} around its average.`,
  );

  // 6. Revenue trend: last three months versus the prior three.
  const growth = s.revenueGrowthBps;
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
    WEIGHTS.revenueTrend,
    s.monthsOfHistory < 6
      ? 'Less than six months of history, so the trend is treated as flat.'
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
    WEIGHTS.debtLoad,
    debt === 0
      ? 'No loan or merchant cash advance payments detected.'
      : `Existing loan and advance payments take ${pct(debt)} of monthly revenue (${formatCents(s.monthlyDebtServiceCents, { showCents: false })} a month).`,
  );

  // 8. Depth of bank history available.
  add(
    'HISTORY_DEPTH',
    'Bank history',
    curve(s.monthsOfHistory, [
      [3, 0],
      [6, 2],
      [9, 4],
      [12, 5],
    ]),
    WEIGHTS.historyDepth,
    `${s.monthsOfHistory} month${s.monthsOfHistory === 1 ? '' : 's'} of bank history reviewed.`,
  );

  const score = Math.min(
    100,
    Math.max(
      0,
      factors.reduce((sum, f) => sum + f.points, 0),
    ),
  );
  return { score, grade: gradeFor(score), factors };
}

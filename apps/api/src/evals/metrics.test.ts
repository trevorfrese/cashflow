import { describe, expect, it } from 'vitest';

import { makeCustomer } from './fixtures.ts';
import {
  computeMetrics,
  customerNetMarginCents,
  gradeInversions,
  rankOrdering,
  scoreBand,
  segmentMetrics,
  swapSet,
} from './metrics.ts';
import type { CustomerResult, PortfolioResult } from './portfolio.ts';

const COSTS = { costOfFundsAprBps: 1200, servicingCostCentsPerPlanMonth: 1200 };

/**
 * A portfolio small enough to do by hand.
 *
 * Good: two $1,000 periods at a 2% fee. $1,000 is out for 14 days each period.
 *   fees 4,000. Cost of funds 2,800,000 cent-days * 12% / 365 = 920.5 -> 921.
 *   Servicing 2 * 1,200 = 2,400. Net margin 4,000 - 921 - 2,400 = 679.
 * Bad: one $1,000 period at 2%. The first half is repaid, the second $500 is written off
 *   after sitting for 100 days, with a 10% recovery.
 *   fees 1,000. Cost of funds 5,000,000 * 12% / 365 = 1,643.8 -> 1,644. Servicing 1,200.
 *   Net loss 50,000 - 5,000 = 45,000. Net margin 1,000 - 1,644 - 1,200 - 45,000 = -46,844.
 */
const good = makeCustomer({
  applicantId: 'good',
  score: 85,
  grade: 'A',
  payoutCount: 2,
  payoutCents: 200_000,
  principalCollectedCents: 200_000,
  feesCollectedCents: 4_000,
  outstandingCentDays: 2_800_000,
});
const bad = makeCustomer({
  applicantId: 'bad',
  score: 50,
  grade: 'D',
  industry: 'retail',
  payoutCount: 1,
  payoutCents: 100_000,
  principalCollectedCents: 50_000,
  feesCollectedCents: 1_000,
  chargedOffCents: 50_000,
  recoveredCents: 5_000,
  outstandingCentDays: 5_000_000,
  bad: true,
  firstPaymentDefault: true,
});
const declined = makeCustomer({
  applicantId: 'declined',
  outcome: 'DECLINED',
  score: 30,
  grade: 'F',
  feeBps: null,
});
const needsInfo = makeCustomer({
  applicantId: 'needs-info',
  outcome: 'NEEDS_INFO',
  score: null,
  grade: null,
  feeBps: null,
  fraud: 'inflated_revenue',
  segment: 'inflated_revenue',
});

function portfolio(customers: CustomerResult[], label = 'base'): PortfolioResult {
  return {
    label,
    servicingPolicy: 'baseline',
    stress: 'base',
    horizonMonths: 12,
    poolStartCents: 1_000_000,
    poolEndCents: 960_000,
    poolMinCents: 800_000,
    unfundedPayouts: 0,
    unfundedPayoutDays: 0,
    pool: [
      {
        month: '2026-02',
        payoutsCents: 300_000,
        collectedCents: 255_000,
        minPoolCents: 800_000,
        endPoolCents: 960_000,
        endReceivableCents: 0,
        peakUtilizationBps: 2000,
        activePlans: 2,
      },
    ],
    customers,
  };
}

describe('metrics arithmetic', () => {
  it('computes one customer by hand', () => {
    expect(customerNetMarginCents(good, COSTS)).toBe(679);
    expect(customerNetMarginCents(bad, COSTS)).toBe(-46_844);
    expect(customerNetMarginCents(declined, COSTS)).toBe(0);
  });

  it('computes the portfolio by hand', () => {
    const m = segmentMetrics([good, bad, declined, needsInfo], COSTS);
    expect(m).toMatchObject({
      applicants: 4,
      approved: 2,
      declined: 1,
      needsInfo: 1,
      approvalRateBps: 5000,
      plans: 2,
      planMonths: 3,
      volumeCents: 300_000,
      feeIncomeCents: 5_000,
      costOfFundsCents: 2_565,
      servicingCostCents: 3_600,
      chargeOffCents: 50_000,
      recoveryCents: 5_000,
      netLossCents: 45_000,
      netLossBps: 1500,
      netMarginCents: -46_165,
      netMarginBps: -1539,
      bad: 1,
      badRateBps: 5000,
      firstPaymentDefaultRateBps: 5000,
      profitableShareBps: 5000,
    });
  });

  it('handles an empty group without dividing by zero', () => {
    const m = segmentMetrics([], COSTS);
    expect(m.approvalRateBps).toBe(0);
    expect(m.netLossBps).toBe(0);
    expect(m.netMarginBps).toBe(0);
    expect(m.badRateBps).toBe(0);
  });

  it('cuts by grade, score band, segment, and industry, and reports fraud and the pool', () => {
    const m = computeMetrics(portfolio([good, bad, declined, needsInfo]), COSTS);
    expect(m.declineRateBps).toBe(2500);
    expect(m.needsInfoRateBps).toBe(2500);
    expect(m.byGrade.A?.netMarginCents).toBe(679);
    expect(m.byGrade.D?.netLossCents).toBe(45_000);
    expect(m.byGrade.F?.plans).toBe(0);
    expect(m.byScoreBand['85-100']?.plans).toBe(1);
    expect(m.byScoreBand['45-54']?.badRateBps).toBe(10_000);
    expect(m.bySegment.inflated_revenue?.applicants).toBe(1);
    expect(m.fraud).toMatchObject({ applicants: 1, approved: 0, approvalRateBps: 0 });
    expect(m.honest.applicants).toBe(3);
    // Volume: restaurant 200,000 of 300,000, retail 100,000.
    expect(m.concentration).toEqual({ topShareBps: 6667, topIndustry: 'restaurant', hhi: 5556 });
    expect(m.pool).toMatchObject({
      minCents: 800_000,
      peakUtilizationBps: 2000,
      peakMonthlyPayoutsCents: 300_000,
      everUnableToFund: false,
    });
  });

  it('bands scores at the grade style boundaries', () => {
    expect([44, 45, 54, 55, 74, 75, 85, 100].map(scoreBand)).toEqual([
      '0-44',
      '45-54',
      '45-54',
      '55-64',
      '65-74',
      '75-84',
      '85-100',
      '85-100',
    ]);
  });
});

describe('rank ordering', () => {
  const plan = (score: number, isBad: boolean) =>
    makeCustomer({ score, bad: isBad, payoutCount: 1, payoutCents: 100_000 });

  it('is perfect when every good outscores every bad', () => {
    const r = rankOrdering([plan(90, false), plan(80, false), plan(60, true), plan(50, true)]);
    expect(r).toEqual({ auc: 1, ks: 1, goods: 2, bads: 2 });
  });

  it('is 0.5 when scores carry no information, and counts ties as half', () => {
    expect(rankOrdering([plan(70, false), plan(70, true)]).auc).toBe(0.5);
    // Goods 90, 60. Bads 80, 60. Pairs won: 90>80, 90>60, 60=60 (half), 60<80 -> 2.5 of 4.
    const r = rankOrdering([plan(90, false), plan(60, false), plan(80, true), plan(60, true)]);
    expect(r.auc).toBe(0.625);
    expect(r.ks).toBe(0.5);
  });

  it('is undefined without both goods and bads, and ignores unfunded applicants', () => {
    expect(rankOrdering([plan(90, false)]).auc).toBeNull();
    expect(rankOrdering([plan(90, false), declined]).bads).toBe(0);
  });
});

describe('grade monotonicity', () => {
  const book = (rates: Record<string, [plans: number, bads: number]>) => {
    const customers: CustomerResult[] = [];
    for (const [grade, [plans, bads]] of Object.entries(rates)) {
      for (let i = 0; i < plans; i++) {
        customers.push(
          makeCustomer({
            applicantId: `${grade}${i}`,
            grade: grade as 'A',
            payoutCount: 1,
            payoutCents: 100_000,
            bad: i < bads,
          }),
        );
      }
    }
    return computeMetrics(portfolio(customers), COSTS);
  };

  it('counts no inversion when bad rates rise from A to D', () => {
    expect(
      gradeInversions(book({ A: [100, 2], B: [100, 5], C: [100, 9], D: [100, 20] }), 30, 100),
    ).toBe(0);
  });

  it('counts an inversion beyond the tolerance and forgives one inside it', () => {
    expect(gradeInversions(book({ A: [100, 8], B: [100, 5], C: [100, 9] }), 30, 100)).toBe(1);
    expect(gradeInversions(book({ A: [100, 6], B: [100, 5], C: [100, 9] }), 30, 100)).toBe(0);
  });

  it('skips cells too small to judge', () => {
    // D has 10 plans and no bads: ignored, so A to C is still monotonic.
    expect(
      gradeInversions(book({ A: [100, 2], B: [100, 5], C: [100, 9], D: [10, 0] }), 30, 100),
    ).toBe(0);
    expect(
      gradeInversions(book({ A: [100, 2], B: [100, 5], C: [100, 9], D: [40, 0] }), 30, 100),
    ).toBe(1);
  });
});

describe('swap set', () => {
  it('finds who each policy approves that the other does not, with their outcomes', () => {
    const champion = portfolio([good, bad, declined]);
    const challenger = portfolio(
      [
        good,
        { ...bad, outcome: 'DECLINED', payoutCount: 0, payoutCents: 0, bad: false },
        { ...declined, outcome: 'APPROVED', payoutCount: 1, payoutCents: 100_000, bad: true },
      ],
      'challenger',
    );
    const s = swapSet(champion, challenger, COSTS);
    expect(s.bothApproved).toBe(1);
    expect(s.neitherApproved).toBe(0);
    expect(s.swapOut).toEqual({ count: 1, plans: 1, badRateBps: 10_000, netMarginCents: -46_844 });
    expect(s.swapIn).toMatchObject({ count: 1, plans: 1, badRateBps: 10_000 });
  });
});

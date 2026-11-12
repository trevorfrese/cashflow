import { describe, expect, it } from 'vitest';

import { makeCustomer } from './fixtures.ts';
import {
  calibration,
  calibrationBand,
  computeMetrics,
  customerNetMarginCents,
  poolResults,
  gradeInversions,
  rankOrdering,
  scoreBand,
  scoreSeparation,
  segmentMetrics,
  swapSet,
  THROUGH_THE_DOOR_BANDS,
  throughTheDoorBand,
  throughTheDoorMetrics,
} from './metrics.ts';
import { emptyBucketRoll, type CustomerResult, type PortfolioResult } from './portfolio.ts';

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
    plansDelayed: 0,
    plansNeverFunded: 0,
    bucketRoll: emptyBucketRoll(),
    bucketEntryRoll: emptyBucketRoll(),
    passThrough: null,
    graduates: [],
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

describe('score separation on a hand built set', () => {
  it('counts the pairs a good wins, with ties as half', () => {
    // Goods 80, 70, 60, 50. Bads 70, 40. Eight pairs.
    // Against the bad at 70: 80 wins, 70 ties, 60 and 50 lose -> 1.5.
    // Against the bad at 40: all four win -> 4.
    const r = scoreSeparation([80, 70, 60, 50], [70, 40]);
    expect(r.auc).toBe(5.5 / 8);
    expect(r.goods).toBe(4);
    expect(r.bads).toBe(2);
    // Cumulative share at or below each score, bads then goods:
    // 40: 0.5, 0. 50: 0.5, 0.25. 60: 0.5, 0.5. 70: 1, 0.75. 80: 1, 1. Largest gap 0.5.
    expect(r.ks).toBe(0.5);
  });

  it('is 1 when every good outscores every bad and 0 when every bad outscores every good', () => {
    expect(scoreSeparation([90, 80], [70, 10])).toMatchObject({ auc: 1, ks: 1 });
    expect(scoreSeparation([20, 10], [70, 60])).toMatchObject({ auc: 0, ks: 1 });
  });

  it('does not depend on the order the scores are given in', () => {
    expect(scoreSeparation([50, 80, 60, 70], [40, 70])).toEqual(
      scoreSeparation([80, 70, 60, 50], [70, 40]),
    );
  });

  it('is null without both goods and bads', () => {
    expect(scoreSeparation([], [50])).toEqual({ auc: null, ks: null, goods: 0, bads: 1 });
    expect(scoreSeparation([50], [])).toEqual({ auc: null, ks: null, goods: 1, bads: 0 });
  });
});

describe('through the door metrics', () => {
  const funded = (overrides: Partial<CustomerResult>) =>
    makeCustomer({ payoutCount: 1, payoutCents: 100_000, ...overrides });
  const customers = [
    // Approved by the policy: three good, one bad.
    funded({ applicantId: 'a1', score: 90, grade: 'A' }),
    funded({ applicantId: 'a2', score: 80, grade: 'A' }),
    funded({ applicantId: 'a3', score: 72, grade: 'B' }),
    funded({ applicantId: 'a4', score: 72, grade: 'B', bad: true }),
    // Approved for less than the rent: no plan in the product, funded here.
    funded({ applicantId: 'c1', score: 58, grade: 'C', counterOffer: true, bad: true }),
    // Declined by the policy: one good, two bad, and a fraud applicant with a high score.
    funded({ applicantId: 'd1', score: 47, grade: 'F', outcome: 'DECLINED' }),
    funded({ applicantId: 'd2', score: 42, grade: 'F', outcome: 'DECLINED', bad: true }),
    funded({ applicantId: 'd3', score: 20, grade: 'F', outcome: 'DECLINED', bad: true }),
    funded({
      applicantId: 'f1',
      score: 85,
      grade: 'A',
      outcome: 'DECLINED',
      fraud: 'round_trip',
      segment: 'round_trip',
      bad: true,
    }),
    // No score: asked for more information, never funded.
    makeCustomer({ applicantId: 'n1', outcome: 'NEEDS_INFO', score: null, grade: null }),
  ];
  const t = throughTheDoorMetrics(customers);

  it('covers every scored applicant, declined or not, and leaves out the unscored', () => {
    expect(t).toMatchObject({ applicants: 10, scored: 9, unscored: 1 });
    expect(t.all).toMatchObject({ goods: 4, bads: 5 });
    expect(t.honest).toMatchObject({ goods: 4, bads: 4 });
  });

  it('ranks honest applicants apart from the fraud archetypes', () => {
    // Honest goods 90, 80, 72, 47. Honest bads 72, 58, 42, 20.
    // Wins: 90 and 80 beat all four (8), 72 beats three and ties one (3.5), 47 beats two (2).
    expect(t.honest.auc).toBe(13.5 / 16);
    // The fraud applicant scored 85 and went bad: 90 beats it, the other three goods lose.
    expect(t.all.auc).toBe(14.5 / 20);
    expect(t.all.auc!).toBeLessThan(t.honest.auc!);
  });

  it('reports the bad rate by score band and grade, including the declined bands', () => {
    expect(t.byScoreBand['0-29']).toMatchObject({ plans: 1, bad: 1, badRateBps: 10_000 });
    expect(t.byScoreBand['40-44']).toMatchObject({ plans: 1, bad: 1, approvedUsable: 0 });
    expect(t.byScoreBand['45-49']).toMatchObject({ plans: 1, bad: 0, approvedUsable: 0 });
    expect(t.byScoreBand['70-74']).toMatchObject({
      plans: 2,
      bad: 1,
      badRateBps: 5000,
      approvedUsable: 2,
    });
    // The fraud applicant is in the band but not in its honest figures.
    expect(t.byScoreBand['85-89']).toMatchObject({
      plans: 1,
      bad: 1,
      badRateBps: 10_000,
      honestPlans: 0,
      honestBad: 0,
      honestBadRateBps: 0,
    });
    expect(Object.keys(t.byScoreBand)).toEqual([...THROUGH_THE_DOOR_BANDS]);
    expect(t.byGrade.F).toMatchObject({ plans: 3, bad: 2, badRateBps: 6667 });
    expect(t.byGrade.A).toMatchObject({ plans: 3, bad: 1, honestPlans: 2, honestBad: 0 });
  });

  it('sets the declined beside the approved', () => {
    expect(t.byPolicyOutcome.approvedUsable).toMatchObject({ plans: 4, bad: 1, badRateBps: 2500 });
    expect(t.byPolicyOutcome.approvedCounterOffer).toMatchObject({ plans: 1, bad: 1 });
    expect(t.byPolicyOutcome.declined).toMatchObject({
      plans: 4,
      bad: 3,
      badRateBps: 7500,
      honestPlans: 3,
      honestBad: 2,
      honestBadRateBps: 6667,
    });
  });

  it('bands scores five wide from 40 up and coarser below', () => {
    expect([0, 29, 30, 39, 40, 44, 45, 50, 94, 95, 100].map(throughTheDoorBand)).toEqual([
      '0-29',
      '0-29',
      '30-39',
      '30-39',
      '40-44',
      '40-44',
      '45-49',
      '50-54',
      '90-94',
      '95-100',
      '95-100',
    ]);
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

describe('referrals and funding', () => {
  it('counts referrals beside the final outcome and separates engine only approvals', () => {
    const referredApproved = makeCustomer({
      applicantId: 'r1',
      engineOutcome: 'REFER',
      referred: true,
    });
    const referredDeclined = makeCustomer({
      applicantId: 'r2',
      outcome: 'DECLINED',
      engineOutcome: 'REFER',
      referred: true,
      fraud: 'bust_out',
    });
    const waiting = makeCustomer({ applicantId: 'w', neverFunded: true });
    const m = segmentMetrics([good, referredApproved, referredDeclined, waiting, declined], COSTS);
    expect(m).toMatchObject({
      applicants: 5,
      approved: 3,
      declined: 2,
      referred: 2,
      referRateBps: 4000,
      autoApproved: 2,
      neverFunded: 1,
    });
    const metrics = computeMetrics(portfolio([good, referredDeclined]), COSTS);
    expect(metrics.fraud).toMatchObject({ applicants: 1, approved: 0, referred: 1 });
    expect(metrics.funding).toEqual({ plansDelayed: 0, plansNeverFunded: 0 });
  });
});

describe('calibration', () => {
  it('bands scores five wide from 45 up', () => {
    expect(calibrationBand(44)).toBe('0-44');
    expect(calibrationBand(50)).toBe('50-54');
    expect(calibrationBand(54)).toBe('50-54');
    expect(calibrationBand(94)).toBe('90-94');
    expect(calibrationBand(95)).toBe('95-100');
    expect(calibrationBand(100)).toBe('95-100');
  });

  it('sets expected bad rate and loss beside what was realized', () => {
    const priced = (id: string, isBad: boolean) =>
      makeCustomer({
        applicantId: id,
        score: 62,
        pdBps: 1000,
        expectedLossBps: 50,
        payoutCount: 10,
        payoutCents: 1_000_000,
        chargedOffCents: isBad ? 100_000 : 0,
        recoveredCents: isBad ? 10_000 : 0,
        bad: isBad,
      });
    const rows = calibration([
      priced('a', false),
      priced('b', false),
      priced('c', false),
      priced('d', true),
    ]);
    expect(rows).toEqual([
      {
        band: '60-64',
        plans: 4,
        expectedBadRateBps: 1000,
        realizedBadRateBps: 2500,
        expectedLossBps: 50,
        // 90,000 net loss on 4,000,000 of volume.
        realizedLossBps: 225,
      },
    ]);
  });

  it('leaves out plans that were not priced on expected loss, and unfunded applicants', () => {
    expect(calibration([good, bad, declined])).toEqual([]);
  });
});

describe('pooling seeds', () => {
  it('makes one book of several runs', () => {
    const a = portfolio([good, bad]);
    const b = { ...portfolio([good, declined]), poolMinCents: 700_000, unfundedPayouts: 2 };
    const pooled = poolResults([a, b]);
    expect(pooled.customers).toHaveLength(4);
    // Ids stay unique so swap sets can pair customers across runs.
    expect(new Set(pooled.customers.map((c) => c.applicantId)).size).toBe(4);
    expect(pooled.poolMinCents).toBe(700_000);
    expect(pooled.unfundedPayouts).toBe(2);
    const m = computeMetrics(pooled, COSTS);
    expect(m.overall).toMatchObject({ applicants: 4, approved: 3, plans: 3 });
  });
});

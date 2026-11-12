import type { CashFlowSummary } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { POLICY_V1, POLICY_V2 } from './policy.ts';
import { curve, gradeFor, scoreCashFlow, WEIGHTS } from './scorecard.ts';

export const strongProfile: CashFlowSummary = {
  asOf: '2026-11-09',
  monthsOfHistory: 12,
  balanceKnown: true,
  currentBalanceCents: 5_000_000,
  verifiedMonthlyRevenueCents: 4_800_000,
  trailingTwelveMonthRevenueCents: 57_000_000,
  revenueGrowthBps: 800,
  revenueVolatilityBps: 1200,
  depositDaysPerMonth: 24,
  statedRevenueVarianceBps: 0,
  monthlyOperatingOutflowsCents: 3_900_000,
  operatingMarginBps: 1875,
  monthlyNetCashFlowCents: 500_000,
  monthlyDebtServiceCents: 100_000,
  debtToRevenueBps: 208,
  observedRentCents: 620_000,
  avgDailyBalance90Cents: 4_500_000,
  minBalance90Cents: 2_000_000,
  daysOfCashOnHand: 70,
  lowPointDaysOfCash90: 28,
  negativeBalanceDays90: 0,
  nsfCount90: 0,
  nsfCount365: 0,
  rentToRevenueBps: 1292,
  rentCoverageRatio: 176,
  monthly: [],
  commerce: null,
  revenueTrend: {
    recent4VsPrior12WeeksBps: 300,
    recent12VsPrior12WeeksBps: 500,
    yearOverYearBps: 800,
    slope6Bps: 100,
    compositeBps: 800,
  },
};

describe('curve', () => {
  it('interpolates and clamps', () => {
    const pts = [
      [0, 0],
      [10, 10],
    ] as const;
    expect(curve(-5, pts)).toBe(0);
    expect(curve(5, pts)).toBe(5);
    expect(curve(50, pts)).toBe(10);
  });
});

describe('scoreCashFlow', () => {
  it('weights sum to 100 and a strong profile grades A', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    for (const policy of [POLICY_V1, POLICY_V2]) {
      expect(Object.values(policy.weights).reduce((a, b) => a + b, 0)).toBe(100);
      const scored = scoreCashFlow(strongProfile, policy);
      expect(scored.factors.reduce((sum, f) => sum + f.maxPoints, 0)).toBe(100);
      expect(scored.grade).toBe('A');
    }
    const card = scoreCashFlow(strongProfile);
    expect(card.score).toBeGreaterThanOrEqual(85);
    expect(card.grade).toBe('A');
    expect(card.factors.every((f) => f.points <= f.maxPoints && f.points >= 0)).toBe(true);
    expect(card.factors.map((f) => f.code)).toContain('CASH_FLOW_COVERAGE');
  });

  it('penalizes overdrafts, thin buffers, and heavy debt', () => {
    const weak = scoreCashFlow({
      ...strongProfile,
      nsfCount90: 2,
      negativeBalanceDays90: 6,
      daysOfCashOnHand: 5,
      debtToRevenueBps: 1800,
      rentCoverageRatio: 105,
      rentToRevenueBps: 3200,
    });
    expect(weak.score).toBeLessThan(50);
    expect(['D', 'F']).toContain(weak.grade);
    const conduct = weak.factors.find((f) => f.code === 'ACCOUNT_CONDUCT');
    expect(conduct?.impact).toBe('NEGATIVE');
    expect(conduct?.message).toMatch(/2 overdraft fees/);
  });

  it('maps scores to grades at the documented floors', () => {
    expect(gradeFor(80)).toBe('A');
    expect(gradeFor(79)).toBe('B');
    expect(gradeFor(68)).toBe('B');
    expect(gradeFor(55)).toBe('C');
    expect(gradeFor(45)).toBe('D');
    expect(gradeFor(44)).toBe('F');
  });

  it('treats short history as a flat trend and unscorable stability', () => {
    const young = scoreCashFlow(
      { ...strongProfile, monthsOfHistory: 4, revenueGrowthBps: -5000 },
      POLICY_V1,
    );
    const trend = young.factors.find((f) => f.code === 'REVENUE_TREND');
    expect(trend?.points).toBe(5);
  });
});

describe('scorecard versions', () => {
  const points = (card: ReturnType<typeof scoreCashFlow>, code: string) =>
    card.factors.find((f) => f.code === code)!;

  it('version 1 is unchanged: launch weights, quarter trend, buffer from today alone', () => {
    const card = scoreCashFlow(strongProfile, POLICY_V1);
    expect(points(card, 'RENT_TO_REVENUE').maxPoints).toBe(20);
    expect(points(card, 'CASH_BUFFER')).toMatchObject({ points: 15, maxPoints: 15 });
    expect(points(card, 'REVENUE_TREND').message).toMatch(/last three months/);
    // A low point of zero and old overdrafts do not move the launch scorecard.
    const fragile = scoreCashFlow(
      { ...strongProfile, lowPointDaysOfCash90: 0, nsfCount365: 5 },
      POLICY_V1,
    );
    expect(fragile.score).toBe(card.score);
  });

  it('version 2 moves weight from rent share to the cash buffer', () => {
    const card = scoreCashFlow(strongProfile, POLICY_V2);
    expect(points(card, 'RENT_TO_REVENUE').maxPoints).toBe(10);
    expect(points(card, 'CASH_FLOW_COVERAGE').maxPoints).toBe(15);
    expect(points(card, 'CASH_BUFFER').maxPoints).toBe(30);
  });

  it('version 2 blends the low point of the last 90 days into the buffer', () => {
    const steady = scoreCashFlow({ ...strongProfile, lowPointDaysOfCash90: 40 }, POLICY_V2);
    const dipped = scoreCashFlow({ ...strongProfile, lowPointDaysOfCash90: 0 }, POLICY_V2);
    // 70 days today is full marks for 60% of the factor; a low point of zero forfeits the rest.
    expect(points(steady, 'CASH_BUFFER').points).toBe(30);
    expect(points(dipped, 'CASH_BUFFER').points).toBe(18);
    expect(points(dipped, 'CASH_BUFFER').message).toMatch(/ran out at least once in the last 90 days/);
  });

  it('version 2 takes a point for each overdraft fee earlier in the year', () => {
    const clean = scoreCashFlow(strongProfile, POLICY_V2);
    const older = scoreCashFlow({ ...strongProfile, nsfCount365: 4 }, POLICY_V2);
    expect(points(clean, 'ACCOUNT_CONDUCT').points - points(older, 'ACCOUNT_CONDUCT').points).toBe(
      4,
    );
    expect(points(older, 'ACCOUNT_CONDUCT').message).toMatch(
      /4 overdraft fees earlier in the year/,
    );
  });

  it('version 2 scores the season adjusted trend, so a seasonal trough costs nothing', () => {
    // Down 20% on the prior quarter, level with the same weeks last year.
    const trough: CashFlowSummary = {
      ...strongProfile,
      revenueGrowthBps: -2000,
      revenueTrend: { ...strongProfile.revenueTrend!, yearOverYearBps: 0, compositeBps: 0 },
    };
    const v1 = points(scoreCashFlow(trough, POLICY_V1), 'REVENUE_TREND');
    const v2 = points(scoreCashFlow(trough, POLICY_V2), 'REVENUE_TREND');
    expect(v1.points / v1.maxPoints).toBeLessThan(0.3);
    expect(v2.points / v2.maxPoints).toBe(0.7);
    expect(v2.message).toMatch(/same weeks a year ago/);
  });

  it('version 2 reads a decision stored before the new fields existed', () => {
    const { revenueTrend: _t, lowPointDaysOfCash90: _l, ...old } = strongProfile;
    expect(() => scoreCashFlow(old as CashFlowSummary, POLICY_V2)).not.toThrow();
  });
});

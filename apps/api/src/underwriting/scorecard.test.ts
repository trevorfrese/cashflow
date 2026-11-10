import type { CashFlowSummary } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

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
  negativeBalanceDays90: 0,
  nsfCount90: 0,
  nsfCount365: 0,
  rentToRevenueBps: 1292,
  rentCoverageRatio: 176,
  monthly: [],
  commerce: null,
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
    expect(weak.score).toBeLessThan(45);
    expect(weak.grade).toBe('F');
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
    const young = scoreCashFlow({ ...strongProfile, monthsOfHistory: 4, revenueGrowthBps: -5000 });
    const trend = young.factors.find((f) => f.code === 'REVENUE_TREND');
    expect(trend?.points).toBe(5);
  });
});

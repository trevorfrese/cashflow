import { describe, expect, it } from 'vitest';

import type { PdTable } from './pd-table.ts';
import { POLICY_V2, type PricingPolicy } from './policy.ts';
import { costOfFundsBps, pdBandFor, planFeeBps, priceFee, rentDaysOutstanding } from './pricing.ts';

const table: PdTable = {
  bands: [
    { minScore: 0, maxScore: 59, pdBps: 2000, plans: 100, bad: 20 },
    { minScore: 60, maxScore: 79, pdBps: 800, plans: 100, bad: 8 },
    { minScore: 80, maxScore: 100, pdBps: 200, plans: 100, bad: 2 },
  ],
  measuredLossGivenDefaultBps: 6000,
  measuredPeriodsPerPlan: 12,
  source: {
    applicants: 300,
    seeds: ['test'],
    horizonMonths: 12,
    servicingPolicy: 'standard',
    badDefinition: 'test',
    note: 'hand built for the unit tests',
  },
};
const pricing: PricingPolicy = {
  pdTable: table,
  lossGivenDefaultBps: 6000,
  expectedPeriods: 12,
  costOfFundsAprBps: 1200,
  servicingCostCents: 1200,
  targetMarginBps: 40,
  minFeeCents: 2000,
  maxFeeBps: 400,
  feeIncrementBps: 5,
};
const policy = { pricing: POLICY_V2.pricing, expectedLossPricing: pricing };
const price = (score: number, grade: 'A' | 'B' | 'C' | 'D', rentCents: number, installments = 2) =>
  priceFee(policy, { score, grade, rentCents, installmentsPerMonth: installments });

describe('fee build up', () => {
  it('reads PD from the score band', () => {
    expect(pdBandFor(table, 59).pdBps).toBe(2000);
    expect(pdBandFor(table, 60).pdBps).toBe(800);
    expect(pdBandFor(table, 100).pdBps).toBe(200);
  });

  it('measures how long the rent is out by cadence', () => {
    // Two installments: half the rent for 14 days. Four: 75%, 50%, 25% for a week each.
    expect(rentDaysOutstanding(2)).toBe(7);
    expect(rentDaysOutstanding(4)).toBe(10.5);
    expect(rentDaysOutstanding(1)).toBe(0);
    expect(costOfFundsBps(1200, 2)).toBe(24);
    expect(costOfFundsBps(1200, 4)).toBe(35);
  });

  it('adds expected loss, cost of funds, servicing, and margin', () => {
    const fee = price(90, 'A', 1_000_000);
    // PD 2% x LGD 60% over 12 periods = 10 bps a period.
    expect(fee.expectedLossBps).toBe(10);
    expect(fee.costOfFundsBps).toBe(24);
    // $12 on $10,000 of rent.
    expect(fee.servicingBps).toBe(12);
    expect(fee.requiredBps).toBe(10 + 24 + 12 + 40);
  });

  it('charges the grade floor when the build up is below it', () => {
    const fee = price(90, 'A', 1_000_000);
    expect(fee.requiredBps).toBeLessThan(150);
    expect(fee).toMatchObject({ feeBps: 150, driver: 'GRADE_FLOOR', withinCap: true });
  });

  it('charges the build up when it is above the floor, rounded up', () => {
    // Grade A floor is 150. A risky band on a small rent needs more.
    const fee = price(50, 'A', 200_000);
    // 2000 x 0.6 / 12 = 100, + 24 + 60 servicing + 40 margin = 224 -> 225.
    expect(fee.requiredBps).toBe(224);
    expect(fee).toMatchObject({ feeBps: 225, driver: 'EXPECTED_LOSS', withinCap: true });
    expect(fee.feeCents).toBe(4500);
  });

  it('never charges less than the minimum fee in cents', () => {
    // $800 of rent, grade A: the build up is 10 + 24 + 150 + 40 = 224 bps, or $17.92.
    // The $20 minimum is 250 bps.
    const fee = price(90, 'A', 80_000);
    expect(fee.minFeeBps).toBe(250);
    expect(fee).toMatchObject({ feeBps: 250, driver: 'MINIMUM_FEE', withinCap: true });
    expect(fee.feeCents).toBe(2000);
  });

  it('reports a fee above the cap instead of capping it', () => {
    // $400 of rent: the minimum fee alone is 5% of rent.
    const small = price(90, 'A', 40_000);
    expect(small.feeBps).toBe(500);
    expect(small.withinCap).toBe(false);
    // A very risky band at a moderate rent.
    const risky = priceFee(
      {
        pricing: POLICY_V2.pricing,
        expectedLossPricing: { ...pricing, lossGivenDefaultBps: 10_000, expectedPeriods: 4 },
      },
      { score: 50, grade: 'D', rentCents: 300_000, installmentsPerMonth: 4 },
    );
    // 2000 x 1.0 / 4 = 500 bps of expected loss alone.
    expect(risky.expectedLossBps).toBe(500);
    expect(risky.withinCap).toBe(false);
    expect(risky.driver).toBe('EXPECTED_LOSS');
  });

  it('costs more to fund four installments than two', () => {
    expect(price(50, 'A', 200_000, 4).requiredBps - price(50, 'A', 200_000, 2).requiredBps).toBe(
      11,
    );
  });
});

describe('plan fee', () => {
  it('keeps the decision fee when the lease is large enough', () => {
    expect(planFeeBps(POLICY_V2, 150, 500_000)).toBe(150);
  });

  it('raises the rate on a small lease so the minimum fee in cents is met', () => {
    const min = POLICY_V2.expectedLossPricing!.minFeeCents;
    const fee = planFeeBps(POLICY_V2, 150, 80_000)!;
    expect((80_000 * fee) / 10_000).toBeGreaterThanOrEqual(min);
    expect(fee).toBeGreaterThan(150);
  });

  it('refuses a lease too small to serve inside the cap', () => {
    expect(planFeeBps(POLICY_V2, 150, 30_000)).toBeNull();
  });

  it('leaves the fee alone under a policy without expected loss pricing', () => {
    expect(planFeeBps({ expectedLossPricing: null }, 150, 30_000)).toBe(150);
  });
});

describe('the shipped PD table', () => {
  const shipped = POLICY_V2.expectedLossPricing!.pdTable;
  it('covers every score and never prices a higher score as riskier', () => {
    expect(shipped.bands[0]!.minScore).toBe(0);
    expect(shipped.bands[shipped.bands.length - 1]!.maxScore).toBe(100);
    for (let i = 1; i < shipped.bands.length; i++) {
      expect(shipped.bands[i]!.minScore).toBe(shipped.bands[i - 1]!.maxScore + 1);
      expect(shipped.bands[i]!.pdBps).toBeLessThanOrEqual(shipped.bands[i - 1]!.pdBps);
    }
  });

  it('records the run that produced it', () => {
    expect(shipped.source.applicants).toBeGreaterThan(0);
    expect(shipped.source.seeds.length).toBeGreaterThan(0);
    expect(shipped.source.servicingPolicy).toBe('standard');
  });
});

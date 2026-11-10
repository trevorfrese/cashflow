import { describe, expect, it } from 'vitest';

import { generateHistory, parseScenario, type Scenario } from '../providers/bank-link/synthetic.ts';
import { capacityCents, decide, POLICY, recommendInstallments } from './engine.ts';
import { strongProfile } from './scorecard.test.ts';

const AS_OF = '2026-11-09';

function run(token: string, overrides: Partial<Parameters<typeof decide>[0]> = {}) {
  const spec = parseScenario(token);
  const history = generateHistory(spec, 'abcdef123456', AS_OF);
  return decide({
    statedMonthlyRevenueCents: spec.monthlyRevenueCents,
    timeInBusinessMonths: 48,
    requestedMonthlyRentCents: spec.rentCents,
    bankData: {
      transactions: history.transactions,
      currentBalanceCents: history.currentBalanceCents,
      asOf: AS_OF,
    },
    ...overrides,
  });
}

describe('underwriting engine', () => {
  it('needs info without bank data', () => {
    const r = run('healthy', { bankData: null });
    expect(r.outcome).toBe('NEEDS_INFO');
    expect(r.reasons[0]?.code).toBe('BANK_LINK_REQUIRED');
    expect(r.cashFlow).toBeNull();
  });

  it('approves a healthy business with grade A or B and a limit above the request', () => {
    const r = run('healthy_rev_48000_rent_6200');
    expect(r.outcome).toBe('APPROVED');
    expect(['A', 'B']).toContain(r.grade);
    expect(r.approvedMonthlyLimitCents).toBeGreaterThanOrEqual(620_000);
    expect(r.feeBps).toBe(POLICY.pricing[r.grade!].feeBps);
    expect(r.cashFlow?.monthsOfHistory).toBeGreaterThanOrEqual(11);
    expect(r.cashFlow?.monthly.length).toBe(r.cashFlow?.monthsOfHistory);
    expect(r.reasons[0]?.impact).toBe('POSITIVE');
    // Every scorecard factor is surfaced as a reason the applicant can read.
    expect(r.reasons.map((x) => x.code)).toEqual(
      expect.arrayContaining(['RENT_TO_REVENUE', 'CASH_FLOW_COVERAGE', 'CASH_BUFFER']),
    );
  });

  it('verifies revenue close to the pinned level', () => {
    const r = run('healthy_rev_30000');
    const verified = r.cashFlow!.verifiedMonthlyRevenueCents;
    expect(verified).toBeGreaterThan(2_550_000);
    expect(verified).toBeLessThan(3_450_000);
  });

  it('declines repeated overdrafts on a hard rule', () => {
    const r = run('overdrafts_rev_9000_rent_3500');
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons.map((x) => x.code)).toContain('EXCESSIVE_OVERDRAFTS');
    expect(r.cashFlow!.nsfCount90).toBeGreaterThan(POLICY.maxNsf90);
  });

  it('declines a steep revenue decline', () => {
    const r = run('declining_rev_40000');
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons.map((x) => x.code)).toContain('REVENUE_DECLINING');
  });

  it('asks for more history from a new business', () => {
    const r = run('new_business_rev_40000');
    expect(r.outcome).toBe('NEEDS_INFO');
    expect(r.reasons[0]?.code).toBe('INSUFFICIENT_HISTORY');
  });

  it('flags a stated revenue far above verified', () => {
    const r = run('healthy_rev_20000', { statedMonthlyRevenueCents: 6_000_000 });
    expect(r.outcome).toBe('NEEDS_INFO');
    expect(r.reasons[0]?.code).toBe('REVENUE_MISMATCH');
  });

  it('declines too little time in business even with good cash flow', () => {
    const r = run('healthy_rev_48000', { timeInBusinessMonths: 4 });
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons[0]?.code).toBe('TIME_IN_BUSINESS');
    expect(r.score).not.toBeNull();
  });

  it('prices heavier debt and thinner margins worse than a healthy book', () => {
    const healthy = run('healthy_rev_48000_rent_6200');
    const debt = run('heavy_debt_rev_48000_rent_6200');
    expect(debt.score!).toBeLessThan(healthy.score!);
    expect(debt.cashFlow!.debtToRevenueBps).toBeGreaterThan(1200);
    if (debt.outcome === 'APPROVED') {
      expect(debt.feeBps!).toBeGreaterThanOrEqual(healthy.feeBps!);
      expect(debt.approvedMonthlyLimitCents!).toBeLessThanOrEqual(
        healthy.approvedMonthlyLimitCents!,
      );
    }
  });

  it('counter offers a lower limit when the request is too large but close', () => {
    const r = run('healthy_rev_30000', { requestedMonthlyRentCents: 850_000 });
    if (r.outcome === 'APPROVED') {
      expect(r.approvedMonthlyLimitCents!).toBeLessThan(850_000);
      expect(r.reasons[0]?.code).toBe('LIMIT_BELOW_REQUEST');
    } else {
      expect(r.reasons.map((x) => x.code)).toContain('INSUFFICIENT_CAPACITY');
    }
  });

  it('is deterministic for the same token and date', () => {
    const a = run('seasonal_rev_40000');
    const b = run('seasonal_rev_40000');
    expect(a).toEqual(b);
  });

  it('exercises every scenario without throwing', () => {
    const scenarios: Scenario[] = [
      'healthy',
      'growing',
      'thin_margin',
      'declining',
      'volatile',
      'overdrafts',
      'heavy_debt',
      'seasonal',
      'new_business',
      'low_balance',
      'no_balance',
    ];
    for (const s of scenarios) {
      const r = run(`${s}_rev_40000`);
      expect(['APPROVED', 'DECLINED', 'NEEDS_INFO']).toContain(r.outcome);
    }
  });
});

describe('capacity and cadence', () => {
  it('bounds the limit by revenue share and by coverage, rounded to $100', () => {
    // Revenue cap for grade A: 30% of 48,000 = 14,400. Coverage cap: (500,000 + 620,000)
    // free cash / (1.25 * 1.015) = 882,758 -> 8,800. Coverage binds.
    expect(capacityCents(strongProfile, 'A')).toBe(880_000);
    expect(capacityCents({ ...strongProfile, monthlyNetCashFlowCents: 5_000_000 }, 'A')).toBe(
      1_440_000,
    );
    expect(capacityCents({ ...strongProfile, monthlyNetCashFlowCents: -700_000 }, 'A')).toBe(0);
  });

  it('suggests more frequent installments for thin buffers with daily deposits', () => {
    expect(recommendInstallments(strongProfile)).toBe(2);
    expect(recommendInstallments({ ...strongProfile, daysOfCashOnHand: 10 })).toBe(4);
    expect(
      recommendInstallments({ ...strongProfile, daysOfCashOnHand: 10, depositDaysPerMonth: 4 }),
    ).toBe(2);
  });
});

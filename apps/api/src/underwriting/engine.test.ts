import { describe, expect, it } from 'vitest';

import { generateHistory, parseScenario, type Scenario } from '../providers/bank-link/synthetic.ts';
import { generateSales, parseCommerceScenario } from '../providers/commerce/synthetic.ts';
import { capacityCents, decide, POLICY, recommendInstallments } from './engine.ts';
import { POLICY_V1, POLICY_VERSION } from './policy.ts';
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

/** The same business seen through a connected Square account. */
function posData(token: string) {
  const spec = parseCommerceScenario(token, 'SQUARE');
  const { dailySales, connectedSince } = generateSales(spec, 'abcdef123456', AS_OF);
  return { platform: spec.platform, dailySales, connectedSince };
}

describe('underwriting engine', () => {
  it('needs info without bank data', () => {
    const r = run('healthy', { bankData: null });
    expect(r.outcome).toBe('NEEDS_INFO');
    expect(r.reasons[0]?.code).toBe('BANK_LINK_REQUIRED');
    expect(r.cashFlow).toBeNull();
  });

  it('approves a healthy business with grade A or B for exactly what it asked', () => {
    const r = run('healthy_rev_48000_rent_6200');
    expect(r.outcome).toBe('APPROVED');
    expect(['A', 'B']).toContain(r.grade);
    // The limit is the lease in front of us, never more.
    expect(r.approvedMonthlyLimitCents).toBe(620_000);
    expect(r.feeBps).toBe(POLICY.pricing[r.grade!].feeBps);
    expect(r.policyVersion).toBe(POLICY_VERSION);
    expect(r.snapshot.policyVersion).toBe(POLICY_VERSION);
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
    if (debt.outcome === 'APPROVED' || debt.outcome === 'REFER') {
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

  it('reads steadier revenue from a point of sale when deposits are batched', () => {
    const bankOnly = run('batched_rev_40000_rent_5000');
    const withPos = run('batched_rev_40000_rent_5000', {
      commerceData: posData('batched_sales_40000'),
    });
    const commerce = withPos.cashFlow!.commerce!;
    expect(commerce.platform).toBe('SQUARE');
    expect(commerce.monthsOfHistory).toBeGreaterThanOrEqual(11);
    expect(commerce.depositMatchBps).toBeGreaterThanOrEqual(POLICY.minDepositMatchBps);
    expect(withPos.cashFlow!.revenueVolatilityBps).toBeLessThan(
      bankOnly.cashFlow!.revenueVolatilityBps,
    );
    expect(withPos.score!).toBeGreaterThanOrEqual(bankOnly.score!);
    const depth = withPos.reasons.find((x) => x.code === 'DATA_DEPTH');
    expect(depth?.message).toContain('Square');
    expect(withPos.reasons.map((x) => x.code)).not.toContain('DEPOSIT_MISMATCH');
  });

  it('falls back to bank deposits when point of sale sales do not reach the bank', () => {
    // Bank shows $20,000 a month; the POS claims $60,000.
    const r = run('healthy_rev_20000_rent_3000', {
      commerceData: posData('healthy_sales_60000'),
    });
    expect(r.cashFlow!.commerce!.depositMatchBps).toBeLessThan(POLICY.minDepositMatchBps);
    expect(r.cashFlow!.verifiedMonthlyRevenueCents).toBeLessThan(3_000_000);
    expect(r.reasons.map((x) => x.code)).toContain('DEPOSIT_MISMATCH');
    expect(['APPROVED', 'DECLINED']).toContain(r.outcome);
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
      'batched',
    ];
    for (const s of scenarios) {
      const r = run(`${s}_rev_40000`);
      expect(['APPROVED', 'DECLINED', 'NEEDS_INFO', 'REFER']).toContain(r.outcome);
      expect(r.policyVersion).toBe(POLICY_VERSION);
    }
  });

  it('still runs the launch policy when asked, with a limit that may exceed the request', () => {
    const spec = parseScenario('healthy_rev_48000_rent_6200');
    const history = generateHistory(spec, 'abcdef123456', AS_OF);
    const r = decide(
      {
        statedMonthlyRevenueCents: spec.monthlyRevenueCents,
        timeInBusinessMonths: 48,
        requestedMonthlyRentCents: spec.rentCents,
        bankData: {
          transactions: history.transactions,
          currentBalanceCents: history.currentBalanceCents,
          asOf: AS_OF,
        },
      },
      POLICY_V1,
    );
    expect(r.outcome).toBe('APPROVED');
    expect(r.policyVersion).toBe('cashflow-v1');
    expect(r.approvedMonthlyLimitCents!).toBeGreaterThan(620_000);
    expect(r.feeBps).toBe(POLICY_V1.pricing[r.grade!].feeBps);
    expect(r.snapshot.integrityFlags).toEqual([]);
    expect(r.snapshot.pricing).toBeNull();
  });
});

describe('capacity and cadence', () => {
  it('bounds the limit by revenue share and by coverage, rounded to $100', () => {
    // Revenue cap for grade A: 30% of 48,000 = 14,400. Coverage cap: (500,000 + 620,000)
    // free cash / (1.25 * 1.015) = 882,758 -> 8,800. Coverage binds.
    expect(capacityCents(strongProfile, 'A')).toBe(880_000);
    // A higher fee leaves less room under the same coverage test: / (1.25 * 1.04) -> 8,600.
    expect(capacityCents(strongProfile, 'A', POLICY, 400)).toBe(860_000);
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

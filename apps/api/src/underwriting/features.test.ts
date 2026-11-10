import type { BankTransaction } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { computeCashFlowFeatures } from './features.ts';

let n = 0;
const tx = (
  date: string,
  amountCents: number,
  category: BankTransaction['category'],
): BankTransaction => ({
  id: String(++n),
  date,
  amountCents,
  description: category,
  category,
  pending: false,
});

/** Six tidy months: $10,000 revenue, $2,000 rent, $5,000 other expenses, $500 loan each month. */
function tidyMonths(): BankTransaction[] {
  const out: BankTransaction[] = [];
  for (let m = 1; m <= 6; m++) {
    const mm = String(m).padStart(2, '0');
    out.push(tx(`2026-${mm}-01`, -200_000, 'RENT'));
    out.push(tx(`2026-${mm}-03`, -50_000, 'LOAN_PAYMENT'));
    out.push(tx(`2026-${mm}-05`, 500_000, 'CARD_SETTLEMENT'));
    out.push(tx(`2026-${mm}-10`, -300_000, 'PAYROLL'));
    out.push(tx(`2026-${mm}-15`, 500_000, 'CARD_SETTLEMENT'));
    out.push(tx(`2026-${mm}-20`, -200_000, 'SUPPLIER'));
    out.push(tx(`2026-${mm}-25`, -100_000, 'OWNER_DRAW'));
  }
  return out;
}

describe('computeCashFlowFeatures', () => {
  it('aggregates revenue, outflows, debt, and rent by month', () => {
    const s = computeCashFlowFeatures({
      transactions: tidyMonths(),
      currentBalanceCents: 1_500_000,
      asOf: '2026-07-10',
      statedMonthlyRevenueCents: 1_000_000,
      requestedMonthlyRentCents: 200_000,
    });
    expect(s.monthsOfHistory).toBe(6);
    expect(s.verifiedMonthlyRevenueCents).toBe(1_000_000);
    expect(s.trailingTwelveMonthRevenueCents).toBe(6_000_000);
    expect(s.monthlyOperatingOutflowsCents).toBe(700_000);
    expect(s.monthlyDebtServiceCents).toBe(50_000);
    expect(s.debtToRevenueBps).toBe(500);
    expect(s.observedRentCents).toBe(200_000);
    // 1,000,000 - 700,000 - 50,000 - 100,000 owner draw
    expect(s.monthlyNetCashFlowCents).toBe(150_000);
    expect(s.operatingMarginBps).toBe(3000);
    expect(s.revenueGrowthBps).toBe(0);
    expect(s.revenueVolatilityBps).toBe(0);
    expect(s.depositDaysPerMonth).toBe(2);
    expect(s.statedRevenueVarianceBps).toBe(0);
    expect(s.rentToRevenueBps).toBe(2000);
    expect(s.monthly).toHaveLength(6);
    expect(s.monthly[0]?.month).toBe('2026-01');
  });

  it('measures coverage with the existing rent freed up', () => {
    const s = computeCashFlowFeatures({
      transactions: tidyMonths(),
      currentBalanceCents: 1_500_000,
      asOf: '2026-07-10',
      statedMonthlyRevenueCents: 1_000_000,
      requestedMonthlyRentCents: 200_000,
      provisionalFeeBps: 250,
    });
    // Free cash = 150,000 net + 200,000 rent that CashFlow will now pay = 350,000.
    // Obligation = 200,000 + 2.5% fee (5,000) = 205,000. Ratio 1.707 -> 171.
    expect(s.rentCoverageRatio).toBe(171);
  });

  it('reconstructs balances backward and counts negative days and overdraft fees', () => {
    const txs = [
      tx('2026-06-01', 100_000, 'CARD_SETTLEMENT'),
      tx('2026-06-10', -150_000, 'SUPPLIER'),
      tx('2026-06-10', -3500, 'NSF_FEE'),
      tx('2026-06-15', 200_000, 'CARD_SETTLEMENT'),
    ];
    const s = computeCashFlowFeatures({
      transactions: txs,
      currentBalanceCents: 146_500,
      asOf: '2026-06-20',
      statedMonthlyRevenueCents: 300_000,
      requestedMonthlyRentCents: 50_000,
    });
    // Balance was 100,000 on Jun 1..9, -53,500 on Jun 10..14, then 146,500.
    expect(s.negativeBalanceDays90).toBe(5);
    expect(s.nsfCount90).toBe(1);
    expect(s.minBalance90Cents).toBe(-53_500);
    expect(s.balanceKnown).toBe(true);
  });

  it('handles an unknown balance and no transactions', () => {
    const s = computeCashFlowFeatures({
      transactions: [],
      currentBalanceCents: null,
      asOf: '2026-06-20',
      statedMonthlyRevenueCents: 300_000,
      requestedMonthlyRentCents: 50_000,
    });
    expect(s.monthsOfHistory).toBe(0);
    expect(s.balanceKnown).toBe(false);
    expect(s.daysOfCashOnHand).toBeNull();
    expect(s.rentToRevenueBps).toBe(10_000);
    expect(s.monthly).toEqual([]);
  });

  it('computes growth from the last three months versus the prior three', () => {
    const txs: BankTransaction[] = [];
    const revenue = [100, 100, 100, 150, 150, 150];
    revenue.forEach((r, i) => {
      txs.push(tx(`2026-0${i + 1}-05`, r * 10_000, 'CARD_SETTLEMENT'));
    });
    const s = computeCashFlowFeatures({
      transactions: txs,
      currentBalanceCents: 0,
      asOf: '2026-07-01',
      statedMonthlyRevenueCents: 1_500_000,
      requestedMonthlyRentCents: 100_000,
    });
    expect(s.revenueGrowthBps).toBe(5000);
    expect(s.revenueVolatilityBps).toBe(2000);
  });
});

import type { BankTransaction, CashFlowSummary, IsoDate } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';

import type { EngineInput } from './engine.ts';

/** Builders for the underwriting unit tests. Not used outside tests. */

let counter = 0;
export function tx(
  date: IsoDate,
  amountCents: number,
  category: BankTransaction['category'],
): BankTransaction {
  counter += 1;
  return {
    id: `t${counter}`,
    date,
    amountCents,
    description: category,
    category,
    pending: false,
  };
}

export const AS_OF: IsoDate = '2026-11-09';

export interface AccountShape {
  /** Days of history ending on the as-of date. */
  days?: number;
  /** Sales deposited every day, in cents. May vary by how many days before the as-of date. */
  dailySalesCents?: number | ((daysAgo: number) => number);
  /** Rent debited on the first of each month. 0 for none. */
  rentCents?: number;
  /** Other operating costs as a share of the day's sales. */
  costShare?: number;
  asOf?: IsoDate;
}

/**
 * A plain account: sales every day, costs as a share of sales the same day, rent on the
 * first. $1,000 a day of sales, 80% costs, and $3,000 rent by default: about $30,000 a month
 * of revenue with roughly $3,000 a month left after rent.
 */
export function account(shape: AccountShape = {}): BankTransaction[] {
  const { days = 400, dailySalesCents = 100_000, rentCents = 300_000, costShare = 0.8 } = shape;
  const asOf = shape.asOf ?? AS_OF;
  const out: BankTransaction[] = [];
  for (let daysAgo = days - 1; daysAgo >= 0; daysAgo--) {
    const date = addDays(asOf, -daysAgo);
    const sales =
      typeof dailySalesCents === 'function' ? dailySalesCents(daysAgo) : dailySalesCents;
    if (sales > 0) {
      out.push(tx(date, Math.round(sales), 'CARD_SETTLEMENT'));
      out.push(tx(date, -Math.round(sales * costShare), 'SUPPLIER'));
    }
    if (rentCents > 0 && date.endsWith('-01')) out.push(tx(date, -rentCents, 'RENT'));
  }
  return out;
}

export function engineInput(
  transactions: BankTransaction[],
  overrides: Partial<EngineInput> = {},
): EngineInput {
  return {
    statedMonthlyRevenueCents: 3_000_000,
    timeInBusinessMonths: 48,
    requestedMonthlyRentCents: 300_000,
    bankData: { transactions, currentBalanceCents: 6_000_000, asOf: AS_OF },
    ...overrides,
  };
}

/** A summary good enough to pass every rule, for tests that only care about one field. */
export const cleanSummary: CashFlowSummary = {
  asOf: AS_OF,
  monthsOfHistory: 12,
  balanceKnown: true,
  currentBalanceCents: 6_000_000,
  verifiedMonthlyRevenueCents: 3_000_000,
  trailingTwelveMonthRevenueCents: 36_000_000,
  revenueGrowthBps: 0,
  revenueVolatilityBps: 500,
  depositDaysPerMonth: 30,
  statedRevenueVarianceBps: 0,
  monthlyOperatingOutflowsCents: 2_700_000,
  operatingMarginBps: 1000,
  monthlyNetCashFlowCents: 300_000,
  monthlyDebtServiceCents: 0,
  debtToRevenueBps: 0,
  observedRentCents: 300_000,
  avgDailyBalance90Cents: 6_000_000,
  minBalance90Cents: 5_000_000,
  daysOfCashOnHand: 66,
  lowPointDaysOfCash90: 55,
  negativeBalanceDays90: 0,
  nsfCount90: 0,
  nsfCount365: 0,
  rentToRevenueBps: 1000,
  rentCoverageRatio: 200,
  monthly: [],
  commerce: null,
  revenueTrend: {
    recent4VsPrior12WeeksBps: 0,
    recent12VsPrior12WeeksBps: 0,
    yearOverYearBps: 0,
    slope6Bps: 0,
    compositeBps: 0,
  },
};

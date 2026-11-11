import { z } from 'zod';

import { CommerceSummary } from './commerce';
import { Cents, IsoDateSchema } from './common';

/**
 * Normalized categories for business bank transactions. A real bank data provider (Plaid,
 * MX, Finicity) returns its own taxonomy; the adapter maps it onto this one so the
 * underwriting engine is provider agnostic.
 */
export const TransactionCategory = z.enum([
  // Operating inflows
  'CARD_SETTLEMENT',
  'CASH_DEPOSIT',
  'INVOICE_PAYMENT',
  'OTHER_INCOME',
  'REFUND',
  // Non operating inflows (excluded from revenue)
  'TRANSFER_IN',
  'LOAN_PROCEEDS',
  // Operating outflows
  'PAYROLL',
  'RENT',
  'SUPPLIER',
  'UTILITIES',
  'INSURANCE',
  'TAX',
  'SOFTWARE',
  'BANK_FEE',
  'NSF_FEE',
  'OTHER_EXPENSE',
  // Financing and owner outflows
  'LOAN_PAYMENT',
  'MCA_PAYMENT',
  'OWNER_DRAW',
  'TRANSFER_OUT',
]);
export type TransactionCategory = z.infer<typeof TransactionCategory>;

/** One bank transaction. Positive amounts are inflows, negative amounts are outflows. */
export const BankTransaction = z.object({
  id: z.string(),
  date: IsoDateSchema,
  amountCents: z.number().int(),
  description: z.string(),
  category: TransactionCategory,
  pending: z.boolean().default(false),
});
export type BankTransaction = z.infer<typeof BankTransaction>;

/** One calendar month of aggregated cash flow. */
export const MonthlyCashFlow = z.object({
  /** YYYY-MM */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  revenueCents: Cents,
  operatingOutflowsCents: Cents,
  debtServiceCents: Cents,
  netCashFlowCents: z.number().int(),
  endingBalanceCents: z.number().int().nullable(),
  depositDays: z.number().int().min(0),
  nsfCount: z.number().int().min(0),
});
export type MonthlyCashFlow = z.infer<typeof MonthlyCashFlow>;

/**
 * Revenue trend measured on daily windows of bank operating inflows, which see a turn up to
 * a month sooner than full calendar months do. All values are basis points of change; null
 * when the account history is too short for the comparison.
 */
export const RevenueTrend = z.object({
  /** Trailing 4 weeks against the 12 weeks before them, per week. */
  recent4VsPrior12WeeksBps: z.number().int().nullable(),
  /** Trailing 12 weeks against the 12 weeks before them. */
  recent12VsPrior12WeeksBps: z.number().int().nullable(),
  /**
   * Trailing four weeks against the same four weeks a year earlier (48 to 52 weeks back,
   * as far as the history reaches). Season neutral, which is what separates a seasonal
   * trough from a real decline.
   */
  yearOverYearBps: z.number().int().nullable(),
  /** Least squares slope of the last six full months, per month, as a share of their mean. */
  slope6Bps: z.number().int().nullable(),
  /** The trend the scorecard and the decline rules read: season adjusted where possible. */
  compositeBps: z.number().int(),
});
export type RevenueTrend = z.infer<typeof RevenueTrend>;

/**
 * Features the underwriting engine derives from bank transactions, and from platform sales
 * when a commerce account is connected. Stored with every
 * decision so a decision can be explained and audited later. Ratios are in basis points
 * so they stay integers; coverage is a ratio times 100 (125 = 1.25x).
 */
export const CashFlowSummary = z.object({
  asOf: IsoDateSchema,
  monthsOfHistory: z.number().int().min(0),
  balanceKnown: z.boolean(),
  currentBalanceCents: z.number().int().nullable(),

  // Revenue
  verifiedMonthlyRevenueCents: Cents,
  trailingTwelveMonthRevenueCents: Cents,
  revenueGrowthBps: z.number().int(),
  revenueVolatilityBps: z.number().int().min(0),
  depositDaysPerMonth: z.number().min(0),
  statedRevenueVarianceBps: z.number().int(),

  // Spending and obligations
  monthlyOperatingOutflowsCents: Cents,
  operatingMarginBps: z.number().int(),
  monthlyNetCashFlowCents: z.number().int(),
  monthlyDebtServiceCents: Cents,
  debtToRevenueBps: z.number().int().min(0),
  observedRentCents: Cents.nullable(),

  // Liquidity and conduct (trailing 90 days)
  avgDailyBalance90Cents: z.number().int().nullable(),
  minBalance90Cents: z.number().int().nullable(),
  daysOfCashOnHand: z.number().int().min(0).nullable(),
  /**
   * The lowest balance of the last 90 days, in days of average outflows. The low point of
   * the buffer: a balance that is healthy today but touched zero last month is thin. Null
   * when the balance is unknown or on decisions made before policy version 2.
   */
  lowPointDaysOfCash90: z.number().int().min(0).nullable().default(null),
  negativeBalanceDays90: z.number().int().min(0),
  nsfCount90: z.number().int().min(0),
  nsfCount365: z.number().int().min(0),

  // Affordability of the requested rent
  rentToRevenueBps: z.number().int().min(0),
  /** Free cash available for installments divided by rent plus fee, times 100. */
  rentCoverageRatio: z.number().int(),

  monthly: z.array(MonthlyCashFlow),

  /** Platform sales features when a POS or commerce account was connected. */
  commerce: CommerceSummary.nullable().default(null),
  /** Daily window trend measures. Null on decisions made before policy version 2. */
  revenueTrend: RevenueTrend.nullable().default(null),
});
export type CashFlowSummary = z.infer<typeof CashFlowSummary>;

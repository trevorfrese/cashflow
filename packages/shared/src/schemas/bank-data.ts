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
});
export type CashFlowSummary = z.infer<typeof CashFlowSummary>;

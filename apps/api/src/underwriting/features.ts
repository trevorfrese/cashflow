import type {
  BankTransaction,
  CashFlowSummary,
  CommercePlatform,
  CommerceSummary,
  DailySales,
  IsoDate,
  MonthlyCashFlow,
  RevenueTrend,
  TransactionCategory,
} from '@cashflow/shared';
import { addDays, daysBetween, feeForRent, parseIsoDate, toIsoDate } from '@cashflow/shared';

/**
 * Turn raw bank transactions, and platform sales when a POS is connected, into the
 * features the scorecard needs.
 *
 * Everything here is pure arithmetic over the transaction list and the current balance.
 * Ratios are returned in basis points so the summary is all integers and easy to store.
 */

const REVENUE_IN = new Set<TransactionCategory>([
  'CARD_SETTLEMENT',
  'CASH_DEPOSIT',
  'INVOICE_PAYMENT',
  'OTHER_INCOME',
]);
const OPERATING_OUT = new Set<TransactionCategory>([
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
  'REFUND',
]);
const DEBT_OUT = new Set<TransactionCategory>(['LOAN_PAYMENT', 'MCA_PAYMENT']);

export interface FeatureInput {
  transactions: BankTransaction[];
  currentBalanceCents: number | null;
  asOf: IsoDate;
  statedMonthlyRevenueCents: number;
  requestedMonthlyRentCents: number;
  /**
   * Fee included in the coverage ratio, in basis points of rent. The engine passes the
   * policy's scoring fee for the first pass and the quoted fee when it restates the ratio.
   */
  provisionalFeeBps?: number;
  /**
   * Credits to leave out of revenue: deposits the integrity checks matched to a transfer
   * out of the same size a few days later. They are not sales.
   */
  excludeTransactionIds?: ReadonlySet<string>;
  /** Daily sales from a connected point of sale, if any. */
  commerce?: {
    platform: CommercePlatform;
    dailySales: DailySales[];
    connectedSince: IsoDate;
  } | null;
}

export const DEFAULT_PROVISIONAL_FEE_BPS = 250;

/** Bank deposits must cover this share of POS net sales before the POS figure is trusted. */
export const MIN_DEPOSIT_MATCH_BPS = 7000;

interface MonthAgg {
  month: string;
  revenue: number;
  operatingOut: number;
  debt: number;
  ownerDraw: number;
  rent: number;
  rentCount: number;
  depositDays: Set<string>;
  nsf: number;
}

function bps(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator * 10_000) / denominator);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function previousMonthKey(asOf: IsoDate): string {
  const { year, month } = parseIsoDate(asOf);
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

function nextMonthKey(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

function monthKeysEnding(lastKey: string, count: number): string[] {
  const [y0, m0] = lastKey.split('-').map(Number) as [number, number];
  const keys: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const idx = y0 * 12 + (m0 - 1) - i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return keys;
}

function lastDayOfMonth(key: string): IsoDate {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return toIsoDate(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
}

export function computeCashFlowFeatures(input: FeatureInput): CashFlowSummary {
  const feeBps = input.provisionalFeeBps ?? DEFAULT_PROVISIONAL_FEE_BPS;
  const excluded = input.excludeTransactionIds;
  const txs = input.transactions
    .filter((t) => !t.pending && t.date <= input.asOf && !(excluded && excluded.has(t.id)))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Daily net flow and daily ending balances, reconstructed backward from the current balance.
  const dailyNet = new Map<IsoDate, number>();
  const dailyOut = new Map<IsoDate, number>();
  for (const t of txs) {
    dailyNet.set(t.date, (dailyNet.get(t.date) ?? 0) + t.amountCents);
    if (t.amountCents < 0) dailyOut.set(t.date, (dailyOut.get(t.date) ?? 0) - t.amountCents);
  }
  const balanceKnown = input.currentBalanceCents !== null;
  const endingBalance = new Map<IsoDate, number>();
  if (balanceKnown && txs.length > 0) {
    let bal = input.currentBalanceCents!;
    const first = txs[0]!.date;
    for (let d = input.asOf; d >= first; d = addDays(d, -1)) {
      endingBalance.set(d, bal);
      bal -= dailyNet.get(d) ?? 0;
    }
  }

  // Calendar month aggregation over full months before the as-of month, at most 12.
  const lastFullMonth = previousMonthKey(input.asOf);
  // A first month that starts partway through (the account was opened or linked mid month)
  // would understate revenue, so it is excluded unless it covers nearly the whole month.
  const firstTx = txs[0];
  const firstTxMonth = firstTx
    ? parseIsoDate(firstTx.date).day <= 7
      ? firstTx.date.slice(0, 7)
      : monthKeysEnding(firstTx.date.slice(0, 7), 1).map((k) => nextMonthKey(k))[0]!
    : undefined;
  const allKeys = monthKeysEnding(lastFullMonth, 12).filter(
    (k) => firstTxMonth !== undefined && k >= firstTxMonth,
  );
  const aggs = new Map<string, MonthAgg>(
    allKeys.map((k) => [
      k,
      {
        month: k,
        revenue: 0,
        operatingOut: 0,
        debt: 0,
        ownerDraw: 0,
        rent: 0,
        rentCount: 0,
        depositDays: new Set<string>(),
        nsf: 0,
      },
    ]),
  );
  for (const t of txs) {
    const agg = aggs.get(t.date.slice(0, 7));
    if (!agg) continue;
    if (t.amountCents > 0 && REVENUE_IN.has(t.category)) {
      agg.revenue += t.amountCents;
      agg.depositDays.add(t.date);
    } else if (t.category === 'REFUND') {
      agg.revenue += t.amountCents; // negative, nets against sales
    } else if (t.amountCents < 0 && OPERATING_OUT.has(t.category)) {
      agg.operatingOut -= t.amountCents;
      if (t.category === 'RENT') {
        agg.rent -= t.amountCents;
        agg.rentCount += 1;
      }
      if (t.category === 'NSF_FEE') agg.nsf += 1;
    } else if (t.amountCents < 0 && DEBT_OUT.has(t.category)) {
      agg.debt -= t.amountCents;
    } else if (t.amountCents < 0 && t.category === 'OWNER_DRAW') {
      agg.ownerDraw -= t.amountCents;
    }
  }

  const months = allKeys.map((k) => aggs.get(k)!);
  const monthly: MonthlyCashFlow[] = months.map((m) => ({
    month: m.month,
    revenueCents: Math.max(0, Math.round(m.revenue)),
    operatingOutflowsCents: Math.round(m.operatingOut),
    debtServiceCents: Math.round(m.debt),
    netCashFlowCents: Math.round(m.revenue - m.operatingOut - m.debt - m.ownerDraw),
    endingBalanceCents: endingBalance.get(lastDayOfMonth(m.month)) ?? null,
    depositDays: m.depositDays.size,
    nsfCount: m.nsf,
  }));

  const commerce = input.commerce ? summarizeCommerce(input.commerce, input.asOf, monthly) : null;

  // Revenue. The POS sees every sale on the day it happens, so when its sales reconcile with
  // bank deposits it is the better source for level, trend, and stability. Otherwise, or
  // without a POS, the bank's operating inflows are the verified figure.
  const bankRevenues = monthly.map((m) => m.revenueCents);
  const bankLast3 = bankRevenues.slice(-3);
  const bankPrior3 = bankRevenues.slice(-6, -3);
  const usePos =
    commerce !== null &&
    commerce.monthsOfHistory >= 3 &&
    (commerce.depositMatchBps === null || commerce.depositMatchBps >= MIN_DEPOSIT_MATCH_BPS);
  const verifiedMonthlyRevenueCents = usePos
    ? commerce.verifiedMonthlySalesCents
    : Math.round(mean(bankLast3));
  const revenueGrowthBps = usePos
    ? commerce.trendBps
    : bankPrior3.length === 3 && mean(bankPrior3) > 0
      ? bps(mean(bankLast3) - mean(bankPrior3), mean(bankPrior3))
      : 0;
  const revenueVolatilityBps = usePos
    ? commerce.volatilityBps
    : bankRevenues.length >= 3
      ? bps(stdev(bankRevenues), mean(bankRevenues))
      : 0;
  const revenues = bankRevenues;

  const monthlyOperatingOutflowsCents = Math.round(
    mean(monthly.map((m) => m.operatingOutflowsCents)),
  );
  const monthlyDebtServiceCents = Math.round(mean(monthly.map((m) => m.debtServiceCents)));
  const monthlyNetCashFlowCents = Math.round(mean(monthly.map((m) => m.netCashFlowCents)));
  const rentMonths = months.filter((m) => m.rentCount > 0);
  const observedRentCents =
    rentMonths.length > 0 ? Math.round(mean(rentMonths.map((m) => m.rent))) : null;

  // Trailing 90 day liquidity and conduct.
  const from90 = addDays(input.asOf, -89);
  const balances90: number[] = [];
  let negativeBalanceDays90 = 0;
  let outflow90 = 0;
  for (let d = from90; d <= input.asOf; d = addDays(d, 1)) {
    const b = endingBalance.get(d);
    if (b !== undefined) {
      balances90.push(b);
      if (b < 0) negativeBalanceDays90 += 1;
    }
    outflow90 += dailyOut.get(d) ?? 0;
  }
  const avgDailyOutflow = outflow90 / 90;
  const nsfCount90 = txs.filter((t) => t.category === 'NSF_FEE' && t.date >= from90).length;
  const nsfCount365 = txs.filter(
    (t) => t.category === 'NSF_FEE' && t.date >= addDays(input.asOf, -364),
  ).length;

  const currentBalanceCents = input.currentBalanceCents;
  const daysOfCashOnHand =
    currentBalanceCents === null
      ? null
      : avgDailyOutflow > 0
        ? Math.max(0, Math.floor(currentBalanceCents / avgDailyOutflow))
        : currentBalanceCents > 0
          ? 365
          : 0;

  const lowPointDaysOfCash90 =
    balances90.length === 0
      ? null
      : avgDailyOutflow > 0
        ? Math.max(0, Math.floor(Math.min(...balances90) / avgDailyOutflow))
        : Math.min(...balances90) > 0
          ? 365
          : 0;

  // Affordability. CashFlow pays the rent, so the rent the business already pays is freed up.
  const freeCash = monthlyNetCashFlowCents + (observedRentCents ?? 0);
  const rentCoverageRatio = coverageRatio(freeCash, input.requestedMonthlyRentCents, feeBps);

  const revenueTrend = computeRevenueTrend(txs, input.asOf, bankRevenues, revenueGrowthBps);

  return {
    asOf: input.asOf,
    monthsOfHistory: monthly.filter((m) => m.revenueCents > 0 || m.operatingOutflowsCents > 0)
      .length,
    balanceKnown,
    currentBalanceCents,
    verifiedMonthlyRevenueCents,
    trailingTwelveMonthRevenueCents: revenues.reduce((a, b) => a + b, 0),
    revenueGrowthBps,
    revenueVolatilityBps,
    depositDaysPerMonth: usePos
      ? commerce.salesDaysPerMonth
      : monthly.length > 0
        ? Math.round(mean(monthly.map((m) => m.depositDays)) * 10) / 10
        : 0,
    statedRevenueVarianceBps: bps(
      input.statedMonthlyRevenueCents - verifiedMonthlyRevenueCents,
      verifiedMonthlyRevenueCents,
    ),
    monthlyOperatingOutflowsCents,
    operatingMarginBps: bps(
      verifiedMonthlyRevenueCents - monthlyOperatingOutflowsCents,
      verifiedMonthlyRevenueCents,
    ),
    monthlyNetCashFlowCents,
    monthlyDebtServiceCents,
    debtToRevenueBps: Math.max(0, bps(monthlyDebtServiceCents, verifiedMonthlyRevenueCents)),
    observedRentCents,
    avgDailyBalance90Cents: balances90.length > 0 ? Math.round(mean(balances90)) : null,
    minBalance90Cents: balances90.length > 0 ? Math.min(...balances90) : null,
    daysOfCashOnHand,
    lowPointDaysOfCash90,
    negativeBalanceDays90,
    nsfCount90,
    nsfCount365,
    rentToRevenueBps:
      verifiedMonthlyRevenueCents > 0
        ? bps(input.requestedMonthlyRentCents, verifiedMonthlyRevenueCents)
        : 10_000,
    rentCoverageRatio,
    monthly,
    commerce,
    revenueTrend,
  };
}

/** Free cash over rent plus fee, times 100. 125 means 1.25x. */
export function coverageRatio(freeCashCents: number, rentCents: number, feeBps: number): number {
  const obligation = rentCents + feeForRent(rentCents, feeBps);
  return obligation > 0 ? Math.round((freeCashCents * 100) / obligation) : 0;
}

/** Free cash available for installments: net cash flow plus the rent CashFlow would now pay. */
export function freeCashCents(s: CashFlowSummary): number {
  return s.monthlyNetCashFlowCents + (s.observedRentCents ?? 0);
}

const WEEK = 7;

/**
 * Trend on daily windows of whole weeks, so weekday mix cancels out.
 *
 * The quarter over quarter figure on full calendar months lags a turn by up to a month and
 * cannot tell a seasonal trough from a decline. Two things fix that. Windows that end on the
 * as-of date see the most recent weeks. And a comparison with the same weeks a year earlier
 * is season neutral: a seasonal business in its slow months is level with last year, a
 * business in decline is not.
 */
export function computeRevenueTrend(
  txs: readonly BankTransaction[],
  asOf: IsoDate,
  monthlyRevenues: readonly number[],
  quarterGrowthBps: number,
): RevenueTrend {
  const first = txs[0]?.date;
  const historyDays = first ? daysBetween(first, asOf) + 1 : 0;
  const daily = new Map<IsoDate, number>();
  for (const t of txs) {
    if ((t.amountCents > 0 && REVENUE_IN.has(t.category)) || t.category === 'REFUND') {
      daily.set(t.date, (daily.get(t.date) ?? 0) + t.amountCents);
    }
  }
  /** Revenue over `days` days ending `endOffset` days before the as-of date. */
  const window = (endOffset: number, days: number): number => {
    let sum = 0;
    for (let i = endOffset; i < endOffset + days; i++) sum += daily.get(addDays(asOf, -i)) ?? 0;
    return Math.max(0, sum);
  };
  const change = (recent: number, base: number): number | null =>
    base > 0 ? bps(recent - base, base) : null;

  const recent4 = window(0, 4 * WEEK);
  const recent12 = window(0, 12 * WEEK);
  const recent4VsPrior12WeeksBps =
    historyDays >= 16 * WEEK ? change(recent4 * 3, window(4 * WEEK, 12 * WEEK)) : null;
  const recent12VsPrior12WeeksBps =
    historyDays >= 24 * WEEK ? change(recent12, window(12 * WEEK, 12 * WEEK)) : null;

  // The same four weeks a year earlier: 52 weeks back when the history reaches that far,
  // otherwise as far back as it does, down to 48 weeks.
  const lagWeeks = Math.min(52, Math.floor(historyDays / WEEK) - 4);
  const yearOverYearBps =
    lagWeeks >= 48 ? change(recent4, window(lagWeeks * WEEK, 4 * WEEK)) : null;

  const last6 = monthlyRevenues.slice(-6);
  let slope6Bps: number | null = null;
  if (last6.length === 6 && mean(last6) > 0) {
    const xBar = 2.5;
    let num = 0;
    let den = 0;
    last6.forEach((y, x) => {
      num += (x - xBar) * (y - mean(last6));
      den += (x - xBar) ** 2;
    });
    slope6Bps = bps(num / den, mean(last6));
  }

  return {
    recent4VsPrior12WeeksBps,
    recent12VsPrior12WeeksBps,
    yearOverYearBps,
    slope6Bps,
    compositeBps: compositeTrendBps({
      yearOverYearBps,
      recent12VsPrior12WeeksBps,
      quarterGrowthBps,
    }),
  };
}

/**
 * One trend figure for the scorecard. With a year of history it is the year over year
 * change in the trailing four weeks, which a seasonal trough does not move. Without a year
 * of history it is the trailing twelve weeks against the twelve before, and failing that the
 * calendar quarter figure.
 */
export function compositeTrendBps(t: {
  yearOverYearBps: number | null;
  recent12VsPrior12WeeksBps: number | null;
  quarterGrowthBps: number;
}): number {
  return t.yearOverYearBps ?? t.recent12VsPrior12WeeksBps ?? t.quarterGrowthBps;
}

interface SalesMonth {
  month: string;
  gross: number;
  refunds: number;
  chargebacks: number;
  net: number;
  days: Set<string>;
}

/**
 * Aggregate platform sales by full calendar month and compare them with the bank's operating
 * inflows over the same months. Months before the first sale are dropped, as for the bank.
 */
export function summarizeCommerce(
  commerce: NonNullable<FeatureInput['commerce']>,
  asOf: IsoDate,
  bankMonthly: MonthlyCashFlow[],
): CommerceSummary {
  const sales = commerce.dailySales
    .filter((d) => d.date <= asOf)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const lastFullMonth = previousMonthKey(asOf);
  const first = sales[0];
  const firstMonth = first
    ? parseIsoDate(first.date).day <= 7
      ? first.date.slice(0, 7)
      : nextMonthKey(first.date.slice(0, 7))
    : undefined;
  const keys = monthKeysEnding(lastFullMonth, 12).filter(
    (k) => firstMonth !== undefined && k >= firstMonth,
  );
  const months = new Map<string, SalesMonth>(
    keys.map((k) => [
      k,
      { month: k, gross: 0, refunds: 0, chargebacks: 0, net: 0, days: new Set<string>() },
    ]),
  );
  for (const d of sales) {
    const m = months.get(d.date.slice(0, 7));
    if (!m) continue;
    m.gross += d.grossCents;
    m.refunds += d.refundsCents;
    m.chargebacks += d.chargebacksCents;
    m.net += d.grossCents - d.refundsCents - d.chargebacksCents;
    if (d.grossCents > 0) m.days.add(d.date);
  }
  const rows = keys.map((k) => months.get(k)!);
  const nets = rows.map((m) => Math.max(0, m.net));
  const last3 = rows.slice(-3);
  const prior3 = nets.slice(-6, -3);
  const grossLast3 = last3.reduce((a, m) => a + m.gross, 0);
  const netLast3 = last3.reduce((a, m) => a + Math.max(0, m.net), 0);

  // Bank inflows over the same three months, when the bank has them.
  const bankByMonth = new Map(bankMonthly.map((m) => [m.month, m.revenueCents]));
  const comparable = last3.filter((m) => bankByMonth.has(m.month));
  const bankSum = comparable.reduce((a, m) => a + (bankByMonth.get(m.month) ?? 0), 0);
  const posSum = comparable.reduce((a, m) => a + Math.max(0, m.net), 0);
  const depositMatchBps =
    comparable.length === 0 || posSum === 0 ? null : Math.min(20_000, bps(bankSum, posSum));

  const { year, month } = parseIsoDate(asOf);
  const since = parseIsoDate(commerce.connectedSince);
  const monthsOnPlatform = Math.max(0, (year - since.year) * 12 + (month - since.month));

  return {
    platform: commerce.platform,
    monthsOfHistory: rows.filter((m) => m.gross > 0).length,
    monthsOnPlatform,
    verifiedMonthlySalesCents: last3.length > 0 ? Math.round(netLast3 / last3.length) : 0,
    salesDaysPerMonth:
      rows.length > 0 ? Math.round(mean(rows.map((m) => m.days.size)) * 10) / 10 : 0,
    refundRateBps: bps(
      last3.reduce((a, m) => a + m.refunds, 0),
      grossLast3,
    ),
    chargebackRateBps: bps(
      last3.reduce((a, m) => a + m.chargebacks, 0),
      grossLast3,
    ),
    trendBps:
      prior3.length === 3 && mean(prior3) > 0
        ? bps(mean(nets.slice(-3)) - mean(prior3), mean(prior3))
        : 0,
    volatilityBps: nets.length >= 3 ? bps(stdev(nets), mean(nets)) : 0,
    depositMatchBps,
  };
}

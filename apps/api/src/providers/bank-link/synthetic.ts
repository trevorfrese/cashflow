import { createHash } from 'node:crypto';

import type { BankTransaction, IsoDate, TransactionCategory } from '@cashflow/shared';
import { addDays, parseIsoDate } from '@cashflow/shared';

/**
 * Deterministic synthetic business bank history for the mock bank provider.
 *
 * The generator simulates a small brick and mortar business day by day: card settlements
 * on open days, weekly cash deposits, biweekly payroll, rent on the first, supplier runs,
 * utilities, insurance, software, quarterly taxes, owner draws, and any debt service. It
 * tracks the running balance and charges an NSF fee whenever a debit overdraws the account,
 * so account conduct emerges from the scenario rather than being hard coded.
 *
 * Scenarios are selected by keywords in the public token. Revenue and rent can be pinned with
 * `rev_<dollars>` and `rent_<dollars>` so the data lines up with what the applicant stated.
 */
export const SCENARIOS = [
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
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export interface ScenarioSpec {
  scenario: Scenario;
  monthlyRevenueCents: number;
  rentCents: number;
}

const DEFAULT_REVENUE_CENTS = 4_000_000;

export function parseScenario(token: string): ScenarioSpec {
  const lower = token.toLowerCase();
  const scenario = SCENARIOS.find((s) => lower.includes(s)) ?? 'healthy';
  const rev = /rev_(\d+)/.exec(lower);
  const rent = /rent_(\d+)/.exec(lower);
  const monthlyRevenueCents = rev ? Number(rev[1]) * 100 : DEFAULT_REVENUE_CENTS;
  const rentCents = rent ? Number(rent[1]) * 100 : Math.round(monthlyRevenueCents * 0.12);
  return { scenario, monthlyRevenueCents, rentCents };
}

/** Encode a spec into a provider item id so later calls can regenerate the same history. */
export function encodeItemId(spec: ScenarioSpec, seedHex: string): string {
  return `mock_item_${spec.scenario}_r${spec.monthlyRevenueCents}_l${spec.rentCents}_${seedHex}`;
}

export function decodeItemId(itemId: string): { spec: ScenarioSpec; seedHex: string } {
  const m = /^mock_item_([a-z_]+)_r(\d+)_l(\d+)_([0-9a-f]+)$/.exec(itemId);
  if (!m) {
    // Legacy or foreign id: fall back to a healthy history seeded from the id itself.
    return {
      spec: parseScenario('healthy'),
      seedHex: createHash('sha256').update(itemId).digest('hex').slice(0, 12),
    };
  }
  const scenario = (SCENARIOS as readonly string[]).includes(m[1]!)
    ? (m[1] as Scenario)
    : 'healthy';
  return {
    spec: { scenario, monthlyRevenueCents: Number(m[2]), rentCents: Number(m[3]) },
    seedHex: m[4]!,
  };
}

interface Params {
  /** Annual revenue trend, as a fraction. 0.4 means revenue ends the year 40% above where it started. */
  trend: number;
  /** Seasonal amplitude, as a fraction of revenue. */
  seasonality: number;
  /** Day to day noise on sales (log scale sigma). */
  dailyNoise: number;
  /** Month to month noise on the revenue level. */
  monthlyNoise: number;
  /** Outflow ratios, as fractions of monthly revenue. */
  payroll: number;
  supplier: number;
  utilities: number;
  insurance: number;
  software: number;
  taxQuarterly: number;
  ownerDraw: number;
  loan: number;
  mcaDaily: number;
  /** Opening balance in months of revenue. */
  openingBalanceMonths: number;
  /** Days of history to generate. */
  days: number;
  /** Number of unplanned large debits in the last 90 days. */
  shocks: number;
  /** Optional step down: after `at` (fraction of the history) revenue slides down by `depth`. */
  collapse?: { at: number; depth: number };
}

const BASE: Params = {
  trend: 0.06,
  seasonality: 0.08,
  dailyNoise: 0.14,
  monthlyNoise: 0.05,
  payroll: 0.3,
  supplier: 0.28,
  utilities: 0.025,
  insurance: 0.012,
  software: 0.01,
  taxQuarterly: 0.04,
  ownerDraw: 0.06,
  loan: 0.02,
  mcaDaily: 0,
  openingBalanceMonths: 1.1,
  days: 365,
  shocks: 0,
};

const PARAMS: Record<Scenario, Params> = {
  healthy: BASE,
  growing: { ...BASE, trend: 0.45 },
  thin_margin: {
    ...BASE,
    payroll: 0.34,
    supplier: 0.36,
    ownerDraw: 0.08,
    openingBalanceMonths: 0.2,
  },
  declining: {
    ...BASE,
    trend: -0.1,
    openingBalanceMonths: 0.6,
    collapse: { at: 0.6, depth: 0.55 },
  },
  volatile: { ...BASE, dailyNoise: 0.5, monthlyNoise: 0.3 },
  overdrafts: {
    ...BASE,
    payroll: 0.32,
    supplier: 0.32,
    ownerDraw: 0.08,
    openingBalanceMonths: 0.12,
    shocks: 5,
  },
  heavy_debt: { ...BASE, loan: 0.07, mcaDaily: 0.1, openingBalanceMonths: 0.5 },
  seasonal: { ...BASE, seasonality: 0.45 },
  new_business: { ...BASE, days: 120, openingBalanceMonths: 0.6 },
  low_balance: { ...BASE, openingBalanceMonths: 0.04, ownerDraw: 0.1 },
  no_balance: { ...BASE, days: 0 },
};

/** Small deterministic PRNG so every token yields the same history. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function weekday(iso: IsoDate): number {
  const { year, month, day } = parseIsoDate(iso);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 Sunday .. 6 Saturday
}

function dayOfYear(iso: IsoDate): number {
  const { year, month, day } = parseIsoDate(iso);
  const start = Date.UTC(year, 0, 1);
  return Math.floor((Date.UTC(year, month - 1, day) - start) / 86_400_000);
}

// Sales mix by weekday, closed Mondays. Normalized so a week sums to the weekly target.
const WEEKDAY_WEIGHT = [1.1, 0, 0.8, 0.8, 0.9, 1.4, 1.5];
const WEEK_WEIGHT_SUM = WEEKDAY_WEIGHT.reduce((a, b) => a + b, 0);

export interface SyntheticHistory {
  transactions: BankTransaction[];
  currentBalanceCents: number | null;
}

export function generateHistory(
  spec: ScenarioSpec,
  seedHex: string,
  asOf: IsoDate,
): SyntheticHistory {
  const p = PARAMS[spec.scenario];
  if (p.days === 0) return { transactions: [], currentBalanceCents: null };

  const rand = mulberry32(parseInt(seedHex.slice(0, 8), 16) || 1);
  const txs: BankTransaction[] = [];
  let n = 0;
  const push = (
    date: IsoDate,
    amountCents: number,
    description: string,
    category: TransactionCategory,
  ) => {
    if (amountCents === 0) return;
    txs.push({ id: `${seedHex}-${++n}`, date, amountCents, description, category, pending: false });
  };

  const weeklyRevenue = (spec.monthlyRevenueCents * 12) / 52;
  let balance = Math.round(spec.monthlyRevenueCents * p.openingBalanceMonths);
  let negativeStreak = 0;
  let monthLevel = 1;
  let currentMonth = '';
  const start = addDays(asOf, -(p.days - 1));
  const shockDays = new Set<number>();
  for (let i = 0; i < p.shocks; i++) shockDays.add(p.days - 1 - Math.floor(rand() * 85));

  for (let i = 0; i < p.days; i++) {
    const date = addDays(start, i);
    const { day, month } = parseIsoDate(date);
    const monthKey = date.slice(0, 7);
    if (monthKey !== currentMonth) {
      currentMonth = monthKey;
      monthLevel = Math.exp(normal(rand) * p.monthlyNoise);
    }
    const progress = i / Math.max(p.days - 1, 1);
    let trendFactor = 1 + p.trend * (progress - 0.5);
    if (p.collapse && progress > p.collapse.at) {
      trendFactor *= 1 - (p.collapse.depth * (progress - p.collapse.at)) / (1 - p.collapse.at);
    }
    const seasonFactor =
      1 + p.seasonality * Math.sin(((dayOfYear(date) - 105) / 365) * 2 * Math.PI);
    const level = trendFactor * seasonFactor * monthLevel;
    const dow = weekday(date);
    const monthly = spec.monthlyRevenueCents * level;

    // Inflows
    const dayShare = WEEKDAY_WEIGHT[dow]! / WEEK_WEIGHT_SUM;
    if (dayShare > 0) {
      const sales = weeklyRevenue * level * dayShare * Math.exp(normal(rand) * p.dailyNoise);
      push(date, Math.round(sales * 0.85), 'SQUARE INC SETTLEMENT', 'CARD_SETTLEMENT');
      balance += Math.round(sales * 0.85);
      if (dow === 2) {
        const cash = Math.round(weeklyRevenue * level * 0.15);
        push(date, cash, 'CASH DEPOSIT BRANCH 0142', 'CASH_DEPOSIT');
        balance += cash;
      }
    }

    // Outflows. A debit that overdraws the account draws one NSF fee for the day.
    let nsfChargedToday = false;
    const debit = (amount: number, description: string, category: TransactionCategory) => {
      const cents = -Math.round(amount);
      if (cents === 0) return;
      push(date, cents, description, category);
      balance += cents;
      if (balance < 0 && !nsfChargedToday) {
        push(date, -3500, 'NSF FEE', 'NSF_FEE');
        balance -= 3500;
        nsfChargedToday = true;
      }
    };

    if (dow === 5 && Math.floor(i / 7) % 2 === 0) {
      debit(((monthly * p.payroll) / 26) * 12, 'GUSTO PAYROLL', 'PAYROLL');
    }
    if (day === 1) debit(spec.rentCents, 'RENT - HARBOR VIEW PROPERTIES', 'RENT');
    if (dow === 1 || dow === 3 || dow === 5) {
      debit(
        ((monthly * p.supplier) / 13) * Math.exp(normal(rand) * 0.2),
        dow === 3 ? 'SYSCO FOODS' : 'RESTAURANT DEPOT',
        'SUPPLIER',
      );
    }
    if (day === 10) debit(monthly * p.utilities, 'CITY POWER & GAS', 'UTILITIES');
    if (day === 15) debit(monthly * p.insurance, 'HARTFORD BUSINESS INS', 'INSURANCE');
    if (day === 5) debit(monthly * p.software, 'TOAST POS SUBSCRIPTION', 'SOFTWARE');
    if (day === 28) debit(2500, 'MONTHLY SERVICE FEE', 'BANK_FEE');
    if (day === 15 && [1, 4, 6, 9].includes(month)) {
      debit(monthly * p.taxQuarterly * 3, 'IRS EFTPS PAYMENT', 'TAX');
    }
    if (day === 20) debit(monthly * p.ownerDraw, 'OWNER DRAW - TRANSFER', 'OWNER_DRAW');
    if (day === 3 && p.loan > 0) debit(monthly * p.loan, 'LOAN PMT - SBA 7A', 'LOAN_PAYMENT');
    if (p.mcaDaily > 0 && dow >= 1 && dow <= 5) {
      debit((monthly * p.mcaDaily) / 22, 'MCA DAILY ACH - RAPID FUNDING', 'MCA_PAYMENT');
    }
    if (dow === 4 && rand() < 0.5) {
      debit(monthly * 0.004 * rand(), 'REFUND - CUSTOMER', 'REFUND');
    }
    if (shockDays.has(i)) {
      debit(monthly * 0.18, 'EQUIPMENT REPAIR - ACE HVAC', 'OTHER_EXPENSE');
    }

    // Owners do not leave an account overdrawn for long. After two negative days the owner
    // moves money in from personal savings, which is why conduct problems show up as a
    // pattern of fees and short negative stretches rather than a permanently negative balance.
    if (balance < 0) {
      negativeStreak += 1;
      if (negativeStreak >= 2) {
        const topUp = -balance + Math.round(monthly * 0.03);
        push(date, topUp, 'OWNER CAPITAL CONTRIBUTION', 'TRANSFER_IN');
        balance += topUp;
        negativeStreak = 0;
      }
    } else {
      negativeStreak = 0;
    }
  }

  return { transactions: txs, currentBalanceCents: balance };
}

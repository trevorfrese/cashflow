import { createHash } from 'node:crypto';

import type { BankTransaction, IsoDate } from '@cashflow/shared';
import { addDays, daysBetween } from '@cashflow/shared';

import {
  BusinessSimulation,
  mulberry32,
  seedFromHex,
  type BusinessParams,
  type HazardEvent,
} from './business-sim.ts';

export {
  simulateBusiness,
  type ExternalDebit,
  type ForwardParams,
  type HazardEvent,
  type SimulateHooks,
  type SimulatedBusiness,
} from './business-sim.ts';

/**
 * Deterministic synthetic business bank history for the mock bank provider.
 *
 * The generator simulates a small brick and mortar business day by day: card settlements
 * on open days, weekly cash deposits, biweekly payroll, rent on the first, supplier runs,
 * utilities, insurance, software, quarterly taxes, owner draws, and any debt service. It
 * tracks the running balance and charges an NSF fee whenever a debit overdraws the account,
 * so account conduct emerges from the scenario rather than being hard coded.
 *
 * The day by day mechanics live in `business-sim.ts`. This file maps the named scenarios onto
 * that core over a window ending at the as-of date; `simulateBusiness` drives the same core
 * forward from a start date for the portfolio evals.
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
  'batched',
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

/**
 * Sandbox keywords that change what the aggregator reports about the account, not the
 * history's cash flows. See `apps/api/README.md`.
 */
export const BANK_FLAGS = [
  /** A personal account in the owner's name (a sole proprietor's account). */
  'personal',
  /** The account belongs to a different business. */
  'borrowed',
  /** Opened recently: 60 days before it was linked. */
  'new_account',
  /** Two more accounts on the same login that were not shared. */
  'hidden',
  /** A legacy connection, not authorized through the bank's own OAuth. */
  'legacy',
  /** Pulls after the link date leave out overdraft fees and debt payments: rewritten history. */
  'rewrites',
  /** Consent expires after the link date: later pulls need the owner to reconnect. */
  'expired',
] as const;
export type BankFlag = (typeof BANK_FLAGS)[number];

export function parseBankFlags(token: string): BankFlag[] {
  const lower = token.toLowerCase();
  return BANK_FLAGS.filter((f) => lower.includes(f));
}

/** Encode a spec into a provider item id so later calls can regenerate the same history. */
export function encodeItemId(
  spec: ScenarioSpec,
  seedHex: string,
  anchor?: IsoDate,
  flags: readonly BankFlag[] = [],
): string {
  const base = `mock_item_${spec.scenario}_r${spec.monthlyRevenueCents}_l${spec.rentCents}_${seedHex}`;
  const a = anchor ? `_a${anchor.replaceAll('-', '')}` : '';
  const x = flags.length > 0 ? `_x${flags.join('-')}` : '';
  return `${base}${a}${x}`;
}

export interface DecodedItem {
  spec: ScenarioSpec;
  seedHex: string;
  /** The date the link was made: the history is anchored there and continues forward. */
  anchor: IsoDate | null;
  flags: BankFlag[];
}

export function decodeItemId(itemId: string): DecodedItem {
  const m = /^mock_item_([a-z_]+)_r(\d+)_l(\d+)_([0-9a-f]+)(?:_a(\d{8}))?(?:_x([a-z_-]+))?$/.exec(
    itemId,
  );
  if (!m) {
    // Legacy or foreign id: fall back to a healthy history seeded from the id itself.
    return {
      spec: parseScenario('healthy'),
      seedHex: createHash('sha256').update(itemId).digest('hex').slice(0, 12),
      anchor: null,
      flags: [],
    };
  }
  const scenario = (SCENARIOS as readonly string[]).includes(m[1]!)
    ? (m[1] as Scenario)
    : 'healthy';
  const a = m[5];
  return {
    spec: { scenario, monthlyRevenueCents: Number(m[2]), rentCents: Number(m[3]) },
    seedHex: m[4]!,
    anchor: a ? `${a.slice(0, 4)}-${a.slice(4, 6)}-${a.slice(6, 8)}` : null,
    flags: (m[6]?.split('-') ?? []).filter((f): f is BankFlag =>
      (BANK_FLAGS as readonly string[]).includes(f),
    ),
  };
}

/** Scenario parameter set: the business ratios plus how the sandbox window is shaped. */
interface Params extends Omit<BusinessParams, 'monthlyRevenueCents' | 'rentCents'> {
  /** Annual revenue trend, as a fraction. 0.4 means revenue ends the year 40% above where it started. */
  trend: number;
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
  // Card sales are settled every other week, so monthly deposits swing with the number of
  // settlement days in the month even though daily sales are steady.
  batched: { ...BASE, batchedSettlement: true },
};

/**
 * The ratios of a named scenario as continuous business parameters, for callers that want to
 * start from an archetype and vary it.
 */
export function scenarioParams(
  scenario: Scenario,
): Omit<BusinessParams, 'monthlyRevenueCents' | 'rentCents'> {
  const {
    trend: _trend,
    days: _days,
    shocks: _shocks,
    collapse: _collapse,
    ...rest
  } = PARAMS[scenario];
  return rest;
}

export interface SyntheticHistory {
  transactions: BankTransaction[];
  currentBalanceCents: number | null;
}

export function generateHistory(
  spec: ScenarioSpec,
  seedHex: string,
  asOf: IsoDate,
): SyntheticHistory {
  const sim = windowSimulation(spec, seedHex, asOf);
  if (!sim) return { transactions: [], currentBalanceCents: null };
  return { transactions: sim.transactions, currentBalanceCents: sim.balanceCents };
}

/**
 * The history as it stands on `asOf` for an account linked on `anchor`. Up to the anchor it is
 * exactly `generateHistory(spec, seedHex, anchor)`. After it the same account keeps going one
 * day at a time at the level it had reached, so a pull made later sees the earlier pull's
 * history unchanged, plus the days since. That is what a real account does, and what the
 * consistency check compares. Before this existed, the sandbox regenerated a whole new year
 * on every date.
 */
export function generateHistoryAt(
  spec: ScenarioSpec,
  seedHex: string,
  anchor: IsoDate,
  asOf: IsoDate,
): SyntheticHistory {
  const extra = daysBetween(anchor, asOf);
  const sim = windowSimulation(spec, seedHex, anchor, Math.max(0, extra));
  if (!sim) return { transactions: [], currentBalanceCents: null };
  return { transactions: sim.transactions, currentBalanceCents: sim.balanceCents };
}

function windowSimulation(
  spec: ScenarioSpec,
  seedHex: string,
  asOf: IsoDate,
  extraDays = 0,
): BusinessSimulation | null {
  const p = PARAMS[spec.scenario];
  if (p.days === 0) return null;

  const rand = mulberry32(seedFromHex(seedHex));
  const start = addDays(asOf, -(p.days - 1));
  // Unplanned repair bills land on random days in the last 85 days of the window.
  const shockDays = new Set<number>();
  for (let i = 0; i < p.shocks; i++) shockDays.add(p.days - 1 - Math.floor(rand() * 85));
  const events: HazardEvent[] = [...shockDays].map((i) => ({
    kind: 'expense',
    date: addDays(start, i),
    shareOfMonthly: 0.18,
  }));

  // The sandbox trend is defined relative to the window, so the as-of date always sits at the
  // same point of the story whatever day the token is linked. After the window the level
  // holds where it ended.
  const span = Math.max(p.days - 1, 1);
  const collapse = p.collapse;
  const trendFactor = (i: number): number => {
    const progress = Math.min(1, i / span);
    let factor = 1 + p.trend * (progress - 0.5);
    if (collapse && progress > collapse.at) {
      factor *= 1 - (collapse.depth * (progress - collapse.at)) / (1 - collapse.at);
    }
    return factor;
  };

  const sim = new BusinessSimulation({
    params: { ...p, monthlyRevenueCents: spec.monthlyRevenueCents, rentCents: spec.rentCents },
    seedHex,
    start,
    rand,
    trendFactor,
    events,
  });
  for (let i = 0; i < p.days + extraDays; i++) sim.step();
  return sim;
}

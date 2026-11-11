import { createHash } from 'node:crypto';

import type { BankTransaction, IsoDate } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';

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
  const p = PARAMS[spec.scenario];
  if (p.days === 0) return { transactions: [], currentBalanceCents: null };

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
  // same point of the story whatever day the token is linked.
  const span = Math.max(p.days - 1, 1);
  const collapse = p.collapse;
  const trendFactor = (i: number): number => {
    const progress = i / span;
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
  for (let i = 0; i < p.days; i++) sim.step();
  return { transactions: sim.transactions, currentBalanceCents: sim.balanceCents };
}

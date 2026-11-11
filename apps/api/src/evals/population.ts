import type { CommercePlatform, IsoDate } from '@cashflow/shared';
import { addDays, dueDateInMonth, parseIsoDate } from '@cashflow/shared';

import {
  createForwardSimulation,
  type ForwardParams,
  type HazardEvent,
} from '../providers/bank-link/business-sim.ts';
import { scenarioParams, type Scenario } from '../providers/bank-link/synthetic.ts';
import { ASSUMPTIONS } from './assumptions.ts';
import { clamp, createRng, type Rng } from './random.ts';

/**
 * A synthetic population of rent advance applicants.
 *
 * Each applicant is a business with continuous parameters drawn around one of the sandbox
 * archetypes, a latent health value the underwriting engine never sees, and a list of dated
 * hazard events (revenue shocks, slow declines, closure, surprise bills) whose odds depend on
 * that latent health. Observable traits (margin, cash buffer, debt, trend) are correlated
 * with latent health but noisy, so a score built on the bank history can rank risk only
 * imperfectly, as in life.
 *
 * A small share of applicants are fraud archetypes:
 *   - `inflated_revenue`: states more revenue than the business has and asks for rent sized
 *     to the lie.
 *   - `round_trip`: pads bank revenue in the months before applying with deposits that leave
 *     again two days later, and asks for a lease the real revenue cannot carry.
 *   - `bust_out`: a short, clean looking history, a requested rent several times the rent
 *     seen in the account, and the account is emptied within days of approval.
 *
 * All numbers here are choices, not measurements. They are documented in
 * `apps/api/evals/README.md` together with the bad rates they produce.
 */

export const FRAUD_TYPES = ['inflated_revenue', 'round_trip', 'bust_out'] as const;
export type FraudType = (typeof FRAUD_TYPES)[number];

export const INDUSTRIES = [
  'restaurant',
  'retail',
  'personal_services',
  'fitness',
  'professional_services',
  'auto_services',
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export interface Applicant {
  id: string;
  /** Seed for this business's bank and point of sale streams. */
  seedHex: string;
  archetype: Scenario;
  fraud: FraudType | null;
  /** Reporting label: the fraud type for fraud applicants, otherwise the archetype. */
  segment: string;
  industry: Industry;
  /** Month of the arrival window in which the application lands. 0 is the first. */
  arrivalMonth: number;
  applicationDate: IsoDate;
  /** Days of bank history that exist on the application date. 0 means no bank is linked. */
  historyDays: number;
  timeInBusinessMonths: number;
  statedMonthlyRevenueCents: number;
  /** Monthly rent on the lease the applicant wants fronted. */
  requestedRentCents: number;
  pos: { platform: CommercePlatform; days: number } | null;
  /** Hidden health, standard normal across honest applicants. Higher is healthier. */
  latentHealth: number;
  /** Bank simulation parameters. Hazard events are dated. */
  params: ForwardParams;
}

export interface PopulationConfig {
  n: number;
  seed: string | number;
  /** First day of the first arrival month. */
  startDate: IsoDate;
  arrivalMonths: number;
  /** Month over month growth in applications, in basis points. */
  monthlyGrowthBps: number;
  /** Relative weights of the archetypes among honest applicants. */
  mix: Readonly<Record<Scenario, number>>;
  /** Share of all applicants that are fraud archetypes, in basis points. */
  fraudShareBps: number;
  fraudMix: Readonly<Record<FraudType, number>>;
}

export const DEFAULT_MIX: Readonly<Record<Scenario, number>> = {
  healthy: 30,
  growing: 8,
  thin_margin: 14,
  declining: 5,
  volatile: 7,
  overdrafts: 6,
  heavy_debt: 7,
  seasonal: 7,
  new_business: 6,
  low_balance: 6,
  no_balance: 1,
  batched: 3,
};

export const DEFAULT_POPULATION: Omit<PopulationConfig, 'n' | 'seed'> = {
  startDate: ASSUMPTIONS.startDate,
  arrivalMonths: ASSUMPTIONS.arrivalMonths,
  monthlyGrowthBps: ASSUMPTIONS.monthlyGrowthBps,
  mix: DEFAULT_MIX,
  fraudShareBps: 300,
  fraudMix: { inflated_revenue: 40, round_trip: 35, bust_out: 25 },
};

/** How each archetype shifts the things the engine cannot or can only partly see. */
interface ArchetypeProfile {
  /** Mean of latent health for the archetype. */
  health: number;
  /** Mean cash margin before rent, after every other cost, owner draws, and debt. */
  marginBeforeRent: number;
  /** Mean annual revenue growth. */
  growth: number;
}

const PROFILES: Record<Scenario, ArchetypeProfile> = {
  healthy: { health: 0.4, marginBeforeRent: 0.16, growth: 0.04 },
  growing: { health: 0.5, marginBeforeRent: 0.17, growth: 0.35 },
  thin_margin: { health: -0.4, marginBeforeRent: 0.11, growth: 0.02 },
  declining: { health: -0.9, marginBeforeRent: 0.14, growth: -0.08 },
  volatile: { health: -0.3, marginBeforeRent: 0.15, growth: 0.03 },
  overdrafts: { health: -0.8, marginBeforeRent: 0.1, growth: 0.0 },
  heavy_debt: { health: -0.6, marginBeforeRent: 0.11, growth: 0.02 },
  seasonal: { health: 0.0, marginBeforeRent: 0.16, growth: 0.04 },
  new_business: { health: -0.2, marginBeforeRent: 0.14, growth: 0.15 },
  low_balance: { health: -0.3, marginBeforeRent: 0.14, growth: 0.03 },
  no_balance: { health: 0.0, marginBeforeRent: 0.15, growth: 0.03 },
  batched: { health: 0.2, marginBeforeRent: 0.16, growth: 0.04 },
};

interface IndustryProfile {
  weight: number;
  /** Multiplier on the closure hazard. */
  closure: number;
  /** Added to seasonal amplitude. */
  seasonality: number;
  /** Median monthly revenue in cents. */
  medianRevenueCents: number;
}

const INDUSTRY_PROFILES: Record<Industry, IndustryProfile> = {
  restaurant: { weight: 35, closure: 1.25, seasonality: 0.02, medianRevenueCents: 4_500_000 },
  retail: { weight: 25, closure: 1.1, seasonality: 0.08, medianRevenueCents: 3_800_000 },
  personal_services: { weight: 15, closure: 0.9, seasonality: 0, medianRevenueCents: 2_200_000 },
  fitness: { weight: 8, closure: 1.1, seasonality: 0.05, medianRevenueCents: 3_000_000 },
  professional_services: {
    weight: 10,
    closure: 0.7,
    seasonality: 0,
    medianRevenueCents: 3_500_000,
  },
  auto_services: { weight: 7, closure: 0.85, seasonality: 0.02, medianRevenueCents: 5_000_000 },
};

/**
 * Monthly hazard rates at latent health 0, and how steeply each falls as health rises
 * (`rate * exp(-slope * health)`). At health 0 the closure rate is about 2.6% a year; at
 * health -1.5 it is about 10% a year, and at +1.5 about 0.7%.
 */
export const HAZARDS = {
  closure: { monthly: 0.0022, slope: 0.9 },
  shock: { monthly: 0.01, slope: 0.4 },
  decline: { monthly: 0.004, slope: 0.7 },
  expense: { monthly: 0.03, slope: 0.3 },
  /** Businesses under two years old close this much more often. */
  youngMultiplier: 1.5,
  /** Months of forward hazards drawn after the application date. */
  months: 30,
} as const;

const PLATFORMS: readonly CommercePlatform[] = ['SQUARE', 'TOAST', 'SHOPIFY', 'CLOVER', 'STRIPE'];

function roundTo(cents: number, increment: number): number {
  return Math.max(increment, Math.round(cents / increment) * increment);
}

/** Dated hazards from the day after the application onward. */
function drawForwardHazards(
  rng: Rng,
  applicationDate: IsoDate,
  health: number,
  closureMultiplier: number,
): HazardEvent[] {
  const events: HazardEvent[] = [];
  const rate = (h: { monthly: number; slope: number }) => h.monthly * Math.exp(-h.slope * health);
  let closed = false;
  for (let m = 0; m < HAZARDS.months; m++) {
    const date = addDays(applicationDate, 1 + m * 30 + rng.int(0, 29));
    if (!closed && rng.chance(rate(HAZARDS.closure) * closureMultiplier)) {
      events.push({ kind: 'closure', date });
      closed = true;
    }
    if (rng.chance(rate(HAZARDS.shock))) {
      events.push({
        kind: 'revenue_shock',
        start: date,
        days: rng.int(30, 120),
        depth: rng.uniform(0.2, 0.6),
      });
    }
    if (rng.chance(rate(HAZARDS.decline))) {
      events.push({
        kind: 'decline',
        start: date,
        rampDays: rng.int(60, 180),
        depth: rng.uniform(0.2, 0.5),
      });
    }
    if (rng.chance(rate(HAZARDS.expense))) {
      events.push({ kind: 'expense', date, shareOfMonthly: rng.uniform(0.08, 0.25) });
    }
  }
  return events;
}

/** Did the business shut before it could apply. Dead businesses do not fill in forms. */
function closedBeforeApplying(applicant: Applicant): boolean {
  if (applicant.historyDays <= 0) return false;
  const sim = createForwardSimulation(
    applicant.params,
    applicant.seedHex,
    addDays(applicant.applicationDate, -(applicant.historyDays - 1)),
  );
  sim.record = false;
  for (let i = 0; i < applicant.historyDays && !sim.closed; i++) sim.step();
  return sim.closed;
}

/** Redraws allowed for an applicant whose business does not survive its own history. */
const MAX_REDRAWS = 25;

/**
 * Applicant `index`, conditioned on the business still trading on its application date. A
 * draw that runs out of money during its own history is thrown away and drawn again, the
 * same survivorship filter the real applicant pool has been through.
 */
function drawApplicant(config: PopulationConfig, index: number): Applicant {
  let applicant = drawCandidate(config, index, 0);
  for (let attempt = 1; attempt <= MAX_REDRAWS && closedBeforeApplying(applicant); attempt++) {
    applicant = drawCandidate(config, index, attempt);
  }
  return applicant;
}

function drawCandidate(config: PopulationConfig, index: number, attempt: number): Applicant {
  const rng = createRng(config.seed, `applicant/${index}/${attempt}`);
  const seedHex = Math.floor(rng.next() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');

  // Arrival: later months get more applications, at the configured growth rate.
  const growth = 1 + config.monthlyGrowthBps / 10_000;
  const monthWeights: Record<string, number> = {};
  for (let m = 0; m < config.arrivalMonths; m++) monthWeights[String(m)] = growth ** m;
  const arrivalMonth = Number(rng.weighted(monthWeights));
  const start = parseIsoDate(config.startDate);
  const monthIndex = start.month - 1 + arrivalMonth;
  const applicationDate = dueDateInMonth(
    start.year + Math.floor(monthIndex / 12),
    (monthIndex % 12) + 1,
    rng.int(1, 28),
  );

  const fraud: FraudType | null = rng.chance(config.fraudShareBps / 10_000)
    ? rng.weighted(config.fraudMix)
    : null;
  // What the business looks like on paper. Fraud archetypes pick their own disguise.
  const archetype: Scenario =
    fraud === 'bust_out'
      ? 'healthy'
      : fraud !== null
        ? rng.weighted({ thin_margin: 2, low_balance: 1, healthy: 1 })
        : rng.weighted(config.mix);
  const profile = PROFILES[archetype];
  const industry = rng.weighted(
    Object.fromEntries(INDUSTRIES.map((k) => [k, INDUSTRY_PROFILES[k].weight])) as Record<
      Industry,
      number
    >,
  );
  const industryProfile = INDUSTRY_PROFILES[industry];

  // Latent health. The engine never sees it. Fraud applicants other than bust outs are
  // businesses in trouble; a bust out has no intention of repaying, so health is moot.
  const latentHealth =
    fraud === 'round_trip' || fraud === 'inflated_revenue'
      ? rng.normal(-1.0, 0.8)
      : rng.normal(profile.health, 1);
  // What shows up in the account: correlated with health, far from perfectly.
  const shownHealth = fraud === 'bust_out' ? rng.normal(0.8, 0.5) : latentHealth;

  // Age and history.
  let timeInBusinessMonths = Math.round(clamp(rng.lognormal(48, 0.8), 7, 360));
  if (archetype === 'new_business') timeInBusinessMonths = rng.int(3, 9);
  if (fraud === 'bust_out') timeInBusinessMonths = rng.int(8, 14);
  let historyDays = Math.min(400, timeInBusinessMonths * 30);
  if (fraud === 'bust_out') historyDays = rng.int(230, 330);
  if (archetype === 'no_balance') historyDays = 0;

  // Size, rent, and cost structure.
  const revenueAtApplication = clamp(
    rng.lognormal(industryProfile.medianRevenueCents, 0.6),
    600_000,
    40_000_000,
  );
  let rentShare = clamp(rng.lognormal(0.1, 0.4), 0.03, 0.3);
  // About one in ten honest applicants is rent burdened: the lease is too big for the shop.
  if (fraud === null && rng.chance(0.1)) rentShare = clamp(rentShare * rng.uniform(1.8, 3), 0, 0.6);
  let rentCents = roundTo(revenueAtApplication * rentShare, 5000);

  const base = scenarioParams(archetype);
  const annualGrowth = clamp(profile.growth + 0.05 * shownHealth + rng.normal(0, 0.06), -0.3, 0.8);
  const jitter = (value: number, sigma: number) => value * rng.lognormal(1, sigma);
  const utilities = jitter(base.utilities, 0.2);
  const insurance = jitter(base.insurance, 0.2);
  const software = jitter(base.software, 0.2);
  const taxQuarterly = jitter(base.taxQuarterly, 0.2);
  const ownerDraw = jitter(base.ownerDraw, 0.3);
  let loan = rng.chance(0.4) ? 0 : jitter(base.loan, 0.5);
  let mcaDaily = base.mcaDaily;
  if (archetype === 'heavy_debt') {
    loan = rng.uniform(0.04, 0.09);
    mcaDaily = rng.uniform(0.04, 0.12);
  } else if (rng.chance(clamp(0.04 - 0.03 * shownHealth, 0, 0.2))) {
    mcaDaily = rng.uniform(0.02, 0.05);
  }
  const marginBeforeRent = profile.marginBeforeRent + 0.03 * shownHealth + rng.normal(0, 0.03);
  const fixed = utilities + insurance + software + taxQuarterly + ownerDraw + loan + mcaDaily;
  const variable = clamp(1 - marginBeforeRent - fixed, 0.3, 0.95);
  const payrollShare = clamp(
    (base.payroll / (base.payroll + base.supplier)) * rng.lognormal(1, 0.15),
    0.3,
    0.7,
  );

  const openingBalanceMonths = clamp(
    base.openingBalanceMonths * rng.lognormal(1, 0.5) * Math.exp(0.25 * shownHealth),
    0.01,
    4,
  );
  const ownerReserveCents = Math.round(
    revenueAtApplication * rng.lognormal(0.35 * Math.exp(0.5 * latentHealth), 0.7),
  );

  // Events before the application that the archetype is known for.
  const events: HazardEvent[] = [];
  if (archetype === 'declining') {
    events.push({
      kind: 'decline',
      start: addDays(applicationDate, -rng.int(60, 200)),
      rampDays: rng.int(60, 150),
      depth: rng.uniform(0.25, 0.55),
    });
  }
  if (archetype === 'overdrafts') {
    const bills = rng.int(3, 6);
    for (let i = 0; i < bills; i++) {
      events.push({
        kind: 'expense',
        date: addDays(applicationDate, -rng.int(1, 88)),
        shareOfMonthly: rng.uniform(0.12, 0.2),
      });
    }
  }

  // Fraud dressing.
  let statedMonthlyRevenueCents = roundTo(
    revenueAtApplication * (rng.chance(0.15) ? rng.uniform(1.1, 1.3) : rng.lognormal(1, 0.08)),
    10_000,
  );
  let requestedRentCents = rentCents;
  if (fraud === 'inflated_revenue') {
    const inflation = rng.uniform(1.25, 2.2);
    statedMonthlyRevenueCents = roundTo(revenueAtApplication * inflation, 10_000);
    // The lease is sized to the story, not to the business.
    rentCents = roundTo(revenueAtApplication * inflation * rng.uniform(0.1, 0.16), 5000);
    requestedRentCents = rentCents;
  } else if (fraud === 'round_trip') {
    // Enough padding in the months before applying to make a bigger lease look affordable.
    const padding = rng.uniform(0.4, 0.9);
    const days = rng.int(100, 160);
    events.push({
      kind: 'round_trip',
      start: addDays(applicationDate, -days),
      days: days + 7,
      weeklyCents: roundTo((revenueAtApplication * padding * 12) / 52, 10_000),
    });
    statedMonthlyRevenueCents = roundTo(revenueAtApplication * (1 + padding), 10_000);
    // The rent in the account is the current, ordinary lease. The lease presented is for a
    // space the real revenue cannot carry.
    requestedRentCents = roundTo(revenueAtApplication * rng.uniform(0.16, 0.24), 5000);
  } else if (fraud === 'bust_out') {
    // A small rent shows in the account; the lease presented is several times larger.
    rentCents = roundTo(revenueAtApplication * rng.uniform(0.05, 0.08), 5000);
    requestedRentCents = roundTo(
      Math.min(rentCents * rng.uniform(2.5, 4), revenueAtApplication * 0.28),
      5000,
    );
    events.push({ kind: 'closure', date: addDays(applicationDate, rng.int(2, 20)) });
  }

  if (fraud !== 'bust_out') {
    const young = timeInBusinessMonths < 24 ? HAZARDS.youngMultiplier : 1;
    events.push(
      ...drawForwardHazards(rng, applicationDate, latentHealth, industryProfile.closure * young),
    );
  }

  const pos =
    fraud === null && historyDays > 0 && rng.chance(0.35)
      ? {
          platform: PLATFORMS[rng.int(0, PLATFORMS.length - 1)]!,
          days: Math.min(historyDays, rng.int(120, 400)),
        }
      : null;

  // The simulator compounds growth from the start of the history, so back the starting level
  // out of the level wanted on the application date.
  const startRevenue = revenueAtApplication / (1 + annualGrowth) ** (historyDays / 365);

  return {
    id: `a${String(index).padStart(5, '0')}`,
    seedHex,
    archetype,
    fraud,
    segment: fraud ?? archetype,
    industry,
    arrivalMonth,
    applicationDate,
    historyDays,
    timeInBusinessMonths,
    statedMonthlyRevenueCents,
    requestedRentCents,
    pos,
    latentHealth,
    params: {
      monthlyRevenueCents: Math.round(startRevenue),
      rentCents,
      seasonality: clamp(
        jitter(base.seasonality, 0.3) + industryProfile.seasonality + rng.uniform(0, 0.04),
        0,
        0.6,
      ),
      dailyNoise: clamp(jitter(base.dailyNoise, 0.2), 0.05, 0.8),
      monthlyNoise: clamp(jitter(base.monthlyNoise, 0.3), 0.01, 0.5),
      payroll: variable * payrollShare,
      supplier: variable * (1 - payrollShare),
      utilities,
      insurance,
      software,
      taxQuarterly,
      ownerDraw,
      loan,
      mcaDaily,
      openingBalanceMonths,
      batchedSettlement: base.batchedSettlement ?? false,
      annualGrowth,
      costFlex: rng.uniform(0.3, 0.7),
      ownerReserveCents,
      overdraftLimitCents: Math.round(revenueAtApplication * 0.15),
      events,
    },
  };
}

/**
 * Draw `n` applicants. Applicant `i` depends only on the seed and `i`, so a larger population
 * with the same seed starts with the same businesses. The result is sorted by application
 * date, ties by id.
 */
export function drawPopulation(
  config: Pick<PopulationConfig, 'n' | 'seed'> & Partial<PopulationConfig>,
): Applicant[] {
  const full: PopulationConfig = { ...DEFAULT_POPULATION, ...config };
  const applicants: Applicant[] = [];
  for (let i = 0; i < full.n; i++) applicants.push(drawApplicant(full, i));
  return applicants.sort((a, b) =>
    a.applicationDate === b.applicationDate
      ? a.id < b.id
        ? -1
        : 1
      : a.applicationDate < b.applicationDate
        ? -1
        : 1,
  );
}

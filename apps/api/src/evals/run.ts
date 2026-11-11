import {
  BASELINE_SERVICING_POLICY,
  STANDARD_SERVICING_POLICY,
  type ServicingPolicy,
} from '../servicing/policy.ts';
import { decide } from '../underwriting/engine.ts';
import { CURRENT_POLICY, POLICY_V1, type CreditPolicy } from '../underwriting/policy.ts';
import { ASSUMPTIONS, STRESS, poolSizeFor } from './assumptions.ts';
import { evaluateGates, type GateResult } from './gates.ts';
import {
  computeMetrics,
  poolResults,
  swapSet,
  type PortfolioMetrics,
  type SwapSet,
} from './metrics.ts';
import { drawPopulation, type Applicant } from './population.ts';
import { runPortfolio, type PortfolioConfig, type PortfolioResult } from './portfolio.ts';

/**
 * One full evaluation.
 *
 * The configuration under test (the gated one) is the current credit policy under the
 * standard servicing policy. It is run in base, mild stress, and severe stress on every seed,
 * and the gates are judged on the mean across seeds.
 *
 * Beside it run the comparison configurations, on the same applicants, so the report can
 * separate what underwriting bought from what servicing bought:
 *
 *   v1_baseline   the launch policy with today's servicing: where Phase R1 started
 *   v1_standard   the launch policy with standard servicing: what servicing alone buys
 *   v2_baseline   the current policy with today's servicing: what underwriting alone buys
 *
 * Challengers change one thing about the gated configuration and report a swap set.
 */

export interface PolicyConfig {
  name: string;
  description: string;
  policy: CreditPolicy;
  servicing: ServicingPolicy;
  /** Also run mild stress, which the gates need. */
  withMild: boolean;
}

export const GATED_CONFIG: PolicyConfig = {
  name: 'v2_standard',
  description: `${CURRENT_POLICY.version} decisions, standard servicing. The gated configuration.`,
  policy: CURRENT_POLICY,
  servicing: STANDARD_SERVICING_POLICY,
  withMild: true,
};

export const COMPARISON_CONFIGS: readonly PolicyConfig[] = [
  {
    name: 'v1_baseline',
    description: `${POLICY_V1.version} decisions, baseline servicing: the launch policy as Phase R1 measured it.`,
    policy: POLICY_V1,
    servicing: BASELINE_SERVICING_POLICY,
    withMild: true,
  },
  {
    name: 'v1_standard',
    description: `${POLICY_V1.version} decisions, standard servicing: what the servicing change buys on its own.`,
    policy: POLICY_V1,
    servicing: STANDARD_SERVICING_POLICY,
    withMild: false,
  },
  {
    name: 'v2_baseline',
    description: `${CURRENT_POLICY.version} decisions, baseline servicing: what the credit policy buys on its own.`,
    policy: CURRENT_POLICY,
    servicing: BASELINE_SERVICING_POLICY,
    withMild: true,
  },
];

export interface Challenger {
  name: string;
  description: string;
  policy?: CreditPolicy;
  servicing?: ServicingPolicy;
  /** Simulator settings to change, for a sensitivity. */
  portfolio?: Partial<PortfolioConfig>;
}

/** The lower half of grade D is funded after review. This challenger shows the book without it. */
export const CHALLENGERS: readonly Challenger[] = [
  {
    name: 'cutoff_55',
    description:
      'Same servicing. Minimum score 55 instead of 50, which removes grade D and with it the score band referral.',
    policy: {
      ...CURRENT_POLICY,
      minScore: 55,
      escalation: CURRENT_POLICY.escalation
        ? { ...CURRENT_POLICY.escalation, scoreBandAboveCutoff: 0 }
        : null,
    },
  },
];

/**
 * Sensitivities change one assumption of the gated run, not the policy. They are reported
 * beside the gated numbers and never decide a gate.
 */
export const SENSITIVITIES: readonly Challenger[] = [
  {
    name: 'partial_advance',
    description:
      'Counter offers are fronted in part: when the limit is below the rent, CashFlow fronts the limit and the business pays the rest itself. The product does not do this. It refuses a lease above the limit, which is what the gated run models.',
    portfolio: { partialAdvance: true },
  },
  {
    name: 'manual_payment',
    description: `Of installments still unpaid ${ASSUMPTIONS.manualPaymentFirstDay} days past due at a business that is still trading, ${ASSUMPTIONS.manualPaymentShareBps / 100}% are paid by hand between day ${ASSUMPTIONS.manualPaymentFirstDay} and day ${ASSUMPTIONS.manualPaymentLastDay}. An assumption with no data behind it. The gated run assumes none are.`,
    portfolio: {
      manualPayment: {
        shareBps: ASSUMPTIONS.manualPaymentShareBps,
        firstDay: ASSUMPTIONS.manualPaymentFirstDay,
        lastDay: ASSUMPTIONS.manualPaymentLastDay,
      },
    },
  },
];

export interface EvaluationOptions {
  n: number;
  /** One seed, or several. With several, the gates judge the mean. */
  seeds?: readonly (string | number)[];
  seed?: string | number;
  horizonMonths: number;
  gated?: PolicyConfig;
  comparisons?: readonly PolicyConfig[];
  challengers?: readonly Challenger[];
  sensitivities?: readonly Challenger[];
}

export interface ConfigOutcome {
  name: string;
  description: string;
  policyVersion: string;
  servicingPolicy: string;
  /** All seeds as one book. */
  base: PortfolioMetrics;
  mild: PortfolioMetrics | null;
  /** One entry per seed, in seed order. */
  baseBySeed: PortfolioMetrics[];
  mildBySeed: PortfolioMetrics[] | null;
  /** Gate results, when mild stress was run. For comparison only: these do not decide shipping. */
  gates: GateResult[] | null;
  /** Against the gated configuration: who each approves that the other does not. */
  swapSet: SwapSet | null;
}

export interface ChallengerOutcome {
  name: string;
  description: string;
  metrics: PortfolioMetrics;
  metricsBySeed: PortfolioMetrics[];
  swapSet: SwapSet;
}

export interface Evaluation {
  run: {
    n: number;
    seeds: string[];
    horizonMonths: number;
    arrivalMonths: number;
    monthlyGrowthBps: number;
    poolSizeCents: number;
    policyVersion: string;
    servicingPolicy: string;
    reviewFraudCatchRateBps: number;
  };
  /** The gated configuration with all seeds pooled into one book. */
  base: PortfolioMetrics;
  mild: PortfolioMetrics;
  severe: PortfolioMetrics;
  baseBySeed: PortfolioMetrics[];
  mildBySeed: PortfolioMetrics[];
  severeBySeed: PortfolioMetrics[];
  gates: GateResult[];
  comparisons: ConfigOutcome[];
  challengers: ChallengerOutcome[];
  /** The gated configuration with one simulator assumption changed. Base case only. */
  sensitivities: ChallengerOutcome[];
}

export const DEFAULT_RUN = {
  n: 2000,
  seeds: ['1', '2', '3', '4', '5'],
  horizonMonths: ASSUMPTIONS.horizonMonths,
};

function portfolioConfig(
  policy: CreditPolicy,
  servicing: ServicingPolicy,
  horizonMonths: number,
): Partial<PortfolioConfig> {
  return {
    decide: (input) => decide(input, policy),
    exposure: policy.exposure,
    servicing,
    horizonMonths,
    // The baseline policy describes the services before they handled returns: a failed
    // debit was booked as failed on the day.
    returnDelayDays:
      servicing.name === BASELINE_SERVICING_POLICY.name ? 0 : ASSUMPTIONS.returnDelayDays,
  };
}

export function evaluate(options: EvaluationOptions): Evaluation {
  const seeds = (options.seeds ?? [options.seed ?? DEFAULT_RUN.seeds[0]!]).map(String);
  const gated = options.gated ?? GATED_CONFIG;
  const comparisons = options.comparisons ?? COMPARISON_CONFIGS;
  const challengers = options.challengers ?? [];
  const populations: Applicant[][] = seeds.map((seed) => drawPopulation({ n: options.n, seed }));

  const runAll = (
    policy: CreditPolicy,
    servicing: ServicingPolicy,
    label: string,
    stress: PortfolioConfig['stress'] = null,
    overrides: Partial<PortfolioConfig> = {},
  ): PortfolioResult[] =>
    populations.map((population) =>
      runPortfolio(population, {
        ...portfolioConfig(policy, servicing, options.horizonMonths),
        ...overrides,
        label,
        stress,
      }),
    );
  const metricsOf = (results: PortfolioResult[]) => ({
    pooled: computeMetrics(poolResults(results)),
    bySeed: results.map((r) => computeMetrics(r)),
  });

  const baseResults = runAll(gated.policy, gated.servicing, 'base');
  const pooledBaseResult = poolResults(baseResults);
  const base = metricsOf(baseResults);
  const mild = metricsOf(runAll(gated.policy, gated.servicing, 'mild', STRESS.mild));
  const severe = metricsOf(runAll(gated.policy, gated.servicing, 'severe', STRESS.severe));

  const comparisonOutcomes = comparisons.map((c): ConfigOutcome => {
    const results = runAll(c.policy, c.servicing, c.name);
    const cBase = metricsOf(results);
    const cMild = c.withMild
      ? metricsOf(runAll(c.policy, c.servicing, `${c.name}/mild`, STRESS.mild))
      : null;
    return {
      name: c.name,
      description: c.description,
      policyVersion: c.policy.version,
      servicingPolicy: c.servicing.name,
      base: cBase.pooled,
      mild: cMild?.pooled ?? null,
      baseBySeed: cBase.bySeed,
      mildBySeed: cMild?.bySeed ?? null,
      gates: cMild ? evaluateGates({ base: cBase.bySeed, mild: cMild.bySeed }) : null,
      // The comparison is the champion here: swap ins are what the gated policy adds.
      swapSet: swapSet(poolResults(results), pooledBaseResult),
    };
  });

  const challenge = (c: Challenger): ChallengerOutcome => {
    const results = runAll(
      c.policy ?? gated.policy,
      c.servicing ?? gated.servicing,
      c.name,
      null,
      c.portfolio,
    );
    const m = metricsOf(results);
    return {
      name: c.name,
      description: c.description,
      metrics: m.pooled,
      metricsBySeed: m.bySeed,
      swapSet: swapSet(pooledBaseResult, poolResults(results)),
    };
  };
  const challengerOutcomes = challengers.map(challenge);
  const sensitivityOutcomes = (options.sensitivities ?? []).map(challenge);

  return {
    run: {
      n: options.n,
      seeds,
      horizonMonths: options.horizonMonths,
      arrivalMonths: ASSUMPTIONS.arrivalMonths,
      monthlyGrowthBps: ASSUMPTIONS.monthlyGrowthBps,
      poolSizeCents: poolSizeFor(options.n),
      policyVersion: gated.policy.version,
      servicingPolicy: gated.servicing.name,
      reviewFraudCatchRateBps: ASSUMPTIONS.reviewFraudCatchRateBps,
    },
    base: base.pooled,
    mild: mild.pooled,
    severe: severe.pooled,
    baseBySeed: base.bySeed,
    mildBySeed: mild.bySeed,
    severeBySeed: severe.bySeed,
    gates: evaluateGates({ base: base.bySeed, mild: mild.bySeed }),
    comparisons: comparisonOutcomes,
    challengers: challengerOutcomes,
    sensitivities: sensitivityOutcomes,
  };
}

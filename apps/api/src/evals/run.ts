import {
  BASELINE_SERVICING_POLICY,
  STANDARD_SERVICING_POLICY,
  type ServicingPolicy,
} from '../servicing/policy.ts';
import { decide } from '../underwriting/engine.ts';
import { CURRENT_POLICY, POLICY_V1, POLICY_V2, type CreditPolicy } from '../underwriting/policy.ts';
import { ASSUMPTIONS, STRESS, poolSizeFor } from './assumptions.ts';
import { evaluateGates, type GateResult } from './gates.ts';
import {
  computeMetrics,
  poolResults,
  swapSet,
  throughTheDoorMetrics,
  type PortfolioMetrics,
  type SwapSet,
  type ThroughTheDoorMetrics,
} from './metrics.ts';
import { drawPopulation, type Applicant } from './population.ts';
import {
  runPortfolio,
  runThroughTheDoor,
  throughTheDoorCustomers,
  type CustomerResult,
  type PortfolioConfig,
  type PortfolioResult,
} from './portfolio.ts';
import { counterfactualCell, type CounterfactualCell } from './veracity-metrics.ts';

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
 *
 * Every configuration that is judged against the gates is also run once "through the door":
 * the same applicants, decisions, and servicing, with every scored applicant funded so that
 * the score can be judged on the applicants the policy declined as well. That run feeds the
 * AUC gate and the through the door tables and nothing else.
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
  name: 'v3_standard',
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
    description: `${POLICY_V2.version} decisions, baseline servicing: what the credit policy buys on its own.`,
    policy: POLICY_V2,
    servicing: BASELINE_SERVICING_POLICY,
    withMild: true,
  },
  {
    name: 'v2_standard',
    description: `${POLICY_V2.version} decisions, standard servicing: the policy before the data veracity checks, on the same applicants. What the checks buy and cost.`,
    policy: POLICY_V2,
    servicing: STANDARD_SERVICING_POLICY,
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

/** The counterfactual run of one configuration, seeds pooled and one entry per seed. */
export interface ThroughTheDoorOutcome {
  pooled: ThroughTheDoorMetrics;
  bySeed: ThroughTheDoorMetrics[];
}

/**
 * Honest applicants a veracity finding knocked out, referred or sent for information, each
 * funded in a counterfactual run that decides without the veracity facts, against honest
 * applicants the checks left alone, from the gated configuration's through the door run.
 */
export interface VeracityCounterfactual {
  affected: CounterfactualCell;
  unaffected: CounterfactualCell;
  /** Unaffected honest applicants the policy approved on usable terms. */
  unaffectedApprovedUsable: CounterfactualCell;
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
  /** Run only when the gates are judged, which is when mild stress was run. */
  throughTheDoor: ThroughTheDoorOutcome | null;
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
    /** The gated configuration's name. */
    gated: string;
  };
  /** The gated configuration with all seeds pooled into one book. */
  base: PortfolioMetrics;
  mild: PortfolioMetrics;
  severe: PortfolioMetrics;
  baseBySeed: PortfolioMetrics[];
  mildBySeed: PortfolioMetrics[];
  severeBySeed: PortfolioMetrics[];
  /**
   * The gated configuration in the base case with every scored applicant funded. Read by the
   * AUC gate. Not part of `base` and not a portfolio result.
   */
  throughTheDoor: ThroughTheDoorOutcome;
  veracityCounterfactual: { pooled: VeracityCounterfactual; bySeed: VeracityCounterfactual[] };
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

  /**
   * The counterfactual run of a configuration in the base case, given that configuration's
   * ordinary base results, one per seed. Plans the ordinary run already played are not
   * played again. A declined applicant the engine never priced pays the grade D floor, the
   * highest floor of any grade the policy funds.
   */
  const doorCustomers: CustomerResult[][] = [];
  const runThroughDoor = (
    policy: CreditPolicy,
    servicing: ServicingPolicy,
    label: string,
    funded: readonly PortfolioResult[],
    keep = false,
  ): ThroughTheDoorOutcome => {
    const bySeed = populations.map((population, i) =>
      throughTheDoorCustomers(
        population,
        {
          ...portfolioConfig(policy, servicing, options.horizonMonths),
          label,
          stress: null,
          fallbackFeeBps: policy.pricing.D.feeBps,
        },
        funded[i]!,
      ),
    );
    if (keep) doorCustomers.push(...bySeed);
    return {
      pooled: throughTheDoorMetrics(bySeed.flat()),
      bySeed: bySeed.map((customers) => throughTheDoorMetrics(customers)),
    };
  };

  const baseResults = runAll(gated.policy, gated.servicing, 'base');
  const pooledBaseResult = poolResults(baseResults);
  const base = metricsOf(baseResults);
  const mild = metricsOf(runAll(gated.policy, gated.servicing, 'mild', STRESS.mild));
  const severe = metricsOf(runAll(gated.policy, gated.servicing, 'severe', STRESS.severe));
  const throughTheDoor = runThroughDoor(
    gated.policy,
    gated.servicing,
    'through_the_door',
    baseResults,
    true,
  );

  // The honest applicants a veracity finding affected, funded without the finding.
  const veracityBySeed: VeracityCounterfactual[] = [];
  const pooledAffected: CustomerResult[] = [];
  const pooledUnaffected: CustomerResult[] = [];
  const pooledUsable: CustomerResult[] = [];
  populations.forEach((population, i) => {
    const ordinary = new Map(baseResults[i]!.customers.map((c) => [c.applicantId, c]));
    const affectedIds = new Set(
      [...ordinary.values()]
        .filter((c) => c.fraud === null && c.veracityEffect !== null)
        .map((c) => c.applicantId),
    );
    const affected = runThroughTheDoor(
      population.filter((a) => affectedIds.has(a.id)),
      {
        ...portfolioConfig(gated.policy, gated.servicing, options.horizonMonths),
        label: 'veracity_counterfactual',
        stress: null,
        stripVeracity: true,
        fallbackFeeBps: gated.policy.pricing.D.feeBps,
      },
    ).customers;
    const unaffected = doorCustomers[i]!.filter(
      (c) => c.fraud === null && !affectedIds.has(c.applicantId),
    );
    const usable = unaffected.filter((c) => {
      const o = ordinary.get(c.applicantId);
      return o !== undefined && o.outcome === 'APPROVED' && !o.counterOffer;
    });
    pooledAffected.push(...affected);
    pooledUnaffected.push(...unaffected);
    pooledUsable.push(...usable);
    veracityBySeed.push({
      affected: counterfactualCell(affected),
      unaffected: counterfactualCell(unaffected),
      unaffectedApprovedUsable: counterfactualCell(usable),
    });
  });

  const comparisonOutcomes = comparisons.map((c): ConfigOutcome => {
    const results = runAll(c.policy, c.servicing, c.name);
    const cBase = metricsOf(results);
    const cMild = c.withMild
      ? metricsOf(runAll(c.policy, c.servicing, `${c.name}/mild`, STRESS.mild))
      : null;
    const cDoor = cMild
      ? runThroughDoor(c.policy, c.servicing, `${c.name}/through_the_door`, results)
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
      throughTheDoor: cDoor,
      gates:
        cMild && cDoor
          ? evaluateGates({ base: cBase.bySeed, mild: cMild.bySeed, throughTheDoor: cDoor.bySeed })
          : null,
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
      gated: gated.name,
    },
    base: base.pooled,
    mild: mild.pooled,
    severe: severe.pooled,
    baseBySeed: base.bySeed,
    mildBySeed: mild.bySeed,
    severeBySeed: severe.bySeed,
    throughTheDoor,
    veracityCounterfactual: {
      pooled: {
        affected: counterfactualCell(pooledAffected),
        unaffected: counterfactualCell(pooledUnaffected),
        unaffectedApprovedUsable: counterfactualCell(pooledUsable),
      },
      bySeed: veracityBySeed,
    },
    gates: evaluateGates({
      base: base.bySeed,
      mild: mild.bySeed,
      throughTheDoor: throughTheDoor.bySeed,
    }),
    comparisons: comparisonOutcomes,
    challengers: challengerOutcomes,
    sensitivities: sensitivityOutcomes,
  };
}

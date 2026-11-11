import { BASELINE_SERVICING_POLICY, type ServicingPolicy } from '../servicing/policy.ts';
import { decide } from '../underwriting/engine.ts';
import { ASSUMPTIONS, STRESS, poolSizeFor } from './assumptions.ts';
import { evaluateGates, type GateResult } from './gates.ts';
import { computeMetrics, swapSet, type PortfolioMetrics, type SwapSet } from './metrics.ts';
import { drawPopulation } from './population.ts';
import { runPortfolio, type DecideFn, type PortfolioConfig } from './portfolio.ts';

/**
 * One full evaluation: the champion policy in base, mild stress, and severe stress, the
 * gates, and optionally a challenger on the same population for a swap set.
 */

export interface EvaluationOptions {
  n: number;
  seed: string | number;
  horizonMonths: number;
  /** Decision function under test. Defaults to the live engine. */
  decide?: DecideFn;
  /** Servicing policy under test. Defaults to today's behavior. */
  servicing?: ServicingPolicy;
  /** Named alternatives run in the base case on the same applicants. */
  challengers?: readonly Challenger[];
}

export interface Challenger {
  name: string;
  description: string;
  decide?: DecideFn;
  servicing?: ServicingPolicy;
}

export interface ChallengerOutcome {
  name: string;
  description: string;
  metrics: PortfolioMetrics;
  swapSet: SwapSet;
}

export interface Evaluation {
  run: {
    n: number;
    seed: string;
    horizonMonths: number;
    arrivalMonths: number;
    monthlyGrowthBps: number;
    poolSizeCents: number;
    servicingPolicy: string;
  };
  base: PortfolioMetrics;
  mild: PortfolioMetrics;
  severe: PortfolioMetrics;
  gates: GateResult[];
  challengers: ChallengerOutcome[];
}

export const DEFAULT_RUN = { n: 2000, seed: '1', horizonMonths: ASSUMPTIONS.horizonMonths };

/**
 * Illustrations of the challenger machinery, not proposals. Each changes one thing so its
 * effect can be read off against the champion.
 */
export const ILLUSTRATIVE_CHALLENGERS: readonly Challenger[] = [
  {
    name: 'hold_payouts',
    description:
      'Same decisions. Servicing holds the next landlord payout while any installment is past the 3 day grace period.',
    servicing: { ...BASELINE_SERVICING_POLICY, name: 'hold_payouts', holdPayoutPastDueDays: 3 },
  },
  {
    name: 'cutoff_55',
    description: 'Same servicing. Declines any score below 55, which removes grade D.',
    decide: (input) => {
      const result = decide(input);
      if (result.outcome !== 'APPROVED' || (result.score ?? 0) >= 55) return result;
      return { ...result, outcome: 'DECLINED', approvedMonthlyLimitCents: null, feeBps: null };
    },
  },
];

export function evaluate(options: EvaluationOptions): Evaluation {
  const population = drawPopulation({ n: options.n, seed: options.seed });
  const champion: Partial<PortfolioConfig> = {
    decide: options.decide ?? decide,
    servicing: options.servicing ?? BASELINE_SERVICING_POLICY,
    horizonMonths: options.horizonMonths,
  };
  const baseResult = runPortfolio(population, { ...champion, label: 'base' });
  const base = computeMetrics(baseResult);
  const mild = computeMetrics(
    runPortfolio(population, { ...champion, label: 'mild', stress: STRESS.mild }),
  );
  const severe = computeMetrics(
    runPortfolio(population, { ...champion, label: 'severe', stress: STRESS.severe }),
  );
  const challengers = (options.challengers ?? []).map((c): ChallengerOutcome => {
    const result = runPortfolio(population, {
      ...champion,
      label: c.name,
      ...(c.decide ? { decide: c.decide } : {}),
      ...(c.servicing ? { servicing: c.servicing } : {}),
    });
    return {
      name: c.name,
      description: c.description,
      metrics: computeMetrics(result),
      swapSet: swapSet(baseResult, result),
    };
  });
  return {
    run: {
      n: options.n,
      seed: String(options.seed),
      horizonMonths: options.horizonMonths,
      arrivalMonths: ASSUMPTIONS.arrivalMonths,
      monthlyGrowthBps: ASSUMPTIONS.monthlyGrowthBps,
      poolSizeCents: poolSizeFor(options.n),
      servicingPolicy: (options.servicing ?? BASELINE_SERVICING_POLICY).name,
    },
    base,
    mild,
    severe,
    gates: evaluateGates({ base, mild }),
    challengers,
  };
}

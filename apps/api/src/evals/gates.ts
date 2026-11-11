import { type PortfolioMetrics } from './metrics.ts';

/**
 * Pass or fail gates for the "Balanced" risk appetite. A policy change ships only when every
 * gate passes on the default evaluation run.
 *
 * A single run of 2,000 applicants has about 60 bad plans, and rank ordering in particular
 * moves several points from seed to seed. The gates are therefore judged on the mean of
 * several seeds. Each gate reports the mean it was judged on, the lowest and highest single
 * seed, and the threshold it was held to.
 */
export const GATE_THRESHOLDS = {
  /** Net loss (write offs less recoveries) at or under 0.75% of rent volume, base case. */
  maxNetLossBps: 75,
  /** Net margin after cost of funds, servicing, and losses must be above zero. */
  minNetMarginCents: 0,
  /** Score must separate good plans from bad at least this well. */
  minAuc: 0.7,
  /**
   * Bad rate must not fall as grade worsens from A to D. Grades with fewer than
   * `monotonicMinPlans` plans are too small to judge and are skipped, and a better grade may
   * sit up to `monotonicToleranceBps` (one percentage point) above the next without counting
   * as an inversion, which is roughly the sampling noise of a few hundred plans at a bad
   * rate of a few percent.
   */
  monotonicMinPlans: 30,
  monotonicToleranceBps: 100,
  /** Under 5% of fraud archetype applicants may end up approved, after any review. */
  maxFraudApprovalBps: 500,
  /**
   * Approval floor: at least 30% of all applicants approved on terms they can use. An
   * approval for less than the rent requested opens no plan in the product as built, so it
   * does not count toward the floor. 55% of the default population is drawn
   * from archetypes that are creditworthy by construction (healthy, growing, seasonal,
   * volatile, batched), so a policy that approves fewer than about half of those is passing
   * the loss gates by not lending. 30% is also the low end of what an instant decision
   * product can approve and still be worth applying to.
   */
  minApprovalRateBps: 3000,
  /**
   * Refer ceiling: at most 5% of applicants may be sent to a reviewer. The product promises
   * a decision in the same request. Nineteen applicants in twenty must get one, and a policy
   * must not pass the fraud gate by handing its hard cases to a queue.
   */
  maxReferRateBps: 500,
} as const;

export interface GateResult {
  id: string;
  description: string;
  /** The value the gate was judged on: the mean across seeds. Null when not measurable, which fails. */
  value: number | null;
  /** Lowest and highest single seed. Equal to `value` on a one seed run. */
  min: number | null;
  max: number | null;
  threshold: number;
  comparator: '<=' | '>=' | '>' | '<' | '=';
  unit: string;
  pass: boolean;
}

function gate(
  id: string,
  description: string,
  values: readonly (number | null)[],
  comparator: GateResult['comparator'],
  threshold: number,
  unit: string,
  options: { digits?: number; judged?: number | null } = {},
): GateResult {
  const measured = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const complete = measured.length === values.length && values.length > 0;
  const scale = 10 ** (options.digits ?? 0);
  const round = (v: number) => Math.round(v * scale) / scale;
  const mean = complete ? round(measured.reduce((a, b) => a + b, 0) / measured.length) : null;
  const value = options.judged !== undefined ? options.judged : mean;
  let pass = false;
  if (value !== null && Number.isFinite(value)) {
    if (comparator === '<=') pass = value <= threshold;
    else if (comparator === '>=') pass = value >= threshold;
    else if (comparator === '>') pass = value > threshold;
    else if (comparator === '<') pass = value < threshold;
    else pass = value === threshold;
  }
  return {
    id,
    description,
    value,
    min: complete ? round(Math.min(...measured)) : null,
    max: complete ? round(Math.max(...measured)) : null,
    threshold,
    comparator,
    unit,
    pass,
  };
}

const GRADES = ['A', 'B', 'C', 'D'] as const;

/**
 * Inversions in bad rate by grade, on plans pooled across the runs given. Pooling is the
 * mean weighted by plans, which is the right mean for a rate.
 */
export function pooledGradeInversions(
  runs: readonly PortfolioMetrics[],
  minPlans: number,
  toleranceBps: number,
): number {
  const cells = GRADES.map((grade) => {
    const plans = runs.reduce((sum, m) => sum + (m.byGrade[grade]?.plans ?? 0), 0);
    const weighted = runs.reduce(
      (sum, m) => sum + (m.byGrade[grade]?.badRateBps ?? 0) * (m.byGrade[grade]?.plans ?? 0),
      0,
    );
    return { plans, badRateBps: plans === 0 ? 0 : weighted / plans };
  }).filter((c) => c.plans >= minPlans);
  let inversions = 0;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i - 1]!.badRateBps > cells[i]!.badRateBps + toleranceBps) inversions += 1;
  }
  return inversions;
}

type OneOrMany = PortfolioMetrics | readonly PortfolioMetrics[];
const many = (m: OneOrMany): readonly PortfolioMetrics[] =>
  Array.isArray(m) ? (m as readonly PortfolioMetrics[]) : [m as PortfolioMetrics];

/**
 * Evaluate the gates on one run, or on the same configuration run on several seeds. With
 * several, every gate is judged on the mean of the per seed values, except the two counts:
 * grade inversions are counted on bad rates pooled across seeds, and unfunded payouts are
 * summed, since one unfunded payout on any seed is a failure.
 */
export function evaluateGates(runs: { base: OneOrMany; mild: OneOrMany }): GateResult[] {
  const base = many(runs.base);
  const mild = many(runs.mild);
  const t = GATE_THRESHOLDS;
  const withVolume = (f: (m: PortfolioMetrics) => number | null) => (m: PortfolioMetrics) =>
    m.overall.volumeCents > 0 ? f(m) : null;
  const anyVolume = base.every((m) => m.overall.volumeCents > 0);
  const perSeedInversions = base.map(
    withVolume((m) => pooledGradeInversions([m], t.monotonicMinPlans, t.monotonicToleranceBps)),
  );
  return [
    gate(
      'net_loss_base',
      'Net loss at or under 75 bps of rent volume (base)',
      base.map(withVolume((m) => m.overall.netLossBps)),
      '<=',
      t.maxNetLossBps,
      'bps of volume',
    ),
    gate(
      'net_margin_base',
      'Net margin above zero (base)',
      base.map(withVolume((m) => m.overall.netMarginCents)),
      '>',
      t.minNetMarginCents,
      'cents',
    ),
    gate(
      'net_margin_mild_stress',
      'Net margin above zero (mild stress)',
      mild.map(withVolume((m) => m.overall.netMarginCents)),
      '>',
      t.minNetMarginCents,
      'cents',
    ),
    gate(
      'bad_rate_monotonic',
      'Bad rate does not fall from grade A to D (cells of 30 or more plans, 100 bps tolerance)',
      perSeedInversions,
      '=',
      0,
      'inversions',
      {
        judged: anyVolume
          ? pooledGradeInversions(base, t.monotonicMinPlans, t.monotonicToleranceBps)
          : null,
      },
    ),
    gate(
      'auc',
      'AUC of score against the bad flag at or above 0.70 (base)',
      base.map((m) => m.rankOrdering.auc),
      '>=',
      t.minAuc,
      'AUC',
      { digits: 3 },
    ),
    gate(
      'fraud_approval',
      'Under 5% of fraud archetype applicants approved, after review (base)',
      base.map((m) => (m.fraud.applicants > 0 ? m.fraud.approvalRateBps : null)),
      '<',
      t.maxFraudApprovalBps,
      'bps of fraud applicants',
    ),
    gate(
      'pool_funding',
      'Pool always able to fund a payout at the planned growth rate (base)',
      base.map((m) => m.pool.unfundedPayouts),
      '=',
      0,
      'unfunded payouts',
      { judged: base.reduce((sum, m) => sum + m.pool.unfundedPayouts, 0) },
    ),
    gate(
      'approval_floor',
      'Usable approval rate at or above 30% of applicants (base)',
      base.map((m) => (m.overall.applicants > 0 ? m.overall.usableApprovalRateBps : null)),
      '>=',
      t.minApprovalRateBps,
      'bps of applicants',
    ),
    gate(
      'refer_rate',
      'At most 5% of applicants referred to a reviewer (base)',
      base.map((m) => (m.overall.applicants > 0 ? m.overall.referRateBps : null)),
      '<=',
      t.maxReferRateBps,
      'bps of applicants',
    ),
  ];
}

export function allGatesPass(gates: readonly GateResult[]): boolean {
  return gates.every((g) => g.pass);
}

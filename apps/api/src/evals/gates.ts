import { gradeInversions, type PortfolioMetrics } from './metrics.ts';

/**
 * Pass or fail gates for the "Balanced" risk appetite. A policy change ships only when every
 * gate passes on the default evaluation run. Each gate reports the number it measured and
 * the threshold it was held to.
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
  /** Under 5% of fraud archetype applicants may be approved. */
  maxFraudApprovalBps: 500,
  /**
   * Approval floor: at least 30% of all applicants. 55% of the default population is drawn
   * from archetypes that are creditworthy by construction (healthy, growing, seasonal,
   * volatile, batched), so a policy that approves fewer than about half of those is passing
   * the loss gates by not lending. 30% is also the low end of what an instant decision
   * product can approve and still be worth applying to.
   */
  minApprovalRateBps: 3000,
} as const;

export interface GateResult {
  id: string;
  description: string;
  /** Measured value, or null when it could not be measured (which fails the gate). */
  value: number | null;
  threshold: number;
  comparator: '<=' | '>=' | '>' | '<' | '=';
  unit: string;
  pass: boolean;
}

function gate(
  id: string,
  description: string,
  value: number | null,
  comparator: GateResult['comparator'],
  threshold: number,
  unit: string,
): GateResult {
  let pass = false;
  if (value !== null && Number.isFinite(value)) {
    if (comparator === '<=') pass = value <= threshold;
    else if (comparator === '>=') pass = value >= threshold;
    else if (comparator === '>') pass = value > threshold;
    else if (comparator === '<') pass = value < threshold;
    else pass = value === threshold;
  }
  return { id, description, value, threshold, comparator, unit, pass };
}

export function evaluateGates(runs: {
  base: PortfolioMetrics;
  mild: PortfolioMetrics;
}): GateResult[] {
  const { base, mild } = runs;
  const t = GATE_THRESHOLDS;
  const hasVolume = base.overall.volumeCents > 0;
  return [
    gate(
      'net_loss_base',
      'Net loss at or under 75 bps of rent volume (base)',
      hasVolume ? base.overall.netLossBps : null,
      '<=',
      t.maxNetLossBps,
      'bps of volume',
    ),
    gate(
      'net_margin_base',
      'Net margin above zero (base)',
      hasVolume ? base.overall.netMarginCents : null,
      '>',
      t.minNetMarginCents,
      'cents',
    ),
    gate(
      'net_margin_mild_stress',
      'Net margin above zero (mild stress)',
      mild.overall.volumeCents > 0 ? mild.overall.netMarginCents : null,
      '>',
      t.minNetMarginCents,
      'cents',
    ),
    gate(
      'bad_rate_monotonic',
      'Bad rate does not fall from grade A to D (cells of 30 or more plans, 100 bps tolerance)',
      hasVolume ? gradeInversions(base, t.monotonicMinPlans, t.monotonicToleranceBps) : null,
      '=',
      0,
      'inversions',
    ),
    gate(
      'auc',
      'AUC of score against the bad flag at or above 0.70 (base)',
      base.rankOrdering.auc === null ? null : Math.round(base.rankOrdering.auc * 1000) / 1000,
      '>=',
      t.minAuc,
      'AUC',
    ),
    gate(
      'fraud_approval',
      'Under 5% of fraud archetype applicants approved (base)',
      base.fraud.applicants > 0 ? base.fraud.approvalRateBps : null,
      '<',
      t.maxFraudApprovalBps,
      'bps of fraud applicants',
    ),
    gate(
      'pool_funding',
      'Pool always able to fund a payout at the planned growth rate (base)',
      base.pool.unfundedPayouts,
      '=',
      0,
      'unfunded payouts',
    ),
    gate(
      'approval_floor',
      'Approval rate at or above 30% of applicants (base)',
      base.overall.applicants > 0 ? base.overall.approvalRateBps : null,
      '>=',
      t.minApprovalRateBps,
      'bps of applicants',
    ),
  ];
}

export function allGatesPass(gates: readonly GateResult[]): boolean {
  return gates.every((g) => g.pass);
}

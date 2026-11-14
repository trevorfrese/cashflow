import type { CreditGrade } from '@cashflow/shared';

import type { PdBand, PdTable } from './pd-table.ts';
import type { CreditPolicy, PricingPolicy } from './policy.ts';

/**
 * Expected loss pricing.
 *
 * The fee has to pay for four things: the loss we expect on plans like this one, the cost
 * of the money while the rent is out, the cost of running the plan, and a margin. The fee
 * is whichever is larger of that sum and the floor for the grade, and never less than a
 * fixed number of cents, because servicing costs the same on a $700 rent as on a $7,000
 * one. If the fee that would be needed is above the cap, the answer is a decline with that
 * reason. Approving at a capped fee would be writing a loan we expect to lose money on.
 *
 * All parts are in basis points of rent per period. The PD table, loss given default, and
 * funding periods are internal: they are stored on the decision snapshot and never
 * serialized to applicants.
 */

export interface FeeBuildUp {
  rentCents: number;
  /** Score band the PD was read from, for example "70-74". */
  scoreBand: string;
  /** Chance a plan like this goes bad within the horizon the table covers. */
  pdBps: number;
  lossGivenDefaultBps: number;
  expectedPeriods: number;
  /** Expected loss per period: PD times loss given default, spread over the funded periods. */
  expectedLossBps: number;
  costOfFundsBps: number;
  servicingBps: number;
  targetMarginBps: number;
  /** Sum of the four parts. */
  requiredBps: number;
  gradeFloorBps: number;
  /** The minimum fee in cents, expressed against this rent. */
  minFeeBps: number;
  /** The fee quoted: the largest of required, floor, and minimum, rounded up. */
  feeBps: number;
  feeCents: number;
  maxFeeBps: number;
  /** False when the fee needed is above the cap. The engine declines. */
  withinCap: boolean;
  /** What set the fee. */
  driver: 'GRADE_FLOOR' | 'EXPECTED_LOSS' | 'MINIMUM_FEE';
}

export function pdBandFor(table: PdTable, score: number): PdBand {
  const band = table.bands.find((b) => score >= b.minScore && score <= b.maxScore);
  // Bands cover 0 to 100. A gap would be a calibration bug; price it as the riskiest band.
  return band ?? table.bands[0]!;
}

/**
 * Average days a period's rent is outstanding, as a share of the rent, for a plan that pays
 * on time. Installments are evenly spaced over four weeks and the first falls due on the
 * payout date, so with two installments half the rent is out for 14 days (7 rent-days) and
 * with four it is 75%, 50%, 25% for a week each (10.5 rent-days).
 */
export function rentDaysOutstanding(installmentsPerMonth: number): number {
  const n = Math.max(1, installmentsPerMonth);
  const gap = 28 / n;
  let days = 0;
  for (let k = 1; k < n; k++) days += ((n - k) / n) * gap;
  return days;
}

export function costOfFundsBps(aprBps: number, installmentsPerMonth: number): number {
  return Math.ceil((aprBps * rentDaysOutstanding(installmentsPerMonth)) / 365);
}

const ceilTo = (value: number, increment: number) => Math.ceil(value / increment) * increment;

export interface PriceInput {
  score: number;
  grade: CreditGrade;
  /** Monthly rent the fee will be charged on. */
  rentCents: number;
  installmentsPerMonth: number;
  /**
   * Scale the PD read from the table, in basis points (10,000 is the table as is). Set for a
   * graduate of the pass-through plan (`graduatePricing`).
   */
  pdMultiplierBps?: number;
}

/** The PD for a score, scaled by `multiplierBps` and held to 100%. */
export function scaledPdBps(table: PdTable, score: number, multiplierBps = 10_000): number {
  return Math.min(10_000, Math.round((pdBandFor(table, score).pdBps * multiplierBps) / 10_000));
}

/**
 * The score a first time applicant would need to carry this PD: the top of the highest band
 * whose PD is at least `pdBps`. Never above `score`. The table is calibrated on first time
 * applicants, so this is how a PD measured on another population (graduates of the
 * pass-through plan) is turned into a grade on the same scale.
 */
export function pdEquivalentScore(table: PdTable, pdBps: number, score: number): number {
  let equivalent = 0;
  for (const band of table.bands) {
    if (band.pdBps >= pdBps && band.maxScore > equivalent) equivalent = band.maxScore;
  }
  return Math.min(score, equivalent);
}

export function priceFee(
  policy: Pick<CreditPolicy, 'pricing'> & { expectedLossPricing: PricingPolicy },
  input: PriceInput,
): FeeBuildUp {
  const p = policy.expectedLossPricing;
  const rent = Math.max(1, input.rentCents);
  const band = pdBandFor(p.pdTable, input.score);
  const pdBps = scaledPdBps(p.pdTable, input.score, input.pdMultiplierBps);
  const expectedLossBps = Math.ceil((pdBps * p.lossGivenDefaultBps) / 10_000 / p.expectedPeriods);
  const cof = costOfFundsBps(p.costOfFundsAprBps, input.installmentsPerMonth);
  const servicingBps = Math.ceil((p.servicingCostCents * 10_000) / rent);
  const requiredBps = expectedLossBps + cof + servicingBps + p.targetMarginBps;
  const gradeFloorBps = policy.pricing[input.grade].feeBps;
  const minFeeBps = Math.ceil((p.minFeeCents * 10_000) / rent);
  const raw = Math.max(requiredBps, gradeFloorBps, minFeeBps);
  const feeBps = ceilTo(raw, p.feeIncrementBps);
  const driver: FeeBuildUp['driver'] =
    raw === gradeFloorBps ? 'GRADE_FLOOR' : raw === requiredBps ? 'EXPECTED_LOSS' : 'MINIMUM_FEE';
  return {
    rentCents: input.rentCents,
    scoreBand: `${band.minScore}-${band.maxScore}`,
    pdBps,
    lossGivenDefaultBps: p.lossGivenDefaultBps,
    expectedPeriods: p.expectedPeriods,
    expectedLossBps,
    costOfFundsBps: cof,
    servicingBps,
    targetMarginBps: p.targetMarginBps,
    requiredBps,
    gradeFloorBps,
    minFeeBps,
    feeBps,
    feeCents: Math.round((rent * feeBps) / 10_000),
    maxFeeBps: p.maxFeeBps,
    withinCap: feeBps <= p.maxFeeBps,
    driver,
  };
}

/**
 * The fee for a plan whose rent differs from the rent the decision was priced on. A lease
 * below the approved limit pays the same rate unless the minimum fee in cents asks for
 * more. Returns null when that rate is above the cap: the rent is too small to serve.
 */
export function planFeeBps(
  policy: Pick<CreditPolicy, 'expectedLossPricing'>,
  decisionFeeBps: number,
  planRentCents: number,
): number | null {
  const p = policy.expectedLossPricing;
  if (!p || planRentCents <= 0) return decisionFeeBps;
  const minFeeBps = ceilTo(Math.ceil((p.minFeeCents * 10_000) / planRentCents), p.feeIncrementBps);
  const feeBps = Math.max(decisionFeeBps, minFeeBps);
  return feeBps <= p.maxFeeBps ? feeBps : null;
}

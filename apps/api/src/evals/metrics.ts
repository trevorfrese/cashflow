import type { CreditGrade } from '@cashflow/shared';

import { ASSUMPTIONS } from './assumptions.ts';
import { OPEN_BUCKETS, type OpenBucket } from '../servicing/policy.ts';
import {
  emptyBucketRoll,
  type BucketRoll,
  type CustomerResult,
  type PoolMonth,
  type PortfolioResult,
} from './portfolio.ts';

/**
 * Portfolio metrics, computed from simulation output only. Money is integer cents; rates are
 * basis points. "Volume" is rent paid to landlords.
 */

export interface CostAssumptions {
  costOfFundsAprBps: number;
  servicingCostCentsPerPlanMonth: number;
}

export const DEFAULT_COSTS: CostAssumptions = {
  costOfFundsAprBps: ASSUMPTIONS.costOfFundsAprBps,
  servicingCostCentsPerPlanMonth: ASSUMPTIONS.servicingCostCentsPerPlanMonth,
};

/** Economics of a group of applicants. Rates are zero when their denominator is zero. */
export interface SegmentMetrics {
  applicants: number;
  approved: number;
  declined: number;
  needsInfo: number;
  /** Applicants the engine sent to a reviewer. Their final outcome is counted above. */
  referred: number;
  referRateBps: number;
  /** Approved without a reviewer. */
  autoApproved: number;
  /** Approved, but the pool had no room within the wait limit. */
  neverFunded: number;
  approvalRateBps: number;
  /** Approved for less than the rent requested. */
  counterOffers: number;
  /** Counter offers that opened no plan, because the product fronts a whole rent or nothing. */
  unusableCounterOffers: number;
  /**
   * Approved with terms the applicant can use: approvals less unusable counter offers, over
   * applicants. Equal to `approvalRateBps` when counter offers are fronted in part. The
   * approval floor gate judges this one.
   */
  usableApprovalRateBps: number;
  /** Payouts held for at least a day, and what became of them. */
  heldPayouts: number;
  releasedPayouts: number;
  cancelledPayouts: number;
  /** Debits returned for insufficient funds, and scheduled debits put off by the balance check. */
  failedDebits: number;
  deferredDebits: number;
  manualPayments: number;
  /** Approved applicants with at least one landlord payout. */
  plans: number;
  planMonths: number;
  volumeCents: number;
  feeIncomeCents: number;
  costOfFundsCents: number;
  servicingCostCents: number;
  chargeOffCents: number;
  recoveryCents: number;
  netLossCents: number;
  netLossBps: number;
  netMarginCents: number;
  netMarginBps: number;
  /** Share of plans flagged bad. */
  badRateBps: number;
  bad: number;
  firstPaymentDefaultRateBps: number;
  /** Share of plans whose own net margin was above zero. */
  profitableShareBps: number;
  outstandingCents: number;
}

export interface RankOrdering {
  /** Probability a good plan outscores a bad one. 0.5 is no better than chance. */
  auc: number | null;
  /** Largest gap between the score distributions of good and bad plans, 0..1. */
  ks: number | null;
  goods: number;
  bads: number;
}

export interface PoolMetrics {
  startCents: number;
  endCents: number;
  minCents: number;
  peakUtilizationBps: number;
  /** Largest total of landlord payouts in one month. */
  peakMonthlyPayoutsCents: number;
  unfundedPayouts: number;
  unfundedPayoutDays: number;
  everUnableToFund: boolean;
  months: PoolMonth[];
}

export interface Concentration {
  /** Share of volume in the largest industry, in bps. */
  topShareBps: number;
  topIndustry: string | null;
  /** Herfindahl index of volume shares, 0..10000. */
  hhi: number;
}

/** Expected against realized, for one score band. */
export interface CalibrationRow {
  band: string;
  plans: number;
  /** Mean PD the plans were priced on. */
  expectedBadRateBps: number;
  realizedBadRateBps: number;
  /** Expected loss per period the plans were priced on, weighted by volume. */
  expectedLossBps: number;
  /** Net loss as a share of volume. */
  realizedLossBps: number;
}

export interface PortfolioMetrics {
  label: string;
  stress: string;
  servicingPolicy: string;
  overall: SegmentMetrics;
  /** Plans whose start waited for pool capacity, and approvals never funded. */
  funding: { plansDelayed: number; plansNeverFunded: number };
  /** Empty when the policy does not price on expected loss. */
  calibration: CalibrationRow[];
  declineRateBps: number;
  needsInfoRateBps: number;
  byGrade: Record<string, SegmentMetrics>;
  byScoreBand: Record<string, SegmentMetrics>;
  bySegment: Record<string, SegmentMetrics>;
  byIndustry: Record<string, SegmentMetrics>;
  rankOrdering: RankOrdering;
  fraud: SegmentMetrics;
  honest: SegmentMetrics;
  pool: PoolMetrics;
  concentration: Concentration;
  /** Share of principal seen in each bucket at a provision date that was later written off. */
  bucketRoll: BucketRollRow[];
  /** The same, for principal recorded once when its plan first moved into each bucket. */
  bucketEntryRoll: BucketRollRow[];
}

export interface BucketRollRow {
  bucket: OpenBucket;
  observedCents: number;
  chargedOffCents: number;
  /** Written off as a share of observed, in bps. Zero when nothing was observed. */
  rollRateBps: number;
}

export function bucketRollRows(roll: BucketRoll): BucketRollRow[] {
  return OPEN_BUCKETS.map((bucket) => ({
    bucket,
    observedCents: roll[bucket].observedCents,
    chargedOffCents: roll[bucket].chargedOffCents,
    rollRateBps: bps(roll[bucket].chargedOffCents, roll[bucket].observedCents),
  }));
}

function bps(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator * 10_000) / denominator);
}

export function costOfFundsCents(c: CustomerResult, costs: CostAssumptions): number {
  return Math.round((c.outstandingCentDays * costs.costOfFundsAprBps) / 10_000 / 365);
}

export function servicingCostCents(c: CustomerResult, costs: CostAssumptions): number {
  return c.payoutCount * costs.servicingCostCentsPerPlanMonth;
}

/** Fees collected less cost of funds, servicing, and net loss, for one customer. */
export function customerNetMarginCents(c: CustomerResult, costs: CostAssumptions): number {
  return (
    c.feesCollectedCents -
    costOfFundsCents(c, costs) -
    servicingCostCents(c, costs) -
    (c.chargedOffCents - c.recoveredCents)
  );
}

export function segmentMetrics(
  customers: readonly CustomerResult[],
  costs: CostAssumptions = DEFAULT_COSTS,
): SegmentMetrics {
  const m: SegmentMetrics = {
    applicants: customers.length,
    approved: 0,
    declined: 0,
    needsInfo: 0,
    referred: 0,
    referRateBps: 0,
    autoApproved: 0,
    neverFunded: 0,
    approvalRateBps: 0,
    counterOffers: 0,
    unusableCounterOffers: 0,
    usableApprovalRateBps: 0,
    heldPayouts: 0,
    releasedPayouts: 0,
    cancelledPayouts: 0,
    failedDebits: 0,
    deferredDebits: 0,
    manualPayments: 0,
    plans: 0,
    planMonths: 0,
    volumeCents: 0,
    feeIncomeCents: 0,
    costOfFundsCents: 0,
    servicingCostCents: 0,
    chargeOffCents: 0,
    recoveryCents: 0,
    netLossCents: 0,
    netLossBps: 0,
    netMarginCents: 0,
    netMarginBps: 0,
    badRateBps: 0,
    bad: 0,
    firstPaymentDefaultRateBps: 0,
    profitableShareBps: 0,
    outstandingCents: 0,
  };
  let fpd = 0;
  let profitable = 0;
  for (const c of customers) {
    if (c.outcome === 'APPROVED') m.approved += 1;
    else if (c.outcome === 'DECLINED') m.declined += 1;
    else m.needsInfo += 1;
    if (c.referred) m.referred += 1;
    else if (c.outcome === 'APPROVED') m.autoApproved += 1;
    if (c.neverFunded) m.neverFunded += 1;
    if (c.outcome === 'APPROVED' && c.counterOffer) m.counterOffers += 1;
    if (c.unusableCounterOffer) m.unusableCounterOffers += 1;
    m.heldPayouts += c.heldPayouts;
    m.releasedPayouts += c.releasedPayouts;
    m.cancelledPayouts += c.cancelledPayouts;
    m.failedDebits += c.failedDebits;
    m.deferredDebits += c.deferredDebits;
    m.manualPayments += c.manualPayments;
    if (c.payoutCount === 0) continue;
    m.plans += 1;
    m.planMonths += c.payoutCount;
    m.volumeCents += c.payoutCents;
    m.feeIncomeCents += c.feesCollectedCents;
    m.costOfFundsCents += costOfFundsCents(c, costs);
    m.servicingCostCents += servicingCostCents(c, costs);
    m.chargeOffCents += c.chargedOffCents;
    m.recoveryCents += c.recoveredCents;
    m.outstandingCents += c.outstandingCents;
    if (c.bad) m.bad += 1;
    if (c.firstPaymentDefault) fpd += 1;
    if (customerNetMarginCents(c, costs) > 0) profitable += 1;
  }
  m.approvalRateBps = bps(m.approved, m.applicants);
  m.usableApprovalRateBps = bps(m.approved - m.unusableCounterOffers, m.applicants);
  m.referRateBps = bps(m.referred, m.applicants);
  m.netLossCents = m.chargeOffCents - m.recoveryCents;
  m.netLossBps = bps(m.netLossCents, m.volumeCents);
  m.netMarginCents = m.feeIncomeCents - m.costOfFundsCents - m.servicingCostCents - m.netLossCents;
  m.netMarginBps = bps(m.netMarginCents, m.volumeCents);
  m.badRateBps = bps(m.bad, m.plans);
  m.firstPaymentDefaultRateBps = bps(fpd, m.plans);
  m.profitableShareBps = bps(profitable, m.plans);
  return m;
}

function groupBy(
  customers: readonly CustomerResult[],
  key: (c: CustomerResult) => string | null,
  order: readonly string[] = [],
): Map<string, CustomerResult[]> {
  const groups = new Map<string, CustomerResult[]>(order.map((k) => [k, []]));
  for (const c of customers) {
    const k = key(c);
    if (k === null) continue;
    const list = groups.get(k);
    if (list) list.push(c);
    else groups.set(k, [c]);
  }
  return groups;
}

function cut(
  customers: readonly CustomerResult[],
  costs: CostAssumptions,
  key: (c: CustomerResult) => string | null,
  order: readonly string[] = [],
): Record<string, SegmentMetrics> {
  const out: Record<string, SegmentMetrics> = {};
  const groups = groupBy(customers, key, order);
  const keys = order.length > 0 ? [...groups.keys()] : [...groups.keys()].sort();
  for (const k of keys) out[k] = segmentMetrics(groups.get(k)!, costs);
  return out;
}

export const GRADES: readonly CreditGrade[] = ['A', 'B', 'C', 'D', 'F'];
export const SCORE_BANDS = ['0-44', '45-54', '55-64', '65-74', '75-84', '85-100'] as const;

export function scoreBand(score: number): (typeof SCORE_BANDS)[number] {
  if (score < 45) return '0-44';
  if (score < 55) return '45-54';
  if (score < 65) return '55-64';
  if (score < 75) return '65-74';
  if (score < 85) return '75-84';
  return '85-100';
}

/**
 * AUC and KS of a score against a bad flag, from the scores of the goods and the scores of
 * the bads. A higher score should mean a lower chance of going bad, so AUC is the
 * probability that a randomly chosen good has a higher score than a randomly chosen bad,
 * ties counting half. KS is the largest gap between the two cumulative score distributions.
 * Both are null unless there is at least one good and one bad.
 */
export function scoreSeparation(goods: readonly number[], bads: readonly number[]): RankOrdering {
  if (goods.length === 0 || bads.length === 0) {
    return { auc: null, ks: null, goods: goods.length, bads: bads.length };
  }
  const goodAt = new Map<number, number>();
  const badAt = new Map<number, number>();
  for (const s of goods) goodAt.set(s, (goodAt.get(s) ?? 0) + 1);
  for (const s of bads) badAt.set(s, (badAt.get(s) ?? 0) + 1);
  const scores = [...new Set([...goodAt.keys(), ...badAt.keys()])].sort((a, b) => a - b);
  let goodsBelow = 0;
  let badsBelow = 0;
  let pairs = 0;
  let ks = 0;
  for (const s of scores) {
    const g = goodAt.get(s) ?? 0;
    const b = badAt.get(s) ?? 0;
    // Goods at this score beat every bad below it and tie with the bads at it.
    pairs += g * (badsBelow + b / 2);
    goodsBelow += g;
    badsBelow += b;
    ks = Math.max(ks, Math.abs(badsBelow / bads.length - goodsBelow / goods.length));
  }
  return {
    auc: pairs / (goods.length * bads.length),
    ks,
    goods: goods.length,
    bads: bads.length,
  };
}

/**
 * AUC and KS of score against the bad flag, over plans that had at least one payout. On a
 * normal run those are the plans the policy funded, so the figure is range restricted: the
 * score has already removed most of the applicants it would rank lowest. On a through the
 * door run they are every scored applicant.
 */
export function rankOrdering(customers: readonly CustomerResult[]): RankOrdering {
  const scored = customers.filter((c) => c.payoutCount > 0 && c.score !== null);
  return scoreSeparation(
    scored.filter((c) => !c.bad).map((c) => c.score!),
    scored.filter((c) => c.bad).map((c) => c.score!),
  );
}

/** Score bands for the through the door tables: five wide from 45 up, coarser below. */
export const THROUGH_THE_DOOR_BANDS = [
  '0-29',
  '30-39',
  '40-44',
  '45-49',
  '50-54',
  '55-59',
  '60-64',
  '65-69',
  '70-74',
  '75-79',
  '80-84',
  '85-89',
  '90-94',
  '95-100',
] as const;

export function throughTheDoorBand(score: number): string {
  if (score < 30) return '0-29';
  if (score < 40) return '30-39';
  if (score < 45) return '40-44';
  return calibrationBand(score);
}

/** Counterfactual bad rate of one group of scored applicants, with and without fraud. */
export interface ThroughTheDoorCell {
  /** Scored applicants in the group, all of whom the counterfactual run funded. */
  plans: number;
  bad: number;
  badRateBps: number;
  /** The same, leaving out the fraud archetypes. */
  honestPlans: number;
  honestBad: number;
  honestBadRateBps: number;
  /** How many of `plans` the policy itself approved on terms that open a plan. */
  approvedUsable: number;
}

export type PolicyOutcomeGroup = 'approvedUsable' | 'approvedCounterOffer' | 'declined';
export const POLICY_OUTCOME_GROUPS: readonly PolicyOutcomeGroup[] = [
  'approvedUsable',
  'approvedCounterOffer',
  'declined',
];

/**
 * How the score ranks risk across everyone it scored, from a through the door run (see
 * `runThroughTheDoor`). Nothing here is a portfolio result: the plans were opened only to be
 * watched.
 */
export interface ThroughTheDoorMetrics {
  applicants: number;
  /** Applicants with a score, each given a counterfactual plan. */
  scored: number;
  /** Applicants with no score (needs info): not in any figure below. */
  unscored: number;
  /** Honest applicants only. The AUC gate judges this one. */
  honest: RankOrdering;
  /** Honest and fraud archetype applicants together. */
  all: RankOrdering;
  byScoreBand: Record<string, ThroughTheDoorCell>;
  byGrade: Record<string, ThroughTheDoorCell>;
  /**
   * By what the policy decided: approved on terms that open a plan, approved for less than
   * the rent (which opens no plan in the product), and declined.
   */
  byPolicyOutcome: Record<PolicyOutcomeGroup, ThroughTheDoorCell>;
}

function policyOutcomeGroup(c: CustomerResult): PolicyOutcomeGroup {
  if (c.outcome !== 'APPROVED') return 'declined';
  return c.counterOffer ? 'approvedCounterOffer' : 'approvedUsable';
}

function throughTheDoorCell(customers: readonly CustomerResult[]): ThroughTheDoorCell {
  const honest = customers.filter((c) => c.fraud === null);
  const bad = customers.filter((c) => c.bad).length;
  const honestBad = honest.filter((c) => c.bad).length;
  return {
    plans: customers.length,
    bad,
    badRateBps: bps(bad, customers.length),
    honestPlans: honest.length,
    honestBad,
    honestBadRateBps: bps(honestBad, honest.length),
    approvedUsable: customers.filter((c) => policyOutcomeGroup(c) === 'approvedUsable').length,
  };
}

/**
 * Rank ordering and bad rates over the customers of a through the door run, from one seed
 * or from several seeds put end to end.
 */
export function throughTheDoorMetrics(customers: readonly CustomerResult[]): ThroughTheDoorMetrics {
  const scored = customers.filter((c) => c.payoutCount > 0 && c.score !== null);
  const cells = (key: (c: CustomerResult) => string | null, order: readonly string[]) => {
    const out: Record<string, ThroughTheDoorCell> = {};
    for (const [k, list] of groupBy(scored, key, order)) out[k] = throughTheDoorCell(list);
    return out;
  };
  return {
    applicants: customers.length,
    scored: scored.length,
    unscored: customers.length - scored.length,
    honest: rankOrdering(scored.filter((c) => c.fraud === null)),
    all: rankOrdering(scored),
    byScoreBand: cells((c) => throughTheDoorBand(c.score!), THROUGH_THE_DOOR_BANDS),
    byGrade: cells((c) => c.grade, GRADES),
    byPolicyOutcome: cells(policyOutcomeGroup, POLICY_OUTCOME_GROUPS) as Record<
      PolicyOutcomeGroup,
      ThroughTheDoorCell
    >,
  };
}

/** Five point bands from 45 up, the grain the PD table is calibrated on. */
export function calibrationBand(score: number): string {
  if (score < 45) return '0-44';
  if (score >= 95) return '95-100';
  const lo = Math.floor(score / 5) * 5;
  return `${lo}-${lo + 4}`;
}

/**
 * Expected against realized by score band, over funded plans that were priced on expected
 * loss. Expected bad rate is the mean PD. Expected loss is the per period expected loss in
 * the fee build up, weighted by volume, so it compares directly with net loss over volume.
 */
export function calibration(customers: readonly CustomerResult[]): CalibrationRow[] {
  const groups = new Map<string, CustomerResult[]>();
  for (const c of customers) {
    if (c.payoutCount === 0 || c.score === null || c.pdBps === null) continue;
    const band = calibrationBand(c.score);
    const list = groups.get(band);
    if (list) list.push(c);
    else groups.set(band, [c]);
  }
  return [...groups.entries()]
    .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10))
    .map(([band, list]) => {
      const volume = list.reduce((sum, c) => sum + c.payoutCents, 0);
      const netLoss = list.reduce((sum, c) => sum + c.chargedOffCents - c.recoveredCents, 0);
      const expectedLoss = list.reduce(
        (sum, c) => sum + (c.payoutCents * (c.expectedLossBps ?? 0)) / 10_000,
        0,
      );
      return {
        band,
        plans: list.length,
        expectedBadRateBps: Math.round(list.reduce((sum, c) => sum + c.pdBps!, 0) / list.length),
        realizedBadRateBps: bps(list.filter((c) => c.bad).length, list.length),
        expectedLossBps: bps(expectedLoss, volume),
        realizedLossBps: bps(netLoss, volume),
      };
    });
}

/**
 * Several runs of the same configuration on different seeds, as one book. Customers are
 * concatenated, so every cut (grade, band, archetype) is computed on all of them. Pool
 * figures are not additive across independent pools: the monthly series is the first run's,
 * the minimum is the lowest of any run, and shortfalls are summed.
 */
export function poolResults(results: readonly PortfolioResult[]): PortfolioResult {
  const first = results[0]!;
  return {
    ...first,
    poolMinCents: Math.min(...results.map((r) => r.poolMinCents)),
    unfundedPayouts: results.reduce((sum, r) => sum + r.unfundedPayouts, 0),
    unfundedPayoutDays: results.reduce((sum, r) => sum + r.unfundedPayoutDays, 0),
    plansDelayed: results.reduce((sum, r) => sum + r.plansDelayed, 0),
    plansNeverFunded: results.reduce((sum, r) => sum + r.plansNeverFunded, 0),
    bucketRoll: sumRolls(results.map((r) => r.bucketRoll)),
    bucketEntryRoll: sumRolls(results.map((r) => r.bucketEntryRoll)),
    customers: results.flatMap((r, i) =>
      r.customers.map((c) => ({ ...c, applicantId: `${i}:${c.applicantId}` })),
    ),
  };
}

function sumRolls(rolls: readonly BucketRoll[]): BucketRoll {
  const total = emptyBucketRoll();
  for (const roll of rolls) {
    for (const bucket of OPEN_BUCKETS) {
      total[bucket].observedCents += roll[bucket].observedCents;
      total[bucket].chargedOffCents += roll[bucket].chargedOffCents;
    }
  }
  return total;
}

export function concentration(byIndustry: Record<string, SegmentMetrics>): Concentration {
  const total = Object.values(byIndustry).reduce((sum, m) => sum + m.volumeCents, 0);
  let topShareBps = 0;
  let topIndustry: string | null = null;
  let hhi = 0;
  for (const [industry, m] of Object.entries(byIndustry)) {
    const share = total === 0 ? 0 : m.volumeCents / total;
    hhi += share * share * 10_000;
    if (bps(m.volumeCents, total) > topShareBps) {
      topShareBps = bps(m.volumeCents, total);
      topIndustry = industry;
    }
  }
  return { topShareBps, topIndustry, hhi: Math.round(hhi) };
}

export function computeMetrics(
  result: PortfolioResult,
  costs: CostAssumptions = DEFAULT_COSTS,
): PortfolioMetrics {
  const { customers } = result;
  const overall = segmentMetrics(customers, costs);
  const byIndustry = cut(customers, costs, (c) => c.industry);
  return {
    label: result.label,
    stress: result.stress,
    servicingPolicy: result.servicingPolicy,
    overall,
    funding: { plansDelayed: result.plansDelayed, plansNeverFunded: result.plansNeverFunded },
    calibration: calibration(customers),
    declineRateBps: bps(overall.declined, overall.applicants),
    needsInfoRateBps: bps(overall.needsInfo, overall.applicants),
    byGrade: cut(customers, costs, (c) => (c.payoutCount > 0 ? c.grade : null), GRADES),
    byScoreBand: cut(
      customers,
      costs,
      (c) => (c.payoutCount > 0 && c.score !== null ? scoreBand(c.score) : null),
      SCORE_BANDS,
    ),
    bySegment: cut(customers, costs, (c) => c.segment),
    byIndustry,
    rankOrdering: rankOrdering(customers),
    fraud: segmentMetrics(
      customers.filter((c) => c.fraud !== null),
      costs,
    ),
    honest: segmentMetrics(
      customers.filter((c) => c.fraud === null),
      costs,
    ),
    pool: {
      startCents: result.poolStartCents,
      endCents: result.poolEndCents,
      minCents: result.poolMinCents,
      peakUtilizationBps: result.pool.reduce((max, m) => Math.max(max, m.peakUtilizationBps), 0),
      peakMonthlyPayoutsCents: result.pool.reduce((max, m) => Math.max(max, m.payoutsCents), 0),
      unfundedPayouts: result.unfundedPayouts,
      unfundedPayoutDays: result.unfundedPayoutDays,
      everUnableToFund: result.unfundedPayouts > 0,
      months: result.pool,
    },
    concentration: concentration(byIndustry),
    bucketRoll: bucketRollRows(result.bucketRoll),
    bucketEntryRoll: bucketRollRows(result.bucketEntryRoll),
  };
}

/** Bad rate by grade for A to D, with the number of plans behind each rate. */
export function badRateByGrade(
  m: PortfolioMetrics,
): { grade: string; plans: number; badRateBps: number }[] {
  return ['A', 'B', 'C', 'D'].map((grade) => ({
    grade,
    plans: m.byGrade[grade]?.plans ?? 0,
    badRateBps: m.byGrade[grade]?.badRateBps ?? 0,
  }));
}

/**
 * Count places where a better grade has a higher bad rate than the next worse grade with
 * enough plans to judge. Grades with fewer than `minPlans` plans are skipped, and a gap of
 * `toleranceBps` or less is not counted.
 */
export function gradeInversions(
  m: PortfolioMetrics,
  minPlans: number,
  toleranceBps: number,
): number {
  const cells = badRateByGrade(m).filter((c) => c.plans >= minPlans);
  let inversions = 0;
  for (let i = 1; i < cells.length; i++) {
    if (cells[i - 1]!.badRateBps > cells[i]!.badRateBps + toleranceBps) inversions += 1;
  }
  return inversions;
}

export interface SwapSet {
  /** Approved by the challenger, not by the champion. */
  swapIn: { count: number; plans: number; badRateBps: number; netMarginCents: number };
  /** Approved by the champion, not by the challenger. */
  swapOut: { count: number; plans: number; badRateBps: number; netMarginCents: number };
  bothApproved: number;
  neitherApproved: number;
}

/**
 * Compare two runs over the same population. Swap ins are judged on how they performed in
 * the challenger run and swap outs on how they performed in the champion run, since each is
 * only ever funded in one of the two.
 */
export function swapSet(
  champion: PortfolioResult,
  challenger: PortfolioResult,
  costs: CostAssumptions = DEFAULT_COSTS,
): SwapSet {
  const challengerById = new Map(challenger.customers.map((c) => [c.applicantId, c]));
  const swapIn: CustomerResult[] = [];
  const swapOut: CustomerResult[] = [];
  let bothApproved = 0;
  let neitherApproved = 0;
  for (const champ of champion.customers) {
    const chall = challengerById.get(champ.applicantId);
    if (!chall) continue;
    const a = champ.outcome === 'APPROVED';
    const b = chall.outcome === 'APPROVED';
    if (a && b) bothApproved += 1;
    else if (!a && !b) neitherApproved += 1;
    else if (b) swapIn.push(chall);
    else swapOut.push(champ);
  }
  const summarize = (list: CustomerResult[]) => {
    const m = segmentMetrics(list, costs);
    return {
      count: list.length,
      plans: m.plans,
      badRateBps: m.badRateBps,
      netMarginCents: m.netMarginCents,
    };
  };
  return { swapIn: summarize(swapIn), swapOut: summarize(swapOut), bothApproved, neitherApproved };
}

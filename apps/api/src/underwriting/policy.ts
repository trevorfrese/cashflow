import type { CreditGrade } from '@cashflow/shared';

import type { VeracityPolicy } from '../veracity/types.ts';
import type { PaymentHistoryPolicy } from './payment-history.ts';
import { PD_TABLE_V2, type PdTable } from './pd-table.ts';

export type { PaymentHistoryPolicy } from './payment-history.ts';

/**
 * The credit policy as data.
 *
 * Every number the underwriting engine uses lives on a `CreditPolicy` object: cutoffs,
 * scorecard weights, grade floors, pricing, integrity thresholds, exposure caps, and the
 * triggers that send an application to a human. The engine takes a policy as an argument and
 * defaults to `CURRENT_POLICY`, so the portfolio evals can run an older version next to the
 * current one on the same applicants, and every stored decision can name the version that
 * made it.
 *
 * Changing a number here is a policy change. Give the policy a new `version`, rerun
 * `pnpm --filter @cashflow/api eval:portfolio`, and ship only if the gates pass.
 */

export interface GradeTerms {
  /** Lowest fee for the grade, in basis points of rent per period. */
  feeBps: number;
  /** Largest rent as a share of verified revenue, in basis points. */
  maxRentShareBps: number;
}

export interface ScorecardWeights {
  rentAffordability: number;
  cashFlowCoverage: number;
  cashBuffer: number;
  accountConduct: number;
  revenueStability: number;
  revenueTrend: number;
  debtLoad: number;
  dataDepth: number;
}

/** Earlier decline detection. See `detectDecline` in `features.ts`. */
export interface TrendPolicy {
  /**
   * With a year of history: decline when revenue over the trailing four weeks is down more
   * than this against the same weeks a year earlier (basis points, negative)...
   */
  maxYearOverYearDeclineBps: number;
  /** ...and the trailing twelve weeks are down at least this much on the twelve before. */
  confirmRecentDeclineBps: number;
  /**
   * The year over year threshold widens for businesses whose revenue is noisy month to
   * month: it is never tighter than this many times the business's own monthly variation.
   */
  volatilityMultiple: number;
  /**
   * Without a year of history: decline when the trailing twelve weeks are down more than this
   * on the twelve before.
   */
  maxRecentDeclineBps: number;
  /**
   * Decline with a thin buffer. A business whose revenue is falling by more than
   * `thinBufferDeclineBps` (season adjusted when a year of history exists) and that holds
   * fewer than `thinBufferDays` days of cash has no room to absorb the fall.
   */
  thinBufferDeclineBps: number;
  thinBufferDays: number;
}

export interface IntegrityPolicy {
  /** Stated revenue this far above verified is reported. The hard stop is `maxStatedRevenueVarianceBps`. */
  statedAboveInformBps: number;
  /** Stated revenue this far below verified suggests deposits that are not sales. */
  statedBelowReferBps: number;
  /** Bank deposits above this share of point of sale net sales need explaining. */
  maxDepositMatchBps: number;
  roundTrip: {
    /** A transfer out matches a credit when it posts within this many days after it... */
    windowDays: number;
    /** ...and its size is within this tolerance of the credit, in basis points. */
    amountToleranceBps: number;
    /** Credits smaller than this are ignored. */
    minAmountCents: number;
    /** Matched credits at or above this share of 90 day revenue credits, with `knockoutPairs` pairs, decline. */
    knockoutShareBps: number;
    knockoutPairs: number;
    /** Fewer or smaller matches refer. */
    referShareBps: number;
    referPairs: number;
  };
  /** Transfers in, loan proceeds, and other non sales credits above this share of 90 day credits refer. */
  maxNonSalesCreditShareBps: number;
  /** Owner transfers in during the last 30 days above this share of monthly revenue are reported. */
  ownerTopUpShareBps: number;
  /** Revenue in the last six weeks above the prior twenty by more than this refers. */
  maxRevenueSpikeBps: number;
  /** Account history shorter than time in business (capped at a year) by more than this many months refers. */
  maxHistoryGapMonths: number;
  /** Requested rent above observed rent by more than this multiple (basis points) is flagged and capped. */
  rentAboveObservedBps: number;
}

export interface PricingPolicy {
  pdTable: PdTable;
  /** Net loss on a plan that goes bad, as a share of one month's rent, in basis points. */
  lossGivenDefaultBps: number;
  /** Rent periods a plan is expected to be funded over the horizon the PD table covers. */
  expectedPeriods: number;
  /** Annual cost of funds, in basis points. */
  costOfFundsAprBps: number;
  /** Servicing cost per plan per month, in cents. */
  servicingCostCents: number;
  /** Margin the fee must leave after expected loss, funding, and servicing. */
  targetMarginBps: number;
  /** Smallest fee per period, in cents, whatever the rent. */
  minFeeCents: number;
  /** Largest fee per period, in basis points of rent. A required fee above it is a decline. */
  maxFeeBps: number;
  /** Fees are rounded up to this many basis points. */
  feeIncrementBps: number;
}

export interface ExposurePolicy {
  /**
   * The limit may be at most this multiple of the rent observed in the bank account, in
   * basis points, unless a reviewer has verified the lease another way.
   */
  maxObservedRentMultipleBps: number;
  /**
   * Largest monthly rent across a business's plans, by on time rent periods repaid. The
   * first rung is the first plan cap. Sorted by `afterOnTimePeriods` ascending.
   */
  ladder: ReadonlyArray<{ afterOnTimePeriods: number; capCents: number }>;
  /** Largest monthly rent across all of one business's plans and leases, whatever its history. */
  maxBusinessExposureCents: number;
  /** One business may hold at most this share of pool capital, in basis points. */
  maxSingleNameShareBps: number;
  /** One industry may hold at most this share of pool capital, in basis points. */
  maxIndustryShareBps: number;
  /**
   * Committed monthly rent as a share of pool capital above which new plans wait for
   * capacity, in basis points.
   */
  maxPoolUtilizationBps: number;
}

export interface EscalationPolicy {
  /** A passing score fewer than this many points above `minScore` is referred. */
  scoreBandAboveCutoff: number;
  /** A limit above this many cents a month is referred. */
  referAmountCents: number;
  /**
   * A counter offer on a first plan is referred when the limit is below this share of the
   * request, in basis points. 0 never refers on a counter offer.
   */
  referCounterOfferBelowBps: number;
}

export interface ReunderwritingPolicy {
  /** A periodic review that scores below this freezes the next rent period. */
  watchScore: number;
}

/**
 * Moving a pass-through customer onto a financed plan (policy version 4). The
 * refresh-eligibility job re-underwrites a pass-through customer on freshly pulled data and
 * its payment history once it has this many on time months in a row, at most once a calendar
 * month, and offers a financed plan when the result is an approval for at least the lease
 * rent. The owner has to accept, and the financed plan starts from the next period.
 */
export interface GraduationPolicy {
  /** On time pass-through months in a row before the business is re-underwritten. */
  minOnTimeMonths: number;
  /** Days an offer stays open. */
  offerValidDays: number;
}

export interface CreditPolicy {
  version: string;
  /** Full months of bank history before we can score at all. */
  minMonthsOfHistory: number;
  /** Months in business (self reported) below which we decline. */
  minTimeInBusinessMonths: number;
  /** Verified monthly revenue floor. */
  minVerifiedRevenueCents: number;
  /** Stated revenue more than this far above verified revenue needs explaining. 5000 bps = 50%. */
  maxStatedRevenueVarianceBps: number;
  /** Bank deposits must cover this share of POS net sales before POS sales count as verified revenue. */
  minDepositMatchBps: number;
  /** Hard limits on conduct in the last 90 days. */
  maxNsf90: number;
  maxNegativeBalanceDays90: number;
  /** Hard limit on rent as a share of verified revenue. */
  maxRentToRevenueBps: number;
  /** Steepest revenue decline we will accept, last 3 full months vs the prior 3. */
  maxRevenueDeclineBps: number;
  /** Free cash flow must cover rent plus fee by this much. 125 = 1.25x. */
  minCoverageRatio: number;
  /** Score below which we decline. */
  minScore: number;
  /** Approve at a lower limit when capacity is at least this share of the request. */
  minCounterOfferBps: number;
  /** Limits are rounded down to this increment. */
  limitIncrementCents: number;
  /** Fee floor and rent share by grade. */
  pricing: Record<CreditGrade, GradeTerms>;
  /** Lowest score for each grade, best grade first. */
  gradeFloors: ReadonlyArray<readonly [CreditGrade, number]>;
  weights: ScorecardWeights;
  /**
   * Fee assumed inside the scored coverage ratio. Version 1 scored every applicant at a flat
   * 2.5% whatever fee they were later quoted. From version 2 the scored ratio is free cash
   * over rent alone (0), because the fee is set from the score and a score that depends on
   * the fee is circular. The fee is applied exactly where it binds: in capacity, and in the
   * coverage ratio stored on the decision, both at the fee actually quoted.
   */
  scoredCoverageFeeBps: number;
  /**
   * Which scorecard to run. 1 is the launch scorecard. 2 reads the season adjusted trend,
   * blends the low point of the cash buffer into the buffer factor, and counts overdraft
   * fees from the whole year in conduct. 3 is 2 with a data depth factor that reads the
   * veracity assessment: the bank history credit scaled by the bank's trust tier, and the
   * second source point only for a platform that reconciles. See `scorecard.ts`.
   */
  scorecard: 1 | 2 | 3;
  /** Null turns the section off, which is how version 1 behaves. */
  trend: TrendPolicy | null;
  integrity: IntegrityPolicy | null;
  expectedLossPricing: PricingPolicy | null;
  exposure: ExposurePolicy | null;
  escalation: EscalationPolicy | null;
  reunderwriting: ReunderwritingPolicy;
  /** Data veracity checks (`src/veracity/`). Null turns them off, as in versions 1 and 2. */
  veracity: VeracityPolicy | null;
  /**
   * The payment history factor (version 4): on time months through CashFlow add points, late
   * and missed months take them away. Neutral without history. Null turns it off, as in
   * versions 1 to 3.
   */
  paymentHistory: PaymentHistoryPolicy | null;
  /** Graduation from a pass-through plan. Null: no refresh-eligibility reviews. */
  graduation: GraduationPolicy | null;
}

const GRADE_FLOORS: CreditPolicy['gradeFloors'] = [
  ['A', 80],
  ['B', 68],
  ['C', 55],
  ['D', 45],
  ['F', 0],
];

/**
 * Version 1: the policy the product launched with and Phase R1 measured. Kept so the evals
 * can run it as the comparison champion. Do not edit: it documents history.
 */
export const POLICY_V1: CreditPolicy = {
  version: 'cashflow-v1',
  minMonthsOfHistory: 6,
  minTimeInBusinessMonths: 6,
  minVerifiedRevenueCents: 500_000,
  maxStatedRevenueVarianceBps: 5000,
  minDepositMatchBps: 7000,
  maxNsf90: 2,
  maxNegativeBalanceDays90: 10,
  maxRentToRevenueBps: 4000,
  maxRevenueDeclineBps: -2500,
  minCoverageRatio: 125,
  minScore: 45,
  minCounterOfferBps: 5000,
  limitIncrementCents: 10_000,
  pricing: {
    A: { feeBps: 150, maxRentShareBps: 3000 },
    B: { feeBps: 200, maxRentShareBps: 2500 },
    C: { feeBps: 250, maxRentShareBps: 2000 },
    D: { feeBps: 300, maxRentShareBps: 1500 },
    F: { feeBps: 300, maxRentShareBps: 0 },
  },
  gradeFloors: GRADE_FLOORS,
  weights: {
    rentAffordability: 20,
    cashFlowCoverage: 20,
    cashBuffer: 15,
    accountConduct: 15,
    revenueStability: 10,
    revenueTrend: 10,
    debtLoad: 5,
    dataDepth: 5,
  },
  scoredCoverageFeeBps: 250,
  scorecard: 1,
  trend: null,
  integrity: null,
  expectedLossPricing: null,
  exposure: null,
  escalation: null,
  reunderwriting: { watchScore: 45 },
  veracity: null,
  paymentHistory: null,
  graduation: null,
};

/**
 * Version 2. What changed from version 1 and the evidence for each number is in
 * `apps/api/UNDERWRITING.md`; the measured effect is in `apps/api/evals/report.md`.
 */
export const POLICY_V2: CreditPolicy = {
  ...POLICY_V1,
  version: 'cashflow-v2',
  minScore: 50,
  scoredCoverageFeeBps: 0,
  scorecard: 2,
  weights: {
    rentAffordability: 10,
    cashFlowCoverage: 15,
    cashBuffer: 30,
    accountConduct: 15,
    revenueStability: 10,
    revenueTrend: 10,
    debtLoad: 5,
    dataDepth: 5,
  },
  trend: {
    maxYearOverYearDeclineBps: -1500,
    confirmRecentDeclineBps: -500,
    volatilityMultiple: 1.5,
    maxRecentDeclineBps: -2000,
    thinBufferDeclineBps: -1000,
    thinBufferDays: 14,
  },
  integrity: {
    statedAboveInformBps: 2500,
    statedBelowReferBps: -4000,
    maxDepositMatchBps: 15_000,
    roundTrip: {
      windowDays: 4,
      amountToleranceBps: 200,
      minAmountCents: 50_000,
      knockoutShareBps: 1000,
      knockoutPairs: 3,
      referShareBps: 300,
      referPairs: 2,
    },
    maxNonSalesCreditShareBps: 3000,
    ownerTopUpShareBps: 1000,
    maxRevenueSpikeBps: 7500,
    maxHistoryGapMonths: 3,
    rentAboveObservedBps: 12_000,
  },
  expectedLossPricing: {
    pdTable: PD_TABLE_V2,
    lossGivenDefaultBps: PD_TABLE_V2.measuredLossGivenDefaultBps,
    expectedPeriods: PD_TABLE_V2.measuredPeriodsPerPlan,
    costOfFundsAprBps: 1200,
    servicingCostCents: 1200,
    targetMarginBps: 40,
    minFeeCents: 2000,
    maxFeeBps: 400,
    feeIncrementBps: 5,
  },
  exposure: {
    maxObservedRentMultipleBps: 12_000,
    ladder: [
      { afterOnTimePeriods: 0, capCents: 1_000_000 },
      { afterOnTimePeriods: 3, capCents: 2_000_000 },
      { afterOnTimePeriods: 6, capCents: 4_000_000 },
    ],
    maxBusinessExposureCents: 4_000_000,
    maxSingleNameShareBps: 500,
    maxIndustryShareBps: 4000,
    maxPoolUtilizationBps: 8500,
  },
  escalation: {
    scoreBandAboveCutoff: 5,
    referAmountCents: 1_000_000,
    referCounterOfferBelowBps: 0,
  },
  reunderwriting: { watchScore: 50 },
};

/**
 * The veracity thresholds of version 3. The reasoning for each is in
 * `apps/api/UNDERWRITING.md`, "Veracity", and the measured effect in `evals/report.md`.
 */
export const VERACITY_POLICY_V3: VeracityPolicy = {
  nameMatchThreshold: 0.8,
  reconciliation: {
    windowDays: 90,
    inTransitDays: 5,
    daysBefore: 1,
    daysAfter: 4,
    toleranceBps: 50,
    toleranceMinCents: 100,
    maxCombine: 4,
    minPayouts: 8,
    excludeBelowBps: 8500,
    referBelowBps: 5000,
    claimedUnmatchedShareBps: 2000,
    claimedUnmatchedMinCount: 3,
    minPayoutToCardSalesBps: 7500,
    unseenPayoutShareBps: 1500,
  },
  completeness: {
    unseenTransferShareBps: 1000,
    unseenTransferWindows: 3,
    minBankToCardSalesBps: 7000,
  },
  consistency: {
    pendingToleranceDays: 7,
    materialItems: 3,
    materialShareBps: 100,
  },
  age: {
    recentAccountMonths: 6,
    establishedBankMonths: 24,
    establishedPlatformMonths: 12,
    surgeBps: 4000,
    gapDays: 14,
  },
  freshness: {
    maxSnapshotAgeDays: 1,
    maxDataAgeDays: 7,
  },
  depth: {
    tierMultiplier: { HIGH: 1, MEDIUM: 0.75, LOW: 0.5, NONE: 0 },
  },
};

/**
 * Version 3: version 2 plus the data veracity checks. Every other number is version 2's: the
 * PD table is not regenerated (see UNDERWRITING.md for why).
 */
export const POLICY_V3: CreditPolicy = {
  ...POLICY_V2,
  version: 'cashflow-v3',
  scorecard: 3,
  veracity: VERACITY_POLICY_V3,
};

/**
 * The payment history factor of version 4. The reasoning for each number is in
 * `apps/api/UNDERWRITING.md`, "Payment history".
 */
export const PAYMENT_HISTORY_POLICY_V4: PaymentHistoryPolicy = {
  lookbackMonths: 12,
  pointsPerOnTimeMonth: 2,
  maxBonusPoints: 8,
  latePenaltyPoints: 4,
  missPenaltyPoints: 10,
  maxPenaltyPoints: 20,
};

/**
 * Version 4: version 3 plus the payment history factor and graduation from a pass-through
 * plan. Every other number is version 3's. The factor is neutral without history, so a first
 * time applicant gets exactly the version 3 decision; the PD table is not regenerated (see
 * UNDERWRITING.md for why).
 */
export const POLICY_V4: CreditPolicy = {
  ...POLICY_V3,
  version: 'cashflow-v4',
  paymentHistory: PAYMENT_HISTORY_POLICY_V4,
  graduation: { minOnTimeMonths: 3, offerValidDays: 30 },
};

export const CURRENT_POLICY: CreditPolicy = POLICY_V4;
export const POLICY_VERSION: string = CURRENT_POLICY.version;

/** Policies by version, for reading a stored decision back against the rules that made it. */
export const POLICIES: Readonly<Record<string, CreditPolicy>> = {
  [POLICY_V1.version]: POLICY_V1,
  [POLICY_V2.version]: POLICY_V2,
  [POLICY_V3.version]: POLICY_V3,
  [POLICY_V4.version]: POLICY_V4,
};

/** The cutoffs in force, for the decision snapshot. Internal: never sent to applicants. */
export function thresholdsInForce(policy: CreditPolicy) {
  return {
    minMonthsOfHistory: policy.minMonthsOfHistory,
    minTimeInBusinessMonths: policy.minTimeInBusinessMonths,
    minVerifiedRevenueCents: policy.minVerifiedRevenueCents,
    maxStatedRevenueVarianceBps: policy.maxStatedRevenueVarianceBps,
    minDepositMatchBps: policy.minDepositMatchBps,
    maxNsf90: policy.maxNsf90,
    maxNegativeBalanceDays90: policy.maxNegativeBalanceDays90,
    maxRentToRevenueBps: policy.maxRentToRevenueBps,
    maxRevenueDeclineBps: policy.maxRevenueDeclineBps,
    minCoverageRatio: policy.minCoverageRatio,
    minScore: policy.minScore,
    minCounterOfferBps: policy.minCounterOfferBps,
    trend: policy.trend,
    integrity: policy.integrity,
    exposure: policy.exposure,
    escalation: policy.escalation,
    maxFeeBps: policy.expectedLossPricing?.maxFeeBps ?? null,
    minFeeCents: policy.expectedLossPricing?.minFeeCents ?? null,
    veracity: policy.veracity,
    paymentHistory: policy.paymentHistory,
    graduation: policy.graduation,
  };
}
export type PolicyThresholds = ReturnType<typeof thresholdsInForce>;

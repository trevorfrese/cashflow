import type {
  BankTransaction,
  CashFlowSummary,
  CommercePlatform,
  CreditGrade,
  DailySales,
  DecisionOutcome,
  DecisionReason,
  IsoDate,
  VeracityAssessment,
  VeracityFinding,
} from '@cashflow/shared';
import { formatCents } from '@cashflow/shared';

import {
  approvedLimit,
  checkFunding,
  NO_EXPOSURE_CONTEXT,
  type ExposureContext,
  type FundingCheck,
  type LimitResult,
} from './exposure.ts';
import { computeCashFlowFeatures, coverageRatio, freeCashCents } from './features.ts';
import {
  findRoundTrips,
  flagsWithAction,
  runIntegrityChecks,
  type IntegrityContext,
  type IntegrityFlag,
} from './integrity.ts';
import {
  CURRENT_POLICY,
  thresholdsInForce,
  type CreditPolicy,
  type PolicyThresholds,
} from './policy.ts';
import { priceFee, type FeeBuildUp } from './pricing.ts';
import { scoreCashFlow } from './scorecard.ts';
import { assessVeracity, depthCredit, findingsWith } from '../veracity/assess.ts';
import type { VeracityInput } from '../veracity/types.ts';

/**
 * Cash flow based underwriting for rent advances.
 *
 * Order of operations:
 *   1. Missing data -> NEEDS_INFO. We never decline for information we have not received.
 *   2. Features from bank transactions (and platform sales when a POS is connected). Credits
 *      the integrity checks matched to a same sized transfer out are left out of revenue.
 *   3. Integrity checks: can the numbers be trusted. See `integrity.ts`.
 *   4. A 0 to 100 score and letter grade.
 *   5. Hard policy rules -> DECLINED regardless of score.
 *   6. Capacity, price, and exposure limit, solved together: the fee depends on the rent
 *      (servicing is a fixed cost) and the rent we can front depends on the fee.
 *   7. A fee above the cap -> DECLINED. An offer under half the request -> DECLINED.
 *   8. Escalation: anything a person should look at -> REFER, carrying the terms the engine
 *      would have offered.
 *
 * Every number comes from the `CreditPolicy` passed in, which defaults to the current one.
 * The function is pure: same input and policy, same result.
 */

export interface EngineInput {
  statedMonthlyRevenueCents: number;
  timeInBusinessMonths: number;
  requestedMonthlyRentCents: number;
  bankData: {
    transactions: BankTransaction[];
    currentBalanceCents: number | null;
    asOf: IsoDate;
  } | null;
  /** Daily sales from a connected point of sale. Optional; verifies revenue at the source. */
  commerceData?: {
    platform: CommercePlatform;
    dailySales: DailySales[];
    connectedSince: IsoDate;
  } | null;
  /** Facts the service looked up for the integrity checks. Absent means not checked. */
  integrityContext?: IntegrityContext | null;
  /** What the business and the pool already hold. Absent means a new customer, pool unknown. */
  exposureContext?: ExposureContext | null;
  /**
   * A periodic review of a running plan. What the owner stated on the application months
   * ago is no longer the question, so the stated revenue checks are skipped: a business
   * whose revenue has collapsed must be scored, not asked to explain the gap.
   */
  periodicReview?: boolean;
  /**
   * Portfolio controls in force, looked up by the service. `approvalsPaused` is the circuit
   * breaker: an application the engine would approve is referred to a reviewer instead.
   */
  controls?: { approvalsPaused?: boolean } | null;
  /**
   * Data veracity facts: every connection's platform-reported identity and its snapshots.
   * The service gathers them; the engine runs the pure checks in `src/veracity/` under the
   * policy's thresholds. Absent, or a policy without `veracity`, means not checked.
   */
  veracity?: VeracityInput | null;
}

/**
 * Everything behind a decision that is stored but never shown to the applicant: the policy
 * version and cutoffs in force, what went in, integrity flags, the fee build up with PD and
 * expected loss, the caps on the limit, and why it was referred.
 */
export interface DecisionSnapshot {
  policyVersion: string;
  inputs: {
    statedMonthlyRevenueCents: number;
    timeInBusinessMonths: number;
    requestedMonthlyRentCents: number;
    asOf: IsoDate | null;
    transactionCount: number;
    excludedRoundTripCredits: number;
    commercePlatform: CommercePlatform | null;
    integrityContext: IntegrityContext | null;
    exposureContext: ExposureContext | null;
  };
  thresholds: PolicyThresholds;
  integrityFlags: IntegrityFlag[];
  pricing: FeeBuildUp | null;
  exposure: LimitResult | null;
  funding: FundingCheck | null;
  /** Empty unless the outcome is REFER. */
  referTriggers: string[];
  /** The data veracity assessment, with the snapshot ids and hashes it read. */
  veracity: VeracityAssessment | null;
  /** What the engine would have done had nothing sent the application to a reviewer. */
  recommendation: {
    outcome: DecisionOutcome;
    approvedMonthlyLimitCents: number | null;
    feeBps: number | null;
  };
}

export interface EngineResult {
  outcome: DecisionOutcome;
  /**
   * The limit and fee offered. On a REFER these are the engine's recommended terms for the
   * reviewer; serializers do not show them to the applicant until a review approves.
   */
  approvedMonthlyLimitCents: number | null;
  feeBps: number | null;
  score: number | null;
  grade: CreditGrade | null;
  recommendedInstallmentsPerMonth: number | null;
  reasons: DecisionReason[];
  cashFlow: CashFlowSummary | null;
  policyVersion: string;
  snapshot: DecisionSnapshot;
}

/** The current policy. Kept under this name for callers that predate `policy.ts`. */
export const POLICY = CURRENT_POLICY;

function reason(
  code: string,
  message: string,
  impact: DecisionReason['impact'] = 'NEGATIVE',
): DecisionReason {
  return { code, message, impact };
}

/**
 * Largest rent such that revenue share and coverage policies both hold, rounded down.
 * `feeBps` is the fee the coverage test must leave room for; it defaults to the grade floor.
 */
export function capacityCents(
  s: CashFlowSummary,
  grade: CreditGrade,
  policy: CreditPolicy = CURRENT_POLICY,
  feeBps: number = policy.pricing[grade].feeBps,
): number {
  const revenueCap =
    (s.verifiedMonthlyRevenueCents * policy.pricing[grade].maxRentShareBps) / 10_000;
  const feeMultiplier = 1 + feeBps / 10_000;
  const coverageCap = freeCashCents(s) / ((policy.minCoverageRatio / 100) * feeMultiplier);
  const raw = Math.min(revenueCap, coverageCap);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw / policy.limitIncrementCents) * policy.limitIncrementCents;
}

/**
 * Suggest how many installments per month. Businesses with daily card deposits and a thin
 * buffer are better served by smaller, more frequent debits; everyone else gets the default two.
 */
export function recommendInstallments(s: CashFlowSummary): number {
  if ((s.daysOfCashOnHand ?? 0) < 21 && s.depositDaysPerMonth >= 15) return 4;
  if (s.revenueVolatilityBps > 3500 && s.depositDaysPerMonth >= 15) return 4;
  return 2;
}

export interface DeclineSignal {
  code: 'REVENUE_DECLINING' | 'DECLINE_WITH_THIN_BUFFER';
  message: string;
}

/**
 * Earlier decline detection (policy version 2).
 *
 * Version 1 declined only when the last three full months were more than 25% below the prior
 * three. By the time a slide shows that clearly in calendar quarters it is months old. This
 * looks at windows that end on the application date, and uses the same weeks a year earlier
 * to tell a seasonal trough from a decline:
 *
 *   - With a year of history: decline when the trailing four weeks are down against a year
 *     ago by more than the threshold (widened for businesses whose months are noisy), and
 *     the trailing twelve weeks confirm it. A seasonal business in its slow season is level
 *     with last year and passes.
 *   - Without a year of history there is no way to rule out a season, so the bar is higher:
 *     the trailing twelve weeks must be well down on the twelve before.
 *   - Either way, a smaller decline is enough when the cash buffer is thin, because there is
 *     nothing to absorb it.
 */
export function detectDecline(s: CashFlowSummary, policy: CreditPolicy): DeclineSignal | null {
  const rules = policy.trend;
  const t = s.revenueTrend ?? null;
  if (!rules || !t) return null;
  const pct = (bpsValue: number) => `${Math.abs(bpsValue / 100).toFixed(0)}%`;
  const thin = s.daysOfCashOnHand !== null && s.daysOfCashOnHand < rules.thinBufferDays;
  const recent = t.recent12VsPrior12WeeksBps;
  if (t.yearOverYearBps !== null) {
    const yoy = t.yearOverYearBps;
    const confirmed = recent !== null && recent < rules.confirmRecentDeclineBps;
    const threshold = Math.min(
      rules.maxYearOverYearDeclineBps,
      -Math.round(s.revenueVolatilityBps * rules.volatilityMultiple),
    );
    if (yoy < threshold && confirmed) {
      return {
        code: 'REVENUE_DECLINING',
        message: `Revenue over the last four weeks is down ${pct(yoy)} on the same weeks a year ago, and the last twelve weeks are down ${pct(recent)} on the twelve before.`,
      };
    }
    if (thin && yoy < rules.thinBufferDeclineBps && confirmed) {
      return {
        code: 'DECLINE_WITH_THIN_BUFFER',
        message: `Revenue is down ${pct(yoy)} on a year ago with ${s.daysOfCashOnHand} days of cash on hand, which leaves no room to absorb a further fall.`,
      };
    }
    return null;
  }
  if (recent === null) return null;
  if (recent < rules.maxRecentDeclineBps) {
    return {
      code: 'REVENUE_DECLINING',
      message: `Revenue over the last twelve weeks is down ${pct(recent)} on the twelve weeks before.`,
    };
  }
  if (thin && recent < rules.thinBufferDeclineBps) {
    return {
      code: 'DECLINE_WITH_THIN_BUFFER',
      message: `Revenue is down ${pct(recent)} over the last twelve weeks with ${s.daysOfCashOnHand} days of cash on hand, which leaves no room to absorb a further fall.`,
    };
  }
  return null;
}

const usd = (cents: number) => formatCents(cents, { showCents: false });
const feePct = (feeBps: number) =>
  `${(feeBps / 100).toFixed(feeBps % 100 === 0 ? 0 : feeBps % 10 === 0 ? 1 : 2)}%`;

export function decide(input: EngineInput, policy: CreditPolicy = CURRENT_POLICY): EngineResult {
  const requested = input.requestedMonthlyRentCents;
  const snapshot: DecisionSnapshot = {
    policyVersion: policy.version,
    inputs: {
      statedMonthlyRevenueCents: input.statedMonthlyRevenueCents,
      timeInBusinessMonths: input.timeInBusinessMonths,
      requestedMonthlyRentCents: requested,
      asOf: input.bankData?.asOf ?? null,
      transactionCount: input.bankData?.transactions.length ?? 0,
      excludedRoundTripCredits: 0,
      commercePlatform: input.commerceData?.platform ?? null,
      integrityContext: input.integrityContext ?? null,
      exposureContext: input.exposureContext ?? null,
    },
    thresholds: thresholdsInForce(policy),
    integrityFlags: [],
    pricing: null,
    exposure: null,
    funding: null,
    referTriggers: [],
    veracity: null,
    recommendation: { outcome: 'NEEDS_INFO', approvedMonthlyLimitCents: null, feeBps: null },
  };
  const veracity =
    policy.veracity && input.veracity ? assessVeracity(input.veracity, policy.veracity) : null;
  snapshot.veracity = veracity;
  const needsInfo = (
    reasons: DecisionReason[],
    cashFlow: CashFlowSummary | null,
  ): EngineResult => ({
    outcome: 'NEEDS_INFO',
    approvedMonthlyLimitCents: null,
    feeBps: null,
    score: null,
    grade: null,
    recommendedInstallmentsPerMonth: null,
    reasons,
    cashFlow,
    policyVersion: policy.version,
    snapshot,
  });

  if (!input.bankData) {
    const reconnect = veracity ? findingsWith(veracity, 'NEEDS_INFO') : [];
    if (reconnect.length > 0)
      return needsInfo(
        reconnect.map((f) => veracityReason(f)),
        null,
      );
    return needsInfo(
      [
        reason(
          'BANK_LINK_REQUIRED',
          'Connect your business bank account so we can verify revenue and cash flow.',
          'INFO',
        ),
      ],
      null,
    );
  }

  // Deposits that left again as a same sized transfer are not revenue. Find them first so
  // every feature downstream is computed without them.
  const roundTrips = policy.integrity
    ? findRoundTrips(input.bankData.transactions, input.bankData.asOf, policy.integrity.roundTrip)
    : [];
  snapshot.inputs.excludedRoundTripCredits = roundTrips.length;

  let cashFlow = computeCashFlowFeatures({
    transactions: input.bankData.transactions,
    currentBalanceCents: input.bankData.currentBalanceCents,
    asOf: input.bankData.asOf,
    statedMonthlyRevenueCents: input.statedMonthlyRevenueCents,
    requestedMonthlyRentCents: requested,
    provisionalFeeBps: policy.scoredCoverageFeeBps,
    commerce: input.commerceData
      ? { ...input.commerceData, trusted: commerceTrusted(veracity) }
      : null,
    ...(roundTrips.length > 0
      ? { excludeTransactionIds: new Set(roundTrips.map((m) => m.creditId)) }
      : {}),
  });

  if (cashFlow.monthsOfHistory < policy.minMonthsOfHistory) {
    return needsInfo(
      [
        reason(
          'INSUFFICIENT_HISTORY',
          `We found ${cashFlow.monthsOfHistory} month${cashFlow.monthsOfHistory === 1 ? '' : 's'} of transactions. Connect the account that has received your revenue for at least ${policy.minMonthsOfHistory} months.`,
          'INFO',
        ),
      ],
      cashFlow,
    );
  }

  const flags = policy.integrity
    ? runIntegrityChecks(
        {
          transactions: input.bankData.transactions,
          asOf: input.bankData.asOf,
          summary: cashFlow,
          statedMonthlyRevenueCents: input.statedMonthlyRevenueCents,
          timeInBusinessMonths: input.timeInBusinessMonths,
          requestedMonthlyRentCents: requested,
          checkStatedRevenue: !input.periodicReview,
          maxStatedRevenueVarianceBps: policy.maxStatedRevenueVarianceBps,
          minDepositMatchBps: policy.minDepositMatchBps,
          context: input.integrityContext ?? null,
        },
        policy.integrity,
        roundTrips,
      )
    : [];
  snapshot.integrityFlags = flags;
  const integrityKnockouts = flagsWithAction(flags, 'KNOCKOUT');
  const veracityKnockouts = veracity ? findingsWith(veracity, 'KNOCKOUT') : [];

  // Something only the owner can fix (connect the account sales are paid into, reconnect a
  // bank that could not be refreshed) is asked for, never declined. A periodic review is
  // scored anyway: the owner is prompted, and the plan is judged on the bank.
  if (veracity && integrityKnockouts.length === 0 && veracityKnockouts.length === 0) {
    const asks = findingsWith(veracity, 'NEEDS_INFO').filter(
      (f) => !input.periodicReview || f.code === 'BANK_DATA_UNAVAILABLE',
    );
    if (asks.length > 0)
      return needsInfo(
        asks.map((f) => veracityReason(f)),
        cashFlow,
      );
  }

  // A knockout flag is decided now. Otherwise a large gap between stated and verified
  // revenue is a question for the applicant, not a decline.
  if (
    integrityKnockouts.length === 0 &&
    !input.periodicReview &&
    cashFlow.statedRevenueVarianceBps > policy.maxStatedRevenueVarianceBps
  ) {
    return needsInfo(
      [
        reason(
          'REVENUE_MISMATCH',
          `You stated ${usd(input.statedMonthlyRevenueCents)} a month but we verified ${usd(cashFlow.verifiedMonthlyRevenueCents)}. Connect any other accounts that receive revenue, or update the stated figure.`,
          'INFO',
        ),
      ],
      cashFlow,
    );
  }

  const card = scoreCashFlow(
    cashFlow,
    policy,
    veracity && policy.veracity ? depthCredit(veracity, policy.veracity) : null,
  );
  const reasons: DecisionReason[] = card.factors.map((f) => reason(f.code, f.message, f.impact));
  const knockouts: DecisionReason[] = [];

  // A connected POS whose sales are not showing up in the bank is information, never a
  // decline. We fall back to the bank figure and tell the applicant why.
  const commerce = cashFlow.commerce;
  if (
    commerce &&
    commerce.depositMatchBps !== null &&
    commerce.depositMatchBps < policy.minDepositMatchBps
  ) {
    reasons.push(
      reason(
        'DEPOSIT_MISMATCH',
        `Bank deposits cover ${(commerce.depositMatchBps / 100).toFixed(0)}% of the sales your point of sale reports, so we verified revenue from the bank. Connect any other account that receives your sales.`,
        'INFO',
      ),
    );
  }

  for (const f of integrityKnockouts) {
    if (f.code === 'ROUND_TRIP_DEPOSITS') {
      knockouts.push(
        reason(
          'UNVERIFIED_DEPOSITS',
          'Several large deposits were followed within days by transfers out of the same amount. We could not count them as revenue and cannot approve an application on this account.',
        ),
      );
    } else if (f.code === 'LANDLORD_IS_APPLICANT_ACCOUNT') {
      knockouts.push(
        reason(
          'LANDLORD_ACCOUNT_MATCH',
          'The landlord payout account on your lease matches a bank account linked to your business. Rent has to be paid to the landlord.',
        ),
      );
    } else if (f.code === 'IDENTITY_VERIFICATION_FAILED') {
      knockouts.push(
        reason(
          'IDENTITY_NOT_VERIFIED',
          'We could not verify the business details you gave us. Check the legal name, address, tax id and owners on your profile, or contact support and we will help you finish verification.',
        ),
      );
    } else {
      knockouts.push(reason('INTEGRITY_CHECK_FAILED', 'We could not verify this application.'));
    }
  }
  for (const f of veracityKnockouts) knockouts.push(veracityReason(f, 'NEGATIVE'));
  if (input.timeInBusinessMonths < policy.minTimeInBusinessMonths) {
    knockouts.push(
      reason(
        'TIME_IN_BUSINESS',
        `We need at least ${policy.minTimeInBusinessMonths} months in business. You reported ${input.timeInBusinessMonths}.`,
      ),
    );
  }
  if (cashFlow.verifiedMonthlyRevenueCents < policy.minVerifiedRevenueCents) {
    knockouts.push(
      reason(
        'REVENUE_TOO_LOW',
        `Verified revenue of ${usd(cashFlow.verifiedMonthlyRevenueCents)} a month is below our ${usd(policy.minVerifiedRevenueCents)} minimum.`,
      ),
    );
  }
  if (cashFlow.nsfCount90 > policy.maxNsf90) {
    knockouts.push(
      reason(
        'EXCESSIVE_OVERDRAFTS',
        `${cashFlow.nsfCount90} overdraft fees in the last 90 days. We allow at most ${policy.maxNsf90}.`,
      ),
    );
  }
  if (cashFlow.negativeBalanceDays90 > policy.maxNegativeBalanceDays90) {
    knockouts.push(
      reason(
        'NEGATIVE_BALANCE_DAYS',
        `The account was overdrawn on ${cashFlow.negativeBalanceDays90} of the last 90 days.`,
      ),
    );
  }
  if (cashFlow.rentToRevenueBps > policy.maxRentToRevenueBps) {
    knockouts.push(
      reason(
        'RENT_EXCEEDS_REVENUE_SHARE',
        `Requested rent is ${(cashFlow.rentToRevenueBps / 100).toFixed(0)}% of verified revenue. Our maximum is ${policy.maxRentToRevenueBps / 100}%.`,
      ),
    );
  }
  if (cashFlow.monthsOfHistory >= 6 && cashFlow.revenueGrowthBps < policy.maxRevenueDeclineBps) {
    knockouts.push(
      reason(
        'REVENUE_DECLINING',
        `Revenue fell ${Math.abs(cashFlow.revenueGrowthBps / 100).toFixed(0)}% over the last three months compared with the prior three.`,
      ),
    );
  } else {
    const decline = detectDecline(cashFlow, policy);
    if (decline) knockouts.push(reason(decline.code, decline.message));
  }
  if (freeCashCents(cashFlow) <= 0) {
    knockouts.push(
      reason(
        'NEGATIVE_FREE_CASH_FLOW',
        'After operating expenses, owner draws, and existing debt, the business is not generating free cash flow to fund rent repayments.',
      ),
    );
  }
  if (card.score < policy.minScore) {
    knockouts.push(
      reason(
        'SCORE_BELOW_MINIMUM',
        `Overall cash flow score of ${card.score} is below our minimum of ${policy.minScore}.`,
      ),
    );
  }

  const installments = recommendInstallments(cashFlow);
  const finish = (
    outcome: DecisionOutcome,
    limitCents: number | null,
    feeBps: number | null,
    allReasons: DecisionReason[],
  ): EngineResult => {
    if (snapshot.referTriggers.length === 0) {
      snapshot.recommendation = { outcome, approvedMonthlyLimitCents: limitCents, feeBps };
    }
    return {
      outcome,
      approvedMonthlyLimitCents: limitCents,
      feeBps,
      score: card.score,
      grade: card.grade,
      recommendedInstallmentsPerMonth: installments,
      reasons: allReasons,
      cashFlow,
      policyVersion: policy.version,
      snapshot,
    };
  };
  const declined = (first: DecisionReason[]) =>
    finish('DECLINED', null, null, [...first, ...reasons]);

  if (knockouts.length > 0) return declined(knockouts);

  // Capacity, price, and limit depend on each other: servicing is a fixed cost so the fee
  // rate rises as the rent falls, and a higher fee leaves less room under the coverage test.
  // Start at the requested rent and step down until the three agree. The rent only ever
  // falls, so this settles in a couple of rounds.
  const gradeFeeBps = policy.pricing[card.grade].feeBps;
  const exposureContext = input.exposureContext ?? NO_EXPOSURE_CONTEXT;
  const leaseVerified = input.integrityContext?.leaseVerified ?? false;
  let rent = requested;
  let fee: FeeBuildUp | null = null;
  let feeBps = gradeFeeBps;
  let capacity = 0;
  let limit: LimitResult | null = null;
  let limitCents = 0;
  for (let round = 0; round < 6; round++) {
    fee = policy.expectedLossPricing
      ? priceFee(
          { pricing: policy.pricing, expectedLossPricing: policy.expectedLossPricing },
          {
            score: card.score,
            grade: card.grade,
            rentCents: rent,
            installmentsPerMonth: installments,
          },
        )
      : null;
    feeBps = fee?.feeBps ?? gradeFeeBps;
    capacity = capacityCents(cashFlow, card.grade, policy, feeBps);
    limit = policy.exposure
      ? approvedLimit(policy.exposure, {
          requestedCents: requested,
          capacityCents: capacity,
          observedRentCents: cashFlow.observedRentCents,
          leaseVerified,
          incrementCents: policy.limitIncrementCents,
          context: exposureContext,
        })
      : null;
    limitCents = limit ? limit.limitCents : capacity;
    const fronted = Math.min(requested, limitCents);
    if (fronted === rent || fronted <= 0) break;
    rent = fronted;
  }
  snapshot.pricing = fee;
  snapshot.exposure = limit;
  // A veracity finding mapped to CAP holds the limit to a share of the request. None is
  // mapped to it in version 3: in a whole lease product a cap is an unusable counter offer.
  if (veracity && findingsWith(veracity, 'CAP').length > 0) {
    limitCents = Math.min(
      limitCents,
      Math.floor((requested * 7500) / 10_000 / policy.limitIncrementCents) *
        policy.limitIncrementCents,
    );
  }

  if (capacity <= 0) {
    return declined([
      reason(
        'INSUFFICIENT_CAPACITY',
        'Free cash flow after expenses and debt does not leave room for a rent advance with a margin of safety.',
      ),
    ]);
  }
  if (limitCents <= 0) {
    return declined([
      reason(
        'EXPOSURE_LIMIT_REACHED',
        'Your business already has as much rent with CashFlow as we can front for one business right now.',
      ),
    ]);
  }
  if (fee && !fee.withinCap) {
    return declined([
      fee.driver === 'MINIMUM_FEE' || fee.servicingBps >= fee.maxFeeBps / 2
        ? reason(
            'RENT_BELOW_MINIMUM',
            `Our fee has to cover a fixed cost of running each plan. At ${usd(fee.rentCents)} of monthly rent that comes to ${feePct(fee.feeBps)}, above our maximum fee of ${feePct(fee.maxFeeBps)}.`,
          )
        : reason(
            'FEE_ABOVE_MAXIMUM',
            `The fee needed to cover the risk and cost of this plan would be ${feePct(fee.feeBps)} of rent, above our maximum of ${feePct(fee.maxFeeBps)}. We would rather decline than approve at a price that does not cover the risk.`,
          ),
    ]);
  }

  // The coverage ratio stored on the decision is restated at the fee actually quoted.
  if (policy.scoredCoverageFeeBps === 0) {
    cashFlow = {
      ...cashFlow,
      rentCoverageRatio: coverageRatio(freeCashCents(cashFlow), requested, feeBps),
    };
  }

  const binding = limit?.binding ?? 'CAPACITY';
  let first: DecisionReason;
  if (limitCents < requested) {
    const shareBps = Math.round((limitCents * 10_000) / requested);
    if (shareBps < policy.minCounterOfferBps) {
      return declined([
        binding === 'OBSERVED_RENT'
          ? reason(
              'RENT_NOT_VERIFIED',
              `Your account shows rent of about ${usd(cashFlow.observedRentCents ?? 0)} a month. Without a payment history at the new amount we can front up to ${usd(limitCents)}, well below the ${usd(requested)} requested.`,
            )
          : binding === 'CAPACITY'
            ? reason(
                'INSUFFICIENT_CAPACITY',
                `Cash flow supports up to ${usd(limitCents)} of monthly rent, well below the ${usd(requested)} requested.`,
              )
            : reason(
                'EXPOSURE_LIMIT',
                `We can front up to ${usd(limitCents)} a month for a business at this stage, well below the ${usd(requested)} requested. The amount rises with on time rent periods.`,
              ),
      ]);
    }
    first = reason(
      'LIMIT_BELOW_REQUEST',
      binding === 'OBSERVED_RENT'
        ? `Approved for up to ${usd(limitCents)} a month, below the ${usd(requested)} requested, because your account shows rent of about ${usd(cashFlow.observedRentCents ?? 0)} a month.`
        : binding === 'CAPACITY' || !limit
          ? `Approved for up to ${usd(limitCents)} a month, below the ${usd(requested)} requested, to keep repayments inside your free cash flow.`
          : `Approved for up to ${usd(limitCents)} a month, below the ${usd(requested)} requested. The amount we front rises with on time rent periods.`,
      'INFO',
    );
  } else {
    first = reason(
      'APPROVED',
      `Grade ${card.grade} with a cash flow score of ${card.score}. Approved for up to ${usd(limitCents)} of monthly rent at a ${feePct(feeBps)} fee.`,
      'POSITIVE',
    );
  }
  const approvedReasons = [first, ...reasons];

  // Funding rules do not change the credit decision. They tell the applicant the plan may
  // have to wait; `createRentPlan` enforces them when the plan is opened.
  if (policy.exposure) {
    const funding = checkFunding(policy.exposure, Math.min(requested, limitCents), exposureContext);
    snapshot.funding = funding;
    if (!funding.ok) {
      approvedReasons.push(
        reason(
          'FUNDING_QUEUE',
          'Our capital pool is close to full, so the start of your plan may wait until capacity frees up.',
          'INFO',
        ),
      );
    }
  }

  snapshot.recommendation = {
    outcome: 'APPROVED',
    approvedMonthlyLimitCents: limitCents,
    feeBps,
  };
  const triggers = referTriggers(policy, {
    flags,
    score: card.score,
    limitCents,
    requestedCents: requested,
    firstPlan: exposureContext.onTimePeriods === 0 && exposureContext.businessCommittedCents === 0,
    approvalsPaused: input.controls?.approvalsPaused ?? false,
    veracityFindings: veracity?.findings ?? [],
  });
  if (triggers.length > 0) {
    snapshot.referTriggers = triggers;
    return finish('REFER', limitCents, feeBps, [
      reason(
        'IN_REVIEW',
        'Your application needs a look from our team before we can confirm terms. We will come back to you, and we will ask if we need anything.',
        'INFO',
      ),
      ...reasons,
    ]);
  }
  return finish('APPROVED', limitCents, feeBps, approvedReasons);
}

export interface ReferInput {
  flags: readonly IntegrityFlag[];
  score: number;
  limitCents: number;
  requestedCents: number;
  /** No plan yet and no on time history. */
  firstPlan: boolean;
  /** The circuit breaker on automatic approvals is tripped. */
  approvalsPaused?: boolean;
  veracityFindings?: readonly VeracityFinding[];
}

/**
 * Why an application that would otherwise be approved goes to a reviewer instead. Empty
 * means decide automatically. The trigger names are internal: they are stored on the
 * decision snapshot and shown in the review queue, never to the applicant.
 */
export function referTriggers(policy: CreditPolicy, input: ReferInput): string[] {
  return withControls(escalationTriggers(policy, input), input);
}

function escalationTriggers(policy: CreditPolicy, input: ReferInput): string[] {
  const triggers = flagsWithAction(input.flags, 'REFER').map((f) => `INTEGRITY:${f.code}`);
  for (const f of input.veracityFindings ?? []) {
    if (f.consequence === 'REFER' && !triggers.includes(`VERACITY:${f.code}`)) {
      triggers.push(`VERACITY:${f.code}`);
    }
  }
  const rules = policy.escalation;
  if (!rules) return triggers;
  if (input.score < policy.minScore + rules.scoreBandAboveCutoff)
    triggers.push('SCORE_NEAR_CUTOFF');
  if (input.limitCents > rules.referAmountCents) triggers.push('AMOUNT_ABOVE_THRESHOLD');
  if (
    input.firstPlan &&
    input.limitCents < input.requestedCents &&
    Math.round((input.limitCents * 10_000) / input.requestedCents) < rules.referCounterOfferBelowBps
  ) {
    triggers.push('COUNTER_OFFER_FIRST_PLAN');
  }
  return triggers;
}

/** Trigger recorded when the circuit breaker, not the application, caused the referral. */
export const CIRCUIT_BREAKER_TRIGGER = 'CIRCUIT_BREAKER';

function withControls(triggers: string[], input: ReferInput): string[] {
  // Independent of the escalation rules: a tripped breaker refers under any policy version.
  if (input.approvalsPaused) triggers.push(CIRCUIT_BREAKER_TRIGGER);
  return triggers;
}

/** Whether the primary platform may count toward verified revenue. True when not checked. */
function commerceTrusted(veracity: VeracityAssessment | null): boolean {
  if (!veracity) return true;
  const source = veracity.sources.find((s) => s.kind === 'COMMERCE');
  return source ? source.usableForRevenue : true;
}

/** A finding as a reason the owner may read: its own wording, never the rule. */
function veracityReason(
  f: VeracityFinding,
  impact: DecisionReason['impact'] = 'INFO',
): DecisionReason {
  const code =
    f.consequence === 'KNOCKOUT'
      ? f.code === 'HISTORY_REWRITTEN'
        ? 'ACCOUNT_HISTORY_NOT_VERIFIED'
        : 'ACCOUNT_OWNERSHIP_NOT_CONFIRMED'
      : f.customerAction === 'CONNECT_PAYOUT_ACCOUNT'
        ? 'PAYOUT_ACCOUNT_NOT_CONNECTED'
        : f.customerAction === 'RECONNECT'
          ? 'RECONNECT_REQUIRED'
          : 'CONNECTION_ACTION_NEEDED';
  return {
    code,
    message: f.customerMessage ?? 'We need more information about the accounts you connected.',
    impact,
  };
}

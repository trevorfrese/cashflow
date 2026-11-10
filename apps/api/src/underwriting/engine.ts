import type {
  BankTransaction,
  CashFlowSummary,
  CreditGrade,
  DecisionOutcome,
  DecisionReason,
  IsoDate,
} from '@cashflow/shared';
import { formatCents } from '@cashflow/shared';

import { computeCashFlowFeatures } from './features.ts';
import { scoreCashFlow } from './scorecard.ts';

/**
 * Cash flow based underwriting for rent advances.
 *
 * Order of operations:
 *   1. Missing data -> NEEDS_INFO. We never decline for information we have not received.
 *   2. Features from bank transactions, then a 0 to 100 score and letter grade.
 *   3. Hard policy rules -> DECLINED regardless of score.
 *   4. Capacity: the largest monthly rent the business can carry with a margin of safety,
 *      bounded by a share of verified revenue and by free cash flow coverage.
 *   5. Pricing by grade, and a suggested installment cadence from cash flow timing.
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
}

export interface EngineResult {
  outcome: DecisionOutcome;
  approvedMonthlyLimitCents: number | null;
  feeBps: number | null;
  score: number | null;
  grade: CreditGrade | null;
  recommendedInstallmentsPerMonth: number | null;
  reasons: DecisionReason[];
  cashFlow: CashFlowSummary | null;
}

/** All policy numbers in one place so the credit box is readable at a glance. */
export const POLICY = {
  /** Full months of bank history before we can score at all. */
  minMonthsOfHistory: 6,
  /** Months in business (self reported) below which we decline. */
  minTimeInBusinessMonths: 6,
  /** Verified monthly revenue floor. */
  minVerifiedRevenueCents: 500_000,
  /** Stated revenue more than this far above verified revenue needs explaining. 5000 bps = 50%. */
  maxStatedRevenueVarianceBps: 5000,
  /** Hard limits on conduct in the last 90 days. */
  maxNsf90: 2,
  maxNegativeBalanceDays90: 10,
  /** Hard limit on rent as a share of verified revenue. */
  maxRentToRevenueBps: 4000,
  /** Steepest revenue decline we will accept, last 3 months vs prior 3. */
  maxRevenueDeclineBps: -2500,
  /** Free cash flow must cover rent plus fee by this much. 125 = 1.25x. */
  minCoverageRatio: 125,
  /** Score below which we decline. */
  minScore: 45,
  /** Approve at a lower limit when capacity is at least this share of the request. */
  minCounterOfferBps: 5000,
  /** Limits are rounded down to this increment. */
  limitIncrementCents: 10_000,
  pricing: {
    A: { feeBps: 150, maxRentShareBps: 3000 },
    B: { feeBps: 200, maxRentShareBps: 2500 },
    C: { feeBps: 250, maxRentShareBps: 2000 },
    D: { feeBps: 300, maxRentShareBps: 1500 },
    F: { feeBps: 300, maxRentShareBps: 0 },
  } satisfies Record<CreditGrade, { feeBps: number; maxRentShareBps: number }>,
} as const;

function reason(
  code: string,
  message: string,
  impact: DecisionReason['impact'] = 'NEGATIVE',
): DecisionReason {
  return { code, message, impact };
}

function needsInfo(reasons: DecisionReason[], cashFlow: CashFlowSummary | null): EngineResult {
  return {
    outcome: 'NEEDS_INFO',
    approvedMonthlyLimitCents: null,
    feeBps: null,
    score: null,
    grade: null,
    recommendedInstallmentsPerMonth: null,
    reasons,
    cashFlow,
  };
}

/** Largest rent such that revenue share and coverage policies both hold, rounded down. */
export function capacityCents(s: CashFlowSummary, grade: CreditGrade): number {
  const pricing = POLICY.pricing[grade];
  const revenueCap = (s.verifiedMonthlyRevenueCents * pricing.maxRentShareBps) / 10_000;
  const freeCash = s.monthlyNetCashFlowCents + (s.observedRentCents ?? 0);
  const feeMultiplier = 1 + pricing.feeBps / 10_000;
  const coverageCap = freeCash / ((POLICY.minCoverageRatio / 100) * feeMultiplier);
  const raw = Math.min(revenueCap, coverageCap);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw / POLICY.limitIncrementCents) * POLICY.limitIncrementCents;
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

export function decide(input: EngineInput): EngineResult {
  if (!input.bankData) {
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

  const cashFlow = computeCashFlowFeatures({
    transactions: input.bankData.transactions,
    currentBalanceCents: input.bankData.currentBalanceCents,
    asOf: input.bankData.asOf,
    statedMonthlyRevenueCents: input.statedMonthlyRevenueCents,
    requestedMonthlyRentCents: input.requestedMonthlyRentCents,
  });

  if (cashFlow.monthsOfHistory < POLICY.minMonthsOfHistory) {
    return needsInfo(
      [
        reason(
          'INSUFFICIENT_HISTORY',
          `We found ${cashFlow.monthsOfHistory} month${cashFlow.monthsOfHistory === 1 ? '' : 's'} of transactions. Connect the account that has received your revenue for at least ${POLICY.minMonthsOfHistory} months.`,
          'INFO',
        ),
      ],
      cashFlow,
    );
  }
  if (cashFlow.statedRevenueVarianceBps > POLICY.maxStatedRevenueVarianceBps) {
    return needsInfo(
      [
        reason(
          'REVENUE_MISMATCH',
          `You stated ${formatCents(input.statedMonthlyRevenueCents, { showCents: false })} a month but we verified ${formatCents(cashFlow.verifiedMonthlyRevenueCents, { showCents: false })}. Connect any other accounts that receive revenue, or update the stated figure.`,
          'INFO',
        ),
      ],
      cashFlow,
    );
  }

  const card = scoreCashFlow(cashFlow);
  const reasons: DecisionReason[] = card.factors.map((f) => reason(f.code, f.message, f.impact));
  const knockouts: DecisionReason[] = [];

  if (input.timeInBusinessMonths < POLICY.minTimeInBusinessMonths) {
    knockouts.push(
      reason(
        'TIME_IN_BUSINESS',
        `We need at least ${POLICY.minTimeInBusinessMonths} months in business. You reported ${input.timeInBusinessMonths}.`,
      ),
    );
  }
  if (cashFlow.verifiedMonthlyRevenueCents < POLICY.minVerifiedRevenueCents) {
    knockouts.push(
      reason(
        'REVENUE_TOO_LOW',
        `Verified revenue of ${formatCents(cashFlow.verifiedMonthlyRevenueCents, { showCents: false })} a month is below our ${formatCents(POLICY.minVerifiedRevenueCents, { showCents: false })} minimum.`,
      ),
    );
  }
  if (cashFlow.nsfCount90 > POLICY.maxNsf90) {
    knockouts.push(
      reason(
        'EXCESSIVE_OVERDRAFTS',
        `${cashFlow.nsfCount90} overdraft fees in the last 90 days. We allow at most ${POLICY.maxNsf90}.`,
      ),
    );
  }
  if (cashFlow.negativeBalanceDays90 > POLICY.maxNegativeBalanceDays90) {
    knockouts.push(
      reason(
        'NEGATIVE_BALANCE_DAYS',
        `The account was overdrawn on ${cashFlow.negativeBalanceDays90} of the last 90 days.`,
      ),
    );
  }
  if (cashFlow.rentToRevenueBps > POLICY.maxRentToRevenueBps) {
    knockouts.push(
      reason(
        'RENT_EXCEEDS_REVENUE_SHARE',
        `Requested rent is ${(cashFlow.rentToRevenueBps / 100).toFixed(0)}% of verified revenue. Our maximum is ${POLICY.maxRentToRevenueBps / 100}%.`,
      ),
    );
  }
  if (cashFlow.monthsOfHistory >= 6 && cashFlow.revenueGrowthBps < POLICY.maxRevenueDeclineBps) {
    knockouts.push(
      reason(
        'REVENUE_DECLINING',
        `Revenue fell ${Math.abs(cashFlow.revenueGrowthBps / 100).toFixed(0)}% over the last three months compared with the prior three.`,
      ),
    );
  }
  const freeCashCents = cashFlow.monthlyNetCashFlowCents + (cashFlow.observedRentCents ?? 0);
  if (freeCashCents <= 0) {
    knockouts.push(
      reason(
        'NEGATIVE_FREE_CASH_FLOW',
        'After operating expenses, owner draws, and existing debt, the business is not generating free cash flow to fund rent repayments.',
      ),
    );
  }
  if (card.score < POLICY.minScore) {
    knockouts.push(
      reason(
        'SCORE_BELOW_MINIMUM',
        `Overall cash flow score of ${card.score} is below our minimum of ${POLICY.minScore}.`,
      ),
    );
  }

  const base = {
    score: card.score,
    grade: card.grade,
    cashFlow,
    recommendedInstallmentsPerMonth: recommendInstallments(cashFlow),
  };

  if (knockouts.length > 0) {
    return {
      ...base,
      outcome: 'DECLINED',
      approvedMonthlyLimitCents: null,
      feeBps: null,
      reasons: [...knockouts, ...reasons],
    };
  }

  const capacity = capacityCents(cashFlow, card.grade);
  const pricing = POLICY.pricing[card.grade];
  const requested = input.requestedMonthlyRentCents;

  if (capacity <= 0) {
    return {
      ...base,
      outcome: 'DECLINED',
      approvedMonthlyLimitCents: null,
      feeBps: null,
      reasons: [
        reason(
          'INSUFFICIENT_CAPACITY',
          'Free cash flow after expenses and debt does not leave room for a rent advance with a margin of safety.',
        ),
        ...reasons,
      ],
    };
  }

  if (capacity < requested) {
    const shareBps = Math.round((capacity * 10_000) / requested);
    if (shareBps < POLICY.minCounterOfferBps) {
      return {
        ...base,
        outcome: 'DECLINED',
        approvedMonthlyLimitCents: null,
        feeBps: null,
        reasons: [
          reason(
            'INSUFFICIENT_CAPACITY',
            `Cash flow supports up to ${formatCents(capacity, { showCents: false })} of monthly rent, well below the ${formatCents(requested, { showCents: false })} requested.`,
          ),
          ...reasons,
        ],
      };
    }
    return {
      ...base,
      outcome: 'APPROVED',
      approvedMonthlyLimitCents: capacity,
      feeBps: pricing.feeBps,
      reasons: [
        reason(
          'LIMIT_BELOW_REQUEST',
          `Approved for up to ${formatCents(capacity, { showCents: false })} a month, below the ${formatCents(requested, { showCents: false })} requested, to keep repayments inside your free cash flow.`,
          'INFO',
        ),
        ...reasons,
      ],
    };
  }

  return {
    ...base,
    outcome: 'APPROVED',
    approvedMonthlyLimitCents: capacity,
    feeBps: pricing.feeBps,
    reasons: [
      reason(
        'APPROVED',
        `Grade ${card.grade} with a cash flow score of ${card.score}. Approved for up to ${formatCents(capacity, { showCents: false })} of monthly rent at a ${(pricing.feeBps / 100).toFixed(pricing.feeBps % 100 === 0 ? 0 : 1)}% fee.`,
        'POSITIVE',
      ),
      ...reasons,
    ],
  };
}

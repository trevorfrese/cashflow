import type { DecisionOutcome, DecisionReason } from '@cashflow/shared';

export interface UnderwritingInput {
  statedMonthlyRevenueCents: number;
  timeInBusinessMonths: number;
  requestedMonthlyRentCents: number;
  /** Null when the applicant has not connected a bank account. */
  bankLink: { availableBalanceCents: number | null } | null;
}

export interface UnderwritingResult {
  outcome: DecisionOutcome;
  approvedMonthlyLimitCents: number | null;
  feeBps: number | null;
  reasons: DecisionReason[];
}

/**
 * Decides whether CashFlow will front rent for a business, and on what terms.
 * A real implementation might call a credit bureau, a cash flow underwriting vendor,
 * or an internal model. The mock is a transparent rules engine.
 */
export interface UnderwritingProvider {
  readonly name: string;
  decide(input: UnderwritingInput): Promise<UnderwritingResult>;
}

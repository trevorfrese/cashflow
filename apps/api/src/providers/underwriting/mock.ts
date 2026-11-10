import type { DecisionReason } from '@cashflow/shared';

import type { UnderwritingInput, UnderwritingProvider, UnderwritingResult } from './types.ts';

/** Rules are plain numbers so the policy is readable at a glance. */
export const MOCK_RULES = {
  /** Months in business before we will consider an application. */
  minTimeInBusinessMonths: 12,
  /** Rent may not exceed this share of stated monthly revenue. 2500 bps = 25%. */
  maxRentToRevenueBps: 2500,
  /** Connected bank balance must cover at least this share of one month's rent. 5000 bps = 50%. */
  minBalanceToRentBps: 5000,
  /** Approved limit is this share of stated revenue. */
  limitToRevenueBps: 2500,
  /** Fee tiers by time in business. */
  feeBpsByTenure: [
    { minMonths: 60, feeBps: 200 },
    { minMonths: 24, feeBps: 250 },
    { minMonths: 0, feeBps: 300 },
  ],
} as const;

export class MockUnderwritingProvider implements UnderwritingProvider {
  readonly name = 'mock';

  async decide(input: UnderwritingInput): Promise<UnderwritingResult> {
    return decideWithRules(input);
  }
}

export function decideWithRules(input: UnderwritingInput): UnderwritingResult {
  const reasons: DecisionReason[] = [];

  // Missing information comes first. We cannot decline someone for data they have not given us.
  if (!input.bankLink) {
    return {
      outcome: 'NEEDS_INFO',
      approvedMonthlyLimitCents: null,
      feeBps: null,
      reasons: [
        {
          code: 'BANK_LINK_REQUIRED',
          message: 'Connect your business bank account so we can verify revenue.',
        },
      ],
    };
  }

  if (input.timeInBusinessMonths < MOCK_RULES.minTimeInBusinessMonths) {
    reasons.push({
      code: 'TIME_IN_BUSINESS',
      message: `We need at least ${MOCK_RULES.minTimeInBusinessMonths} months of operating history.`,
    });
  }

  const rentToRevenueBps =
    input.statedMonthlyRevenueCents > 0
      ? Math.round((input.requestedMonthlyRentCents * 10_000) / input.statedMonthlyRevenueCents)
      : Number.POSITIVE_INFINITY;
  if (rentToRevenueBps > MOCK_RULES.maxRentToRevenueBps) {
    reasons.push({
      code: 'RENT_TO_REVENUE',
      message: 'Rent is too large a share of monthly revenue.',
    });
  }

  if (input.bankLink.availableBalanceCents !== null) {
    const minBalance = Math.round(
      (input.requestedMonthlyRentCents * MOCK_RULES.minBalanceToRentBps) / 10_000,
    );
    if (input.bankLink.availableBalanceCents < minBalance) {
      reasons.push({
        code: 'LOW_BALANCE',
        message: 'Current bank balance is low relative to the requested rent.',
      });
    }
  }

  if (reasons.length > 0) {
    return { outcome: 'DECLINED', approvedMonthlyLimitCents: null, feeBps: null, reasons };
  }

  const approvedMonthlyLimitCents = Math.floor(
    (input.statedMonthlyRevenueCents * MOCK_RULES.limitToRevenueBps) / 10_000,
  );
  const tier = MOCK_RULES.feeBpsByTenure.find((t) => input.timeInBusinessMonths >= t.minMonths);
  const feeBps = tier?.feeBps ?? 300;

  return {
    outcome: 'APPROVED',
    approvedMonthlyLimitCents,
    feeBps,
    reasons: [{ code: 'APPROVED', message: 'Approved based on operating history and revenue.' }],
  };
}

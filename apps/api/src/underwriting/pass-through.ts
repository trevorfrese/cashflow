import type { DecisionOutcome, DecisionReason } from '@cashflow/shared';

/**
 * Who is offered the free pass-through plan. Pure: reads a stored decision and nothing else.
 *
 * Only a business the engine declined for credit capacity: it could not carry the rent as a
 * financed plan, and nothing suggests the application was not what it said. A pass-through
 * plan carries no credit risk, because CashFlow collects the rent before it pays the
 * landlord, but it does move the business's money to a payee on the business's say so. So
 * anything that questions who the business is, whether its data is its own, or whether the
 * lease is real is excluded, and so is anything a reviewer decided (the engine's reasons are
 * then not the whole story) and anything referred, which is still waiting for a person.
 */

/** Decline reasons that are about capacity to carry the rent, not about trust. */
export const CREDIT_CAPACITY_DECLINE_CODES: ReadonlySet<string> = new Set([
  'TIME_IN_BUSINESS',
  'REVENUE_TOO_LOW',
  'EXCESSIVE_OVERDRAFTS',
  'NEGATIVE_BALANCE_DAYS',
  'RENT_EXCEEDS_REVENUE_SHARE',
  'REVENUE_DECLINING',
  'DECLINE_WITH_THIN_BUFFER',
  'NEGATIVE_FREE_CASH_FLOW',
  'SCORE_BELOW_MINIMUM',
  'INSUFFICIENT_CAPACITY',
  'FEE_ABOVE_MAXIMUM',
  'RENT_BELOW_MINIMUM',
  'EXPOSURE_LIMIT',
  'EXPOSURE_LIMIT_REACHED',
]);

/**
 * Decline reasons that rule pass-through out whatever else is on the decision: an integrity
 * or veracity knockout, an identity that could not be verified, a landlord account that is
 * the applicant's own, and a lease far above the rent the account shows.
 */
export const PASS_THROUGH_EXCLUDED_CODES: ReadonlySet<string> = new Set([
  'UNVERIFIED_DEPOSITS',
  'LANDLORD_ACCOUNT_MATCH',
  'IDENTITY_NOT_VERIFIED',
  'INTEGRITY_CHECK_FAILED',
  'ACCOUNT_HISTORY_NOT_VERIFIED',
  'ACCOUNT_OWNERSHIP_NOT_CONFIRMED',
  'RENT_NOT_VERIFIED',
]);

export type PassThroughIneligibleReason =
  /** Not a decline: approved, referred, or waiting for information. */
  | 'NOT_DECLINED'
  /** Decided by a reviewer. */
  | 'REVIEWED'
  /** A trust reason is on the decision. */
  | 'TRUST_DECLINE'
  /** No credit capacity reason on the decision. */
  | 'NO_CAPACITY_REASON';

export interface PassThroughEligibility {
  eligible: boolean;
  /** Why not, when not eligible. */
  reason: PassThroughIneligibleReason | null;
  /** The capacity reasons the decline was for. */
  capacityCodes: string[];
}

export interface DecisionFacts {
  outcome: DecisionOutcome;
  /** ENGINE, REVIEW, PERIODIC_REVIEW, ELIGIBILITY_REVIEW, GRADUATION. */
  kind: string;
  reasons: readonly Pick<DecisionReason, 'code' | 'impact'>[];
  /** Integrity flags and veracity findings with a KNOCKOUT action, from the snapshot. */
  knockouts: number;
}

export function passThroughEligibility(decision: DecisionFacts): PassThroughEligibility {
  const no = (reason: PassThroughIneligibleReason): PassThroughEligibility => ({
    eligible: false,
    reason,
    capacityCodes: [],
  });
  if (decision.outcome !== 'DECLINED') return no('NOT_DECLINED');
  if (decision.kind !== 'ENGINE') return no('REVIEWED');
  const negative = decision.reasons.filter((r) => r.impact === 'NEGATIVE').map((r) => r.code);
  if (decision.knockouts > 0 || negative.some((c) => PASS_THROUGH_EXCLUDED_CODES.has(c))) {
    return no('TRUST_DECLINE');
  }
  const capacityCodes = negative.filter((c) => CREDIT_CAPACITY_DECLINE_CODES.has(c));
  if (capacityCodes.length === 0) return no('NO_CAPACITY_REASON');
  return { eligible: true, reason: null, capacityCodes };
}

/** Knockouts recorded on a decision snapshot: integrity flags and veracity findings. */
export function snapshotKnockouts(snapshot: unknown): number {
  const s = (snapshot ?? {}) as {
    integrityFlags?: Array<{ action?: string }>;
    veracity?: { findings?: Array<{ consequence?: string }> } | null;
  };
  const flags = (s.integrityFlags ?? []).filter((f) => f.action === 'KNOCKOUT').length;
  const findings = (s.veracity?.findings ?? []).filter((f) => f.consequence === 'KNOCKOUT').length;
  return flags + findings;
}

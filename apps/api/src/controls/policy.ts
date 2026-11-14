/**
 * Operating controls that are not credit or servicing rules: how long a change to who gets
 * paid has to wait, how often parties are screened again, and how long records are kept.
 * One object, so the services, the jobs, and the monitoring rules read the same numbers.
 *
 * Where a number follows a regulation or a network rule it is a working assumption to be
 * confirmed by counsel, not a legal conclusion.
 */
export interface ControlsPolicy {
  /**
   * Days a change to a landlord's identity or payout account waits before it applies, on a
   * lease with a running plan.
   */
  leaseChangeCoolingOffDays: number;
  /** Days after which the business, its owners, and its landlords are screened again. */
  rescreenIntervalDays: number;
  /** Months a credit application and its decision records are kept at the least. */
  retentionMonths: number;
  /** Days from a complete application within which the applicant must have an answer. */
  decisionNoticeDays: number;
  /**
   * The largest monthly limit a reviewer may approve. An approval above it, at the engine's
   * terms or the reviewer's, needs an admin. Enforced in `services/reviews.ts`.
   */
  reviewerApprovalCeilingCents: number;
}

export const CONTROLS_POLICY: ControlsPolicy = {
  // Five days. An account takeover that redirects rent is found by the real owner or the
  // real landlord noticing: the owner is told at once and can cancel, and five days is long
  // enough for that to happen. It is also exactly the servicing policy's payout release
  // window (`payoutReleaseWindowDays`), so a payout that falls due on the day of an honest
  // change is held and then paid on the day the change applies, never cancelled.
  leaseChangeCoolingOffDays: 5,
  // Thirty days. Sanctions lists change daily and vendors offer continuous monitoring; a
  // monthly batch is the floor for a program without it, and it lines up with the monthly
  // rent cycle, so every party is screened between one payout and the next.
  rescreenIntervalDays: 30,
  // Twelve months is the Regulation B retention period for business credit applications
  // (25 months for consumer credit). Used as a floor: nothing in this repository deletes an
  // application or a decision, and monitoring alerts if one disappears inside the period.
  retentionMonths: 12,
  // Thirty days is the Regulation B deadline for notifying an applicant of action taken on
  // a completed application.
  decisionNoticeDays: 30,
  // $10,000 of monthly rent. It is the same line at which the engine stops approving on its
  // own (`referAmountCents` in the credit policy), so a reviewer's authority reaches exactly
  // as far as the engine's: a reviewer settles the flag or the score that referred a case,
  // and an amount the engine would not approve alone needs a second, more senior person.
  // In money: one month fronted at $10,000 with the policy's loss given default (about 60%
  // of a month) is roughly $6,000 lost if the plan goes bad, which is about 2.5% of the
  // sandbox pool's capital and inside the 5% single business cap. Above that, a single
  // approval starts to move the pool, and the person who answers for the pool should sign.
  // Kept as its own number, not read from the credit policy, so a credit policy change does
  // not quietly widen what one reviewer may approve.
  reviewerApprovalCeilingCents: 1_000_000,
};

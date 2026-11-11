import { daysBetween, type IsoDate } from '@cashflow/shared';

/**
 * Servicing rules as data plus a few pure functions over them.
 *
 * This module is the single description of how CashFlow behaves after a landlord payout:
 * when a missed installment counts as late, how often and how many times a failed debit is
 * retried, whether the next landlord payout goes out while earlier installments are unpaid,
 * and when an unpaid installment is written off. It has no database, clock, or provider
 * access, so the portfolio simulator in `src/evals/` can execute a policy exactly, and the
 * collection and payout services can ask the same questions of the same object.
 *
 * `BASELINE_SERVICING_POLICY` describes what the services do today. It is a description, not
 * a recommendation.
 */
export interface ServicingPolicy {
  /** Short name used in reports. */
  name: string;
  /** An unpaid installment is LATE once it is more than this many days past its due date. */
  lateGraceDays: number;
  retry: {
    /** Days between collection attempts on an unpaid installment. 1 is every day. */
    intervalDays: number;
    /** Most attempts per installment, counting the first. Null means no cap. */
    maxAttempts: number | null;
  };
  /**
   * Hold the next landlord payout while the oldest unpaid installment is more than this many
   * days past due. 0 holds as soon as anything is a day overdue. Null never holds.
   */
  holdPayoutPastDueDays: number | null;
  /**
   * Write an installment off once it is this many days past due, and close the plan: a
   * written off plan gets no further landlord payouts. Null never writes off.
   */
  chargeOffAfterDays: number | null;
  /** Share of a written off balance expected back from later recovery work, in basis points. */
  recoveryRateBps: number;
}

/**
 * Today's behavior, read from `services/collections.ts` and `services/payouts.ts`: a failed
 * debit is retried every day without limit, it is marked LATE once more than three days past
 * due, the next month's payout goes out regardless of unpaid installments, and nothing is
 * ever written off. No recovery process exists; the rate is the evaluation assumption for
 * what a basic one would return on a balance that is 90 days past due.
 */
export const BASELINE_SERVICING_POLICY: ServicingPolicy = {
  name: 'baseline',
  lateGraceDays: 3,
  retry: { intervalDays: 1, maxAttempts: null },
  holdPayoutPastDueDays: null,
  chargeOffAfterDays: null,
  recoveryRateBps: 1000,
};

/** Whole days an obligation due on `dueDate` is overdue on `asOf`. Never negative. */
export function daysPastDue(dueDate: IsoDate, asOf: IsoDate): number {
  return Math.max(0, daysBetween(dueDate, asOf));
}

/** Same test the collection service applies: late once past the grace period. */
export function isLate(policy: ServicingPolicy, dueDate: IsoDate, asOf: IsoDate): boolean {
  return daysPastDue(dueDate, asOf) > policy.lateGraceDays;
}

export interface AttemptState {
  dueDate: IsoDate;
  /** Collection attempts made so far. */
  attempts: number;
  /** Date of the most recent attempt, if any. */
  lastAttemptDate: IsoDate | null;
}

/** Should a collection attempt be made on `asOf` for an unpaid installment in this state. */
export function shouldAttemptCollection(
  policy: ServicingPolicy,
  state: AttemptState,
  asOf: IsoDate,
): boolean {
  if (state.dueDate > asOf) return false;
  if (policy.retry.maxAttempts !== null && state.attempts >= policy.retry.maxAttempts) return false;
  if (state.lastAttemptDate === null) return true;
  return daysBetween(state.lastAttemptDate, asOf) >= policy.retry.intervalDays;
}

/**
 * Should a landlord payout due on `asOf` be held, given the due date of the oldest unpaid
 * installment from earlier periods (null when nothing is unpaid).
 */
export function shouldHoldPayout(
  policy: ServicingPolicy,
  oldestUnpaidDueDate: IsoDate | null,
  asOf: IsoDate,
): boolean {
  if (policy.holdPayoutPastDueDays === null || oldestUnpaidDueDate === null) return false;
  return daysPastDue(oldestUnpaidDueDate, asOf) > policy.holdPayoutPastDueDays;
}

/** Should an unpaid installment be written off on `asOf`. */
export function shouldChargeOff(policy: ServicingPolicy, dueDate: IsoDate, asOf: IsoDate): boolean {
  return (
    policy.chargeOffAfterDays !== null && daysPastDue(dueDate, asOf) >= policy.chargeOffAfterDays
  );
}

/** Expected recovery on a written off principal balance, in cents. */
export function expectedRecoveryCents(policy: ServicingPolicy, chargedOffCents: number): number {
  return Math.round((chargedOffCents * policy.recoveryRateBps) / 10_000);
}

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
 * a recommendation. `STANDARD_SERVICING_POLICY` is the policy the services are being moved to
 * (Phase R3) and the one the credit policy is evaluated under.
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

/**
 * The servicing policy that ships with credit policy version 2. The portfolio evals gate on
 * it. The collection and payout services do not implement it yet: that is Phase R3.
 *
 *   - Late after 3 days of grace, as today.
 *   - Hold the next landlord payout while anything is more than 3 days past due. This is the
 *     rule that bounds a loss at one rent period: Phase R1 measured net loss falling from
 *     310 to 34 basis points of volume from this change alone, with identical decisions.
 *   - Three collection attempts per installment: the first on the due date and two retries,
 *     three days apart (days 0, 3, and 6). Three is the ACH network's limit for
 *     re-presenting a debit returned for insufficient funds (the original entry plus two
 *     reinitiations). Three days is about as soon as a retry can know the previous one
 *     was returned, since returns take up to two banking days, and it puts the second
 *     attempt on the last day of grace, so a business that was short by a day or two cures
 *     before it is marked late or has a payout held. Retrying daily without limit, as the
 *     baseline does, collects almost nothing more (measured: 31 against 35 basis points of
 *     net loss on the same book) and would breach the network rule on a real rail. After
 *     the third return nothing more is debited automatically: the balance waits for a
 *     manual payment, which the evals conservatively assume never comes.
 *   - Charge off at 90 days past due and close the plan.
 *   - Recovery as in the baseline.
 */
export const STANDARD_SERVICING_POLICY: ServicingPolicy = {
  name: 'standard',
  lateGraceDays: 3,
  retry: { intervalDays: 3, maxAttempts: 3 },
  holdPayoutPastDueDays: 3,
  chargeOffAfterDays: 90,
  recoveryRateBps: BASELINE_SERVICING_POLICY.recoveryRateBps,
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

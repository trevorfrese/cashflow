import { addDays, daysBetween, type IsoDate } from '@cashflow/shared';

/**
 * Servicing rules as data plus pure functions over them.
 *
 * This module is the single description of how CashFlow behaves after a landlord payout:
 * when a missed installment counts as late, which delinquency bucket a plan is in, how often
 * and how many times a failed debit is retried, whether the next landlord payout goes out
 * while earlier installments are unpaid and what happens to a payout that was held, how a
 * returned payment is classified, how much is reserved against each bucket, and when an
 * unpaid balance is written off. It has no database, clock, or provider access, so the
 * portfolio simulator in `src/evals/` executes a policy exactly, and the collection, payout,
 * aging, reconciliation, and provisioning services ask the same questions of the same object.
 *
 * `ACTIVE_SERVICING_POLICY` is what the services run. It is `STANDARD_SERVICING_POLICY`, the
 * policy the credit policy is evaluated under. `BASELINE_SERVICING_POLICY` describes how the
 * services behaved before Phase R3 and is kept so the evals can show what servicing bought.
 */

/** Where a plan stands, from the age of its oldest unpaid installment. */
export const DELINQUENCY_BUCKETS = [
  'CURRENT',
  'GRACE',
  'DELINQUENT',
  'DEFAULT',
  'CHARGED_OFF',
] as const;
export type DelinquencyBucket = (typeof DELINQUENCY_BUCKETS)[number];
/** The buckets a balance that is still on the books can be in. */
export type OpenBucket = Exclude<DelinquencyBucket, 'CHARGED_OFF'>;
export const OPEN_BUCKETS: readonly OpenBucket[] = ['CURRENT', 'GRACE', 'DELINQUENT', 'DEFAULT'];

export interface ServicingPolicy {
  /** Short name used in reports. */
  name: string;
  /**
   * An unpaid installment is LATE once it is more than this many days past its due date.
   * Days 1 to `lateGraceDays` past due are the GRACE bucket.
   */
  lateGraceDays: number;
  /**
   * A plan is in DEFAULT once its oldest unpaid installment is this many days past due.
   * From the end of grace up to the day before, it is DELINQUENT.
   */
  defaultAfterDays: number;
  retry: {
    /** Days between collection attempts on an unpaid installment. 1 is every day. */
    intervalDays: number;
    /** Most attempts per installment, counting the first. Null means no cap. */
    maxAttempts: number | null;
    /**
     * Read the account balance before a scheduled debit and put the debit off for a day when
     * the balance cannot cover it. A debit that is put off is not an attempt: it does not
     * count toward `maxAttempts`.
     */
    balancePreCheck: boolean;
  };
  /**
   * Hold the next landlord payout while the oldest unpaid installment is more than this many
   * days past due. 0 holds as soon as anything is a day overdue. Null never holds.
   */
  holdPayoutPastDueDays: number | null;
  /**
   * A landlord payout that has not gone out (held, or failed) may still be paid up to this
   * many days after its scheduled date, once nothing holds it. After that it is cancelled
   * and its installments are voided: by then the tenant has had to settle that month with
   * the landlord directly, and paying it late would pay the landlord twice. Null never
   * cancels: an unpaid payout waits for as long as it takes.
   */
  payoutReleaseWindowDays: number | null;
  /**
   * Write the plan's unpaid balance off once its oldest unpaid installment is this many days
   * past due, and close the plan: a written off plan gets no further landlord payouts. Null
   * never writes off.
   */
  chargeOffAfterDays: number | null;
  /** Share of a written off balance expected back from later recovery work, in basis points. */
  recoveryRateBps: number;
  /**
   * Allowance for credit losses: the share of outstanding principal reserved, by the bucket
   * of the plan that owes it, in basis points.
   */
  provisionRatesBps: Record<OpenBucket, number>;
}

/**
 * The first reserve rates, read off the portfolio evaluation under credit policy v2 (Phase
 * R3): CURRENT 0.36%, GRACE 84.5%, DELINQUENT 94.3%, DEFAULT 99.8% roll to charge-off, rounded
 * up with no further margin. Kept for the baseline servicing policy, which documents history.
 * By the version 4 report the CURRENT roll rate (0.42%) had passed its 0.40% reserve.
 */
const PROVISION_RATES_BPS_R3: Record<OpenBucket, number> = {
  CURRENT: 40,
  GRACE: 8500,
  DELINQUENT: 9500,
  DEFAULT: 10_000,
};

/**
 * Reserve rates by bucket, set with credit policy v5 from the default portfolio evaluation
 * (five seeds of 2,000 applicants, standard servicing; "Roll to charge-off by bucket" in
 * `apps/api/evals/report.md`). The roll rate of a bucket is the share of the principal seen in
 * it that was later written off, measured two ways: on the evening of the first of a month,
 * when the provision job runs, and as a plan enters the bucket. The rule:
 *
 *   reserve rate = the higher of the two pooled roll rates, plus a margin of a quarter of it,
 *                  rounded up to 5 bps, and never above 100% (`reserveRateFor`).
 *
 *   Bucket       Measured (first of month / on entry)   Highest single seed   Reserve
 *   CURRENT      0.42% / 0.44%                          0.48%                 0.55%
 *   GRACE        n/a   / 79.47%                         94.29%                99.35%
 *   DELINQUENT   92.59% / 86.57%                        100%                  100%
 *   DEFAULT      99.38% / 98.58%                        100%                  100%
 *
 * The margin is there so the allowance is never below the loss the evaluation measured, on the
 * pooled book or on any single seed. Rates are gross of recoveries, which are income only when
 * cash arrives. The steep step from CURRENT to GRACE is a property of the simulated businesses,
 * where an owner covers a short account from savings until the business fails, so an
 * installment that goes unpaid at all usually belongs to a business that has closed. Real
 * borrowers cure from grace far more often. These rates have to be re-measured on real roll
 * rates before they mean anything. Re-measured on every policy version: a reserve below the
 * measured roll rate is a finding.
 */
export const RESERVE_MARGIN_BPS = 2500;
const PROVISION_RATES_BPS: Record<OpenBucket, number> = {
  CURRENT: 55,
  GRACE: 9935,
  DELINQUENT: 10_000,
  DEFAULT: 10_000,
};

/**
 * The reserve rate for a measured roll rate under the rule above: the rate plus
 * `RESERVE_MARGIN_BPS` of it, rounded up to 5 bps, at most 100%. Pure; the evaluation report
 * uses it to show whether each bucket is covered.
 */
export function reserveRateFor(measuredRollBps: number): number {
  const withMargin = (measuredRollBps * (10_000 + RESERVE_MARGIN_BPS)) / 10_000;
  return Math.min(10_000, Math.ceil(withMargin / 5) * 5);
}

/**
 * How the services behaved before Phase R3: a failed debit was retried every day without
 * limit, it was marked LATE once more than three days past due, the next month's payout went
 * out regardless of unpaid installments (and waited indefinitely when the pool was short), and
 * nothing was ever written off. No recovery
 * process existed; the rate is the evaluation assumption for what a basic one would return
 * on a balance that is 90 days past due. Kept for the evals' comparison configurations.
 */
export const BASELINE_SERVICING_POLICY: ServicingPolicy = {
  name: 'baseline',
  lateGraceDays: 3,
  defaultAfterDays: 30,
  retry: { intervalDays: 1, maxAttempts: null, balancePreCheck: false },
  holdPayoutPastDueDays: null,
  payoutReleaseWindowDays: null,
  chargeOffAfterDays: null,
  recoveryRateBps: 1000,
  provisionRatesBps: PROVISION_RATES_BPS_R3,
};

/**
 * The servicing policy the services implement and the portfolio evals gate on.
 *
 *   - Late after 3 days of grace. Buckets: CURRENT (nothing past due), GRACE (1 to 3 days),
 *     DELINQUENT (4 to 29), DEFAULT (30 and over), CHARGED_OFF (90).
 *   - Hold the next landlord payout while anything is more than 3 days past due. This is the
 *     rule that bounds a loss at one rent period: Phase R1 measured net loss falling from
 *     310 to 34 basis points of volume from this change alone, with identical decisions.
 *   - A held payout is released and paid if the business cures within 5 days of the payout's
 *     scheduled date. After that it is cancelled, not paid late. Five days is a common grace
 *     period in a commercial lease before a late fee or a default notice, so it is about as
 *     long as a landlord can be kept waiting without cost to the tenant.
 *   - Three collection attempts per installment: the first on the due date and two retries,
 *     three days apart (days 0, 3, and 6). Three is the ACH network's limit for
 *     re-presenting a debit returned for insufficient funds (the original entry plus two
 *     reinitiations). Three days is about as soon as a retry can know the previous one
 *     was returned, since returns take up to two banking days, and it puts the second
 *     attempt on the last day of grace, so a business that was short by a day or two cures
 *     before it is marked late or has a payout held.
 *   - Before each scheduled debit the account balance is read. A debit the balance cannot
 *     cover is put off to the next day and does not use up an attempt, so the three attempts
 *     are spent only on debits that had a chance. After the third failed or returned debit
 *     nothing more is debited automatically: the balance waits for a manual payment.
 *   - Charge off at 90 days past due and close the plan.
 *   - Recovery as in the baseline.
 *   - Reserve by bucket at the measured roll rate plus a margin (`PROVISION_RATES_BPS`).
 */
export const STANDARD_SERVICING_POLICY: ServicingPolicy = {
  name: 'standard',
  lateGraceDays: 3,
  defaultAfterDays: 30,
  retry: { intervalDays: 3, maxAttempts: 3, balancePreCheck: true },
  holdPayoutPastDueDays: 3,
  payoutReleaseWindowDays: 5,
  chargeOffAfterDays: 90,
  recoveryRateBps: BASELINE_SERVICING_POLICY.recoveryRateBps,
  provisionRatesBps: PROVISION_RATES_BPS,
};

/** The policy the collection, payout, aging, and provisioning services run. */
export const ACTIVE_SERVICING_POLICY: ServicingPolicy = STANDARD_SERVICING_POLICY;

/** Whole days an obligation due on `dueDate` is overdue on `asOf`. Never negative. */
export function daysPastDue(dueDate: IsoDate, asOf: IsoDate): number {
  return Math.max(0, daysBetween(dueDate, asOf));
}

/** Late once past the grace period. */
export function isLate(policy: ServicingPolicy, dueDate: IsoDate, asOf: IsoDate): boolean {
  return daysPastDue(dueDate, asOf) > policy.lateGraceDays;
}

/**
 * The bucket for a plan whose oldest unpaid installment is `days` past due. A plan that has
 * been written off stays CHARGED_OFF whatever is paid later.
 */
export function delinquencyBucket(
  policy: ServicingPolicy,
  days: number,
  chargedOff = false,
): DelinquencyBucket {
  if (chargedOff) return 'CHARGED_OFF';
  if (days <= 0) return 'CURRENT';
  if (days <= policy.lateGraceDays) return 'GRACE';
  if (days < policy.defaultAfterDays) return 'DELINQUENT';
  return 'DEFAULT';
}

export interface AttemptState {
  dueDate: IsoDate;
  /** Collection attempts made so far. A debit put off by the balance check is not one. */
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
  if (attemptsExhausted(policy, state.attempts)) return false;
  if (state.lastAttemptDate === null) return true;
  return daysBetween(state.lastAttemptDate, asOf) >= policy.retry.intervalDays;
}

/** No automatic debit is left for an installment that has had this many attempts. */
export function attemptsExhausted(policy: ServicingPolicy, attempts: number): boolean {
  return policy.retry.maxAttempts !== null && attempts >= policy.retry.maxAttempts;
}

/**
 * The balance check before a debit. False means the debit would obviously fail and is put
 * off without counting as an attempt. An unknown balance (no reading, or a policy without
 * the check) never blocks a debit.
 */
export function balanceCoversDebit(
  policy: ServicingPolicy,
  balanceCents: number | null,
  amountCents: number,
): boolean {
  if (!policy.retry.balancePreCheck || balanceCents === null) return true;
  return balanceCents >= amountCents;
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

export type PayoutAction = 'wait' | 'pay' | 'hold' | 'cancel';

/**
 * What to do on `asOf` with a landlord payout that has not been paid. `held` says whether
 * anything holds it today: a past due balance, a frozen plan, a pause. Inside the release
 * window a payout is held while something holds it and paid as soon as nothing does. Past
 * the window it is cancelled either way: the month has been settled without us.
 */
export function payoutAction(
  policy: ServicingPolicy,
  scheduledFor: IsoDate,
  held: boolean,
  asOf: IsoDate,
): PayoutAction {
  if (scheduledFor > asOf) return 'wait';
  if (
    policy.payoutReleaseWindowDays !== null &&
    asOf > addDays(scheduledFor, policy.payoutReleaseWindowDays)
  ) {
    return 'cancel';
  }
  return held ? 'hold' : 'pay';
}

/** Should a plan whose oldest unpaid installment was due on `dueDate` be written off on `asOf`. */
export function shouldChargeOff(policy: ServicingPolicy, dueDate: IsoDate, asOf: IsoDate): boolean {
  return (
    policy.chargeOffAfterDays !== null && daysPastDue(dueDate, asOf) >= policy.chargeOffAfterDays
  );
}

/** Expected recovery on a written off principal balance, in cents. */
export function expectedRecoveryCents(policy: ServicingPolicy, chargedOffCents: number): number {
  return Math.round((chargedOffCents * policy.recoveryRateBps) / 10_000);
}

/** Allowance to hold against `principalCents` owed by a plan in `bucket`. */
export function reserveCents(
  policy: ServicingPolicy,
  bucket: OpenBucket,
  principalCents: number,
): number {
  return Math.round((Math.max(0, principalCents) * policy.provisionRatesBps[bucket]) / 10_000);
}

/** The allowance the policy calls for on a book with this much principal in each bucket. */
export function requiredAllowanceCents(
  policy: ServicingPolicy,
  principalByBucket: Partial<Record<OpenBucket, number>>,
): number {
  return OPEN_BUCKETS.reduce(
    (sum, bucket) => sum + reserveCents(policy, bucket, principalByBucket[bucket] ?? 0),
    0,
  );
}

/**
 * ACH return codes, grouped by what the servicer must do next.
 *
 *   RETRYABLE     The account is good and the money was not there: R01 insufficient funds,
 *                 R09 uncollected funds. The entry may be presented again, up to the retry cap.
 *   HARD          The account or the entry cannot work: closed, not found, invalid, frozen,
 *                 not a transaction account, payment stopped. No further automatic debit;
 *                 the business has to link a bank account again.
 *   UNAUTHORIZED  The account holder told their bank they did not authorize the debit: R05,
 *                 R07, R10, R29. No further debit, the plan is frozen from further advances,
 *                 and a high severity audit event is written. The network caps unauthorized
 *                 returns at 0.5% of debits, so each one is investigated.
 *
 * A code this table does not know is treated as HARD: stopping debits is the safe mistake.
 */
export type ReturnClass = 'RETRYABLE' | 'HARD' | 'UNAUTHORIZED';

export const RETURN_CODES: Readonly<Record<string, { class: ReturnClass; reason: string }>> = {
  R01: { class: 'RETRYABLE', reason: 'Insufficient funds' },
  R09: { class: 'RETRYABLE', reason: 'Uncollected funds' },
  R02: { class: 'HARD', reason: 'Account closed' },
  R03: { class: 'HARD', reason: 'No account or unable to locate account' },
  R04: { class: 'HARD', reason: 'Invalid account number' },
  R08: { class: 'HARD', reason: 'Payment stopped' },
  R13: { class: 'HARD', reason: 'Invalid routing number' },
  R16: { class: 'HARD', reason: 'Account frozen' },
  R20: { class: 'HARD', reason: 'Not a transaction account' },
  R05: { class: 'UNAUTHORIZED', reason: 'Unauthorized debit to a consumer account' },
  R07: { class: 'UNAUTHORIZED', reason: 'Authorization revoked by customer' },
  R10: { class: 'UNAUTHORIZED', reason: 'Customer advises originator is not authorized' },
  R29: { class: 'UNAUTHORIZED', reason: 'Corporate customer advises not authorized' },
};

export function classifyReturnCode(code: string): ReturnClass {
  return RETURN_CODES[code.toUpperCase()]?.class ?? 'HARD';
}

export function returnCodeReason(code: string): string {
  return RETURN_CODES[code.toUpperCase()]?.reason ?? 'Returned by the bank';
}

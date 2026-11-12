import { addDays, parseIsoDate, type IsoDate } from '@cashflow/shared';

/**
 * Pass-through servicing as data plus pure functions, the same way `policy.ts` holds the
 * financed plan's rules. No database, clock, or provider: the pass-through service and the
 * portfolio simulator ask the same questions of the same object.
 *
 * A pass-through plan is free. CashFlow debits the business for the whole month's rent a few
 * business days before the due date, waits until that debit is past the window in which an
 * insufficient funds return can come back, and only then pays the landlord. It never pays the
 * landlord with its own money. A month in which nothing could be collected in time is
 * missed: CashFlow does not pay the landlord, and the owner is told to pay directly.
 */
export interface PassThroughPolicy {
  /** Short name used in reports. */
  name: string;
  /** The first debit is made this many business days before the rent due date. */
  collectionLeadBusinessDays: number;
  /**
   * A debit is treated as settled this many business days after it was made. It has to be
   * longer than the return window for insufficient funds (two banking days on ACH, and
   * `MOCK_RETURN_DAYS` in the sandbox), so a debit that bounces does so before the landlord
   * is paid. An unauthorized return can still arrive weeks later; see
   * `RETURNED_AFTER_PAYOUT` in `src/services/pass-through.ts`.
   */
  settlementBusinessDays: number;
  /** Debits presented per month at most, counting the first. */
  maxCollectionAttempts: number;
  /**
   * Read the balance before a scheduled debit and put it off a day when it cannot cover the
   * rent. A debit put off is not an attempt.
   */
  balancePreCheck: boolean;
  /**
   * A settled month whose landlord payout is held (a landlord change in its cooling-off
   * period, a frozen plan) may still be paid this many days after the due date. After that
   * the money goes back to the business, which pays its landlord directly.
   */
  payoutReleaseWindowDays: number;
}

export const STANDARD_PASS_THROUGH_POLICY: PassThroughPolicy = {
  name: 'pass-through-standard',
  collectionLeadBusinessDays: 5,
  settlementBusinessDays: 3,
  maxCollectionAttempts: 2,
  balancePreCheck: true,
  payoutReleaseWindowDays: 5,
};

export const ACTIVE_PASS_THROUGH_POLICY: PassThroughPolicy = STANDARD_PASS_THROUGH_POLICY;

/** 0 is Sunday, 6 is Saturday. */
function weekday(date: IsoDate): number {
  const { year, month, day } = parseIsoDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isBusinessDay(date: IsoDate): boolean {
  const d = weekday(date);
  return d !== 0 && d !== 6;
}

/**
 * `n` business days after `date` (before it when `n` is negative). Weekends only: bank
 * holidays are not modeled, which shortens the real window by a day around a holiday.
 */
export function addBusinessDays(date: IsoDate, n: number): IsoDate {
  let current = date;
  let left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    current = addDays(current, step);
    if (isBusinessDay(current)) left -= 1;
  }
  return current;
}

export interface PassThroughSchedule {
  /** First day the rent is debited. */
  collectOn: IsoDate;
  /** Last day a debit can be made and still settle by the due date. */
  lastCollectOn: IsoDate;
}

/** The due date, or the last business day before it when it falls on a weekend. */
export function lastBusinessDayOnOrBefore(date: IsoDate): IsoDate {
  let current = date;
  while (!isBusinessDay(current)) current = addDays(current, -1);
  return current;
}

/**
 * When a month is collected. Counted back from the last business day on or before the due
 * date, so a debit made on `lastCollectOn` settles by the due date even when the due date is
 * a weekend.
 */
export function passThroughSchedule(
  policy: PassThroughPolicy,
  dueDate: IsoDate,
): PassThroughSchedule {
  const anchor = lastBusinessDayOnOrBefore(dueDate);
  return {
    collectOn: addBusinessDays(anchor, -policy.collectionLeadBusinessDays),
    lastCollectOn: addBusinessDays(anchor, -policy.settlementBusinessDays),
  };
}

/** The date a debit made on `collectedOn` is treated as settled. */
export function settlesOn(policy: PassThroughPolicy, collectedOn: IsoDate): IsoDate {
  return addBusinessDays(collectedOn, policy.settlementBusinessDays);
}

export interface CollectionState {
  collectOn: IsoDate;
  lastCollectOn: IsoDate;
  attempts: number;
  /** The last date a debit was presented, if any. */
  lastAttemptOn: IsoDate | null;
}

export type CollectionAction =
  /** Not yet time, or already tried today. */
  | 'wait'
  /** Debit today (after the balance check, when the policy has one). */
  | 'attempt'
  /** Too late to collect and settle before the due date, or out of attempts: the month is missed. */
  | 'miss';

/** What to do about a month that has not been collected yet. */
export function collectionAction(
  policy: PassThroughPolicy,
  state: CollectionState,
  asOf: IsoDate,
): CollectionAction {
  if (asOf < state.collectOn) return 'wait';
  if (asOf > state.lastCollectOn) return 'miss';
  if (state.attempts >= policy.maxCollectionAttempts) return 'miss';
  if (state.lastAttemptOn === asOf) return 'wait';
  return 'attempt';
}

/** The balance check: a debit goes ahead when the balance covers it, or could not be read. */
export function passThroughBalanceCovers(
  policy: PassThroughPolicy,
  balanceCents: number | null,
  amountCents: number,
): boolean {
  if (!policy.balancePreCheck || balanceCents === null) return true;
  return balanceCents >= amountCents;
}

export type PassThroughPayoutAction =
  /** Not settled yet, or before the due date. */
  | 'wait'
  /** Settled, due, and nothing holds it. */
  | 'pay'
  /** Settled and due, but held. Paid when the hold clears, inside the window. */
  | 'hold'
  /** Held past the release window: the money goes back to the business. */
  | 'refund';

/**
 * What to do with a settled month's landlord payout. The landlord is paid on the due date,
 * never before, and never from anything but the settled collection.
 */
export function passThroughPayoutAction(
  policy: PassThroughPolicy,
  input: { dueDate: IsoDate; settled: boolean; held: boolean },
  asOf: IsoDate,
): PassThroughPayoutAction {
  if (!input.settled || asOf < input.dueDate) return 'wait';
  if (!input.held) return 'pay';
  return asOf > addDays(input.dueDate, policy.payoutReleaseWindowDays) ? 'refund' : 'hold';
}

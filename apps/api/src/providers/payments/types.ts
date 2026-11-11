import type { IsoDate } from '@cashflow/shared';

/**
 * The outcome of asking the rail to move money. `ok: true` means the entry was accepted, not
 * that it is final: a bank debit can be accepted today and come back days or weeks later. A
 * later return is reported by `listReturns`, never by changing this result. `returnCode` on
 * a failure is the bank's code when the rail rejected the entry with one.
 */
export type PaymentResult =
  | { ok: true; providerRef: string }
  | { ok: false; providerRef: string | null; failureReason: string; returnCode?: string };

export interface PayoutInput {
  amountCents: number;
  /** Lease.landlordPayoutToken */
  destinationToken: string;
  idempotencyKey: string;
  description: string;
  /** The calendar date the payment is made on. The job's as-of date, so replays are dated. */
  effectiveDate: IsoDate;
}

export interface ChargeInput {
  amountCents: number;
  /** BankLink.providerAccountToken */
  sourceToken: string;
  idempotencyKey: string;
  description: string;
  effectiveDate: IsoDate;
}

/** A payment the rail accepted earlier and the bank has since sent back. */
export interface PaymentReturn {
  /** The `providerRef` the original `charge` or `payout` returned. */
  providerRef: string;
  kind: 'charge' | 'payout';
  amountCents: number;
  /** ACH return code, for example R01. Classified in `src/servicing/policy.ts`. */
  returnCode: string;
  reason: string;
  /** The calendar date the return arrived. */
  returnedOn: IsoDate;
}

export interface ReturnsQuery {
  /** Returns that arrived on or after this date. */
  from: IsoDate;
  /** And on or before this one. */
  to: IsoDate;
}

/**
 * Moves money: payouts to landlords and debits from businesses.
 * Shaped after Stripe (Transfers or Payouts for landlords, PaymentIntents with ACH for debits).
 * Every call is idempotent by key so a retried job never double pays.
 *
 * There are no webhooks. Returns are found by polling `listReturns`, which the
 * `reconcile-payments` job does every day over a window long enough to catch a late
 * unauthorized return. Asking twice for the same window returns the same returns: the
 * caller is the one that remembers which it has already handled.
 */
export interface PaymentsProvider {
  readonly name: string;
  payout(input: PayoutInput): Promise<PaymentResult>;
  charge(input: ChargeInput): Promise<PaymentResult>;
  listReturns(query: ReturnsQuery): Promise<PaymentReturn[]>;
}

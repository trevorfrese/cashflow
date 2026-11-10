export type PaymentResult =
  | { ok: true; providerRef: string }
  | { ok: false; providerRef: string | null; failureReason: string };

export interface PayoutInput {
  amountCents: number;
  /** Lease.landlordPayoutToken */
  destinationToken: string;
  idempotencyKey: string;
  description: string;
}

export interface ChargeInput {
  amountCents: number;
  /** BankLink.providerAccountToken */
  sourceToken: string;
  idempotencyKey: string;
  description: string;
}

/**
 * Moves money: payouts to landlords and debits from businesses.
 * Shaped after Stripe (Transfers or Payouts for landlords, PaymentIntents with ACH for debits).
 * Every call is idempotent by key so a retried job never double pays.
 */
export interface PaymentsProvider {
  readonly name: string;
  payout(input: PayoutInput): Promise<PaymentResult>;
  charge(input: ChargeInput): Promise<PaymentResult>;
}

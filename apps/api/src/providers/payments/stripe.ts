import type { Config } from '../../config.ts';
import type { ChargeInput, PaymentResult, PaymentsProvider, PayoutInput } from './types.ts';

/**
 * Skeleton for a Stripe test mode adapter. Compiles against the interface, carries no SDK
 * dependency, and refuses to run without a test key. A real implementation would:
 *
 *   pnpm --filter @cashflow/api add stripe
 *   payout -> stripe.transfers.create({ amount, currency: 'usd', destination: connectedAccountId }, { idempotencyKey })
 *             where each landlord is onboarded as a Connect account and destinationToken holds its id,
 *             or stripe.payouts.create for a bank account attached to your platform.
 *   charge -> stripe.paymentIntents.create({ amount, currency: 'usd', payment_method: usBankAccountPm,
 *             payment_method_types: ['us_bank_account'], confirm: true, customer }, { idempotencyKey })
 *             where sourceToken is the us_bank_account PaymentMethod (created from a Plaid processor token).
 *
 * Settlement is asynchronous for ACH, so a production version also needs a webhook handler that
 * flips Installment and LandlordPayout rows from PROCESSING to PAID or FAILED.
 */
export class StripePaymentsProvider implements PaymentsProvider {
  readonly name = 'stripe';

  constructor(config: Config) {
    if (!config.STRIPE_SECRET_KEY) {
      throw new Error('PAYMENTS_PROVIDER=stripe requires STRIPE_SECRET_KEY');
    }
    if (!config.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
      throw new Error(
        'This project only supports Stripe test mode keys (sk_test_...). It never moves real money.',
      );
    }
  }

  async payout(_input: PayoutInput): Promise<PaymentResult> {
    throw new Error(
      'StripePaymentsProvider.payout is not implemented. See the notes in stripe.ts.',
    );
  }

  async charge(_input: ChargeInput): Promise<PaymentResult> {
    throw new Error(
      'StripePaymentsProvider.charge is not implemented. See the notes in stripe.ts.',
    );
  }
}

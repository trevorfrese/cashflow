import type { Config } from '../../config.ts';
import type {
  ChargeInput,
  PaymentResult,
  PaymentReturn,
  PaymentsProvider,
  PayoutInput,
  ReturnsQuery,
} from './types.ts';

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
 *   listReturns -> stripe.events.list({ types: ['payment_intent.payment_failed', 'payout.failed',
 *             'charge.dispute.created'], created: { gte, lte } }), mapping the ACH return code on
 *             the failure to `returnCode`. ACH debits settle asynchronously, so a return can
 *             arrive after the payment was booked: the reconcile-payments job polls this and
 *             reverses the booking.
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

  async listReturns(_query: ReturnsQuery): Promise<PaymentReturn[]> {
    throw new Error(
      'StripePaymentsProvider.listReturns is not implemented. See the notes in stripe.ts.',
    );
  }
}

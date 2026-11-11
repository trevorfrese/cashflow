import type { Config } from '../../config.ts';
import { SkeletonCommerceProvider } from './skeleton.ts';

/**
 * Skeleton for a Stripe adapter: reading a merchant's own Stripe account through Stripe
 * Connect OAuth with the read_only scope. Compile only and NOT EXERCISED. This is unrelated
 * to the Stripe payments skeleton in providers/payments, which would move CashFlow's money.
 *
 *   authorizationUrl   https://connect.stripe.com/oauth/authorize?response_type=code
 *                      &client_id={STRIPE_CONNECT_CLIENT_ID}&scope=read_only&state
 *                      (Stripe's OAuth for Standard accounts has no PKCE; state is checked)
 *   exchangeCode       POST https://connect.stripe.com/oauth/token -> stripe_user_id,
 *                      access_token, refresh_token. Calls then use Stripe-Account: stripe_user_id.
 *   refresh            POST /oauth/token grant_type=refresh_token
 *   revoke             POST https://connect.stripe.com/oauth/deauthorize (client_id, stripe_user_id)
 *   getAccountIdentity GET /v1/account: business_profile.name, company.name, company.tax_id
 *                      provided flag (not the number), country, created
 *   getPayoutDestinations GET /v1/accounts/{id}/external_accounts: bank_name, last4
 *   getDailySales      GET /v1/balance_transactions (type=charge, refund) summed per day
 *   getPayouts         GET /v1/payouts: id, arrival_date, amount, destination (bank account id)
 *                      and GET /v1/balance_transactions?payout= for what each one contains
 *
 * Sandbox setup: a Connect platform in test mode, the OAuth redirect URI registered, a test
 * connected account, STRIPE_CONNECT_CLIENT_ID, COMMERCE_PROVIDER=stripe, CONNECTION_TOKEN_KEY.
 */
export class StripeCommerceDataProvider extends SkeletonCommerceProvider {
  readonly name = 'stripe';
  protected readonly platform = 'STRIPE' as const;

  constructor(config: Config) {
    super(config, { STRIPE_CONNECT_CLIENT_ID: config.STRIPE_CONNECT_CLIENT_ID });
  }
}

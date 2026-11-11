import type { Config } from '../../config.ts';
import { SkeletonCommerceProvider } from './skeleton.ts';

/**
 * Skeleton for a Square sandbox adapter. Compile only and NOT EXERCISED: it refuses to run
 * without sandbox credentials and CONNECTION_TOKEN_KEY, and every call throws. What a real
 * implementation calls (Square API, version pinned with the Square-Version header):
 *
 *   authorizationUrl   GET https://connect.squareupsandbox.com/oauth2/authorize
 *                      ?client_id&scope=MERCHANT_PROFILE_READ+PAYMENTS_READ+ORDERS_READ+PAYOUTS_READ+BANK_ACCOUNTS_READ
 *                      &session=false&state&code_challenge (PKCE is supported for the code flow)
 *                      Read-only scopes only. Never PAYMENTS_WRITE or anything that moves money.
 *   exchangeCode       POST /oauth2/token grant_type=authorization_code, code, code_verifier
 *                      -> access_token (30 days), refresh_token, merchant_id, expires_at
 *   refresh            POST /oauth2/token grant_type=refresh_token. Refresh before expires_at.
 *   revoke             POST /oauth2/revoke (client_id, access_token)
 *   getAccountIdentity GET /v2/merchants/me: business_name, country, created_at; the legal
 *                      name and EIN last four are not on the merchant object and need the
 *                      locations' business_name or a partnership data agreement. Treat as null.
 *   getPayoutDestinations GET /v2/bank-accounts: holder name, bank name, account_number_suffix
 *   getDailySales      POST /v2/orders/search by closed_at, or GET /v2/payments, summed per
 *                      day with GET /v2/refunds netted; disputes from GET /v2/disputes
 *   getPayouts         GET /v2/payouts (begin_time, end_time): id, arrival_date, amount_money,
 *                      destination { type: BANK_ACCOUNT, id }. GET /v2/payouts/{id}/payout-entries
 *                      itemizes fees, refunds, and holds inside one payout.
 *
 * Sandbox setup: create an application at developer.squareup.com, use its sandbox application
 * id and secret, register the redirect URI (OAUTH_REDIRECT_URI), and create a sandbox seller
 * test account in the developer dashboard. Set COMMERCE_PROVIDER=square, SQUARE_ENV=sandbox,
 * SQUARE_APPLICATION_ID, SQUARE_APPLICATION_SECRET and CONNECTION_TOKEN_KEY.
 *
 * Only ever read. CashFlow never charges or pays out through a commerce platform.
 */
export class SquareCommerceDataProvider extends SkeletonCommerceProvider {
  readonly name = 'square';
  protected readonly platform = 'SQUARE' as const;

  constructor(config: Config) {
    super(config, {
      SQUARE_APPLICATION_ID: config.SQUARE_APPLICATION_ID,
      SQUARE_APPLICATION_SECRET: config.SQUARE_APPLICATION_SECRET,
    });
    if (config.SQUARE_ENV !== 'sandbox') {
      throw new Error('This project only supports SQUARE_ENV=sandbox. It never reads live sales.');
    }
  }
}

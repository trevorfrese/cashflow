import type { Config } from '../../config.ts';
import { SkeletonCommerceProvider } from './skeleton.ts';

/**
 * Skeleton for a Clover adapter. Compile only and NOT EXERCISED.
 *
 *   authorizationUrl   https://sandbox.dev.clover.com/oauth/v2/authorize?client_id
 *                      &redirect_uri&state&code_challenge&code_challenge_method=S256
 *                      Permissions are set on the app, read only: MERCHANT_R, ORDERS_R, PAYMENTS_R.
 *   exchangeCode       POST /oauth/v2/token (client_id, code, code_verifier) -> access_token,
 *                      refresh_token, access_token_expiration (expiring tokens)
 *   refresh            POST /oauth/v2/refresh
 *   revoke             The merchant uninstalls the app; CashFlow deletes its tokens
 *   getAccountIdentity GET /v3/merchants/{mId}?expand=owner,address: name, createdTime
 *   getPayoutDestinations Not in the public REST API for every region: treat as unknown (null)
 *                      unless the partner program grants the funding data endpoints
 *   getDailySales      GET /v3/merchants/{mId}/payments and /refunds, summed per day
 *   getPayouts         Clover deposits are reported in the merchant's funding statements; the
 *                      public API exposes them only through partner programs. Without it,
 *                      reconciliation falls back to sales against deposits.
 *
 * Sandbox setup: a Clover developer account, a sandbox test merchant, an app with the read
 * permissions above, CLOVER_APP_ID, CLOVER_APP_SECRET, CLOVER_ENV=sandbox,
 * COMMERCE_PROVIDER=clover, CONNECTION_TOKEN_KEY.
 */
export class CloverCommerceDataProvider extends SkeletonCommerceProvider {
  readonly name = 'clover';
  protected readonly platform = 'CLOVER' as const;

  constructor(config: Config) {
    super(config, {
      CLOVER_APP_ID: config.CLOVER_APP_ID,
      CLOVER_APP_SECRET: config.CLOVER_APP_SECRET,
    });
    if (config.CLOVER_ENV !== 'sandbox') {
      throw new Error('This project only supports CLOVER_ENV=sandbox.');
    }
  }
}

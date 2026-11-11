import type { Config } from '../../config.ts';
import { SkeletonCommerceProvider } from './skeleton.ts';

/**
 * Skeleton for a Shopify adapter. Compile only and NOT EXERCISED. What a real one calls:
 *
 *   authorizationUrl   https://{shop}.myshopify.com/admin/oauth/authorize?client_id
 *                      &scope=read_orders,read_shopify_payments_payouts,read_shopify_payments_accounts
 *                      &redirect_uri&state (Shopify's code flow has no PKCE: the state nonce
 *                      and the HMAC on the callback are checked instead). The owner names the
 *                      shop domain first. Read scopes only.
 *   exchangeCode       POST https://{shop}.myshopify.com/admin/oauth/access_token -> an
 *                      offline access token (does not expire), or an expiring online token
 *   refresh            Offline tokens do not expire; expiring tokens refresh with refresh_token
 *   revoke             The app is uninstalled (the app/uninstalled webhook confirms it)
 *   getAccountIdentity GraphQL Admin API `shop { name, billingAddress, createdAt }` and
 *                      `shopifyPaymentsAccount { country }`
 *   getPayoutDestinations `shopifyPaymentsAccount { bankAccounts { bankName, accountNumberLastDigits } }`
 *   getDailySales      `orders(query: "processed_at:>=")` with totals and refunds, summed per day
 *   getPayouts         `shopifyPaymentsAccount { payouts { issuedAt, net, status, bankAccount } }`
 *                      and balance transactions for the fees and adjustments in each payout
 *
 * Sandbox setup: a Partner account, a development store with Shopify Payments in test mode, a
 * custom app with the scopes above, and SHOPIFY_API_KEY, SHOPIFY_API_SECRET,
 * COMMERCE_PROVIDER=shopify, CONNECTION_TOKEN_KEY.
 */
export class ShopifyCommerceDataProvider extends SkeletonCommerceProvider {
  readonly name = 'shopify';
  protected readonly platform = 'SHOPIFY' as const;

  constructor(config: Config) {
    super(config, {
      SHOPIFY_API_KEY: config.SHOPIFY_API_KEY,
      SHOPIFY_API_SECRET: config.SHOPIFY_API_SECRET,
    });
  }
}

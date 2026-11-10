import type { CommercePlatform, DailySales } from '@cashflow/shared';

import type { Config } from '../../config.ts';
import type { CommerceDataProvider, LinkedCommerceAccount, SalesRange } from './types.ts';

/**
 * Skeleton for a Square sandbox adapter. It compiles against the interface and documents
 * the calls a real implementation makes, but carries no SDK dependency and refuses to run
 * without sandbox credentials. The same shape fits Toast, Shopify, Clover, and Stripe: an
 * OAuth connect, a merchant or shop id, and a daily sales report.
 *
 *   pnpm --filter @cashflow/api add square
 *   createLinkToken     -> build the OAuth authorize URL with MERCHANT_PROFILE_READ and PAYMENTS_READ
 *   exchangePublicToken -> oauth.obtainToken({ code }) then merchants.retrieve and locations.list
 *   getDailySales       -> orders.search by closed_at range, or payments.list, summed per day,
 *                          with refunds.list and disputes.list netted against gross
 *
 * Only ever read sales. CashFlow never charges or pays out through a commerce platform.
 */
export class SquareCommerceDataProvider implements CommerceDataProvider {
  readonly name = 'square';

  constructor(config: Config) {
    if (!config.SQUARE_APPLICATION_ID || !config.SQUARE_APPLICATION_SECRET) {
      throw new Error(
        'COMMERCE_PROVIDER=square requires SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET',
      );
    }
    if (config.SQUARE_ENV !== 'sandbox') {
      throw new Error('This project only supports SQUARE_ENV=sandbox. It never reads live sales.');
    }
  }

  async createLinkToken(
    _businessId: string,
    _platform: CommercePlatform,
  ): Promise<{ linkToken: string }> {
    throw new Error(
      'SquareCommerceDataProvider.createLinkToken is not implemented. See the notes in square.ts.',
    );
  }

  async exchangePublicToken(
    _publicToken: string,
    _platform: CommercePlatform,
  ): Promise<LinkedCommerceAccount> {
    throw new Error(
      'SquareCommerceDataProvider.exchangePublicToken is not implemented. See the notes in square.ts.',
    );
  }

  async getDailySales(_providerItemId: string, _range: SalesRange): Promise<DailySales[]> {
    throw new Error(
      'SquareCommerceDataProvider.getDailySales is not implemented. See the notes in square.ts.',
    );
  }
}

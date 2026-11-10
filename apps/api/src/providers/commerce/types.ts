import type { CommercePlatform, DailySales, IsoDate } from '@cashflow/shared';

export interface LinkedCommerceAccount {
  /** Provider's id for the connection (a Square merchant id, a Shopify shop domain). */
  providerItemId: string;
  platform: CommercePlatform;
  locationName: string;
  /** When the business started selling on the platform. */
  connectedSince: IsoDate;
}

export interface SalesRange {
  from: IsoDate;
  to: IsoDate;
}

/**
 * Reads sales from a point of sale or commerce platform for underwriting. Shaped like an
 * OAuth connect flow: create a link token, the client completes the platform's consent
 * screen, exchange the resulting code for a durable connection, then pull daily sales by
 * item id. Read only. CashFlow never moves money through a commerce platform.
 */
export interface CommerceDataProvider {
  readonly name: string;
  createLinkToken(businessId: string, platform: CommercePlatform): Promise<{ linkToken: string }>;
  exchangePublicToken(
    publicToken: string,
    platform: CommercePlatform,
  ): Promise<LinkedCommerceAccount>;
  /** One row per calendar day with sales, oldest first. Days with no sales are omitted. */
  getDailySales(providerItemId: string, range: SalesRange): Promise<DailySales[]>;
}

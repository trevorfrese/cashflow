import { createHash } from 'node:crypto';

import type { CommercePlatform, DailySales } from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS } from '@cashflow/shared';

import { todayIso } from '../../dates.ts';
import {
  decodeCommerceItemId,
  encodeCommerceItemId,
  generateSales,
  parseCommerceScenario,
} from './synthetic.ts';
import type { CommerceDataProvider, LinkedCommerceAccount, SalesRange } from './types.ts';

const LOCATIONS = ['Main Street', 'Downtown', 'Harbor District', 'Northside', 'Online store'];

/**
 * Deterministic fake point of sale. The public token picks the scenario and the sales
 * level with the same keywords as the sandbox bank (see bank-link/synthetic.ts), plus
 * `sales_<dollars>` to pin monthly gross sales and a platform name to override the one
 * requested. A token containing `fail` makes the exchange fail.
 */
export class MockCommerceDataProvider implements CommerceDataProvider {
  readonly name = 'mock';

  constructor(private readonly clock: () => string = todayIso) {}

  async createLinkToken(
    businessId: string,
    platform: CommercePlatform,
  ): Promise<{ linkToken: string }> {
    return { linkToken: `mock_pos_link_${platform.toLowerCase()}_${businessId}` };
  }

  async exchangePublicToken(
    publicToken: string,
    platform: CommercePlatform,
  ): Promise<LinkedCommerceAccount> {
    if (publicToken.includes('fail')) {
      throw new Error('Mock commerce link failure requested by token');
    }
    const digest = createHash('sha256').update(`pos:${publicToken}`).digest();
    const seedHex = digest.subarray(8, 14).toString('hex');
    const spec = parseCommerceScenario(publicToken, platform);
    const { connectedSince } = generateSales(spec, seedHex, this.clock());
    const location = LOCATIONS[digest[0]! % LOCATIONS.length]!;
    return {
      providerItemId: encodeCommerceItemId(spec, seedHex),
      platform: spec.platform,
      locationName: `${COMMERCE_PLATFORM_LABELS[spec.platform]} · ${location}`,
      connectedSince,
    };
  }

  async getDailySales(providerItemId: string, range: SalesRange): Promise<DailySales[]> {
    const { spec, seedHex } = decodeCommerceItemId(providerItemId);
    const { dailySales } = generateSales(spec, seedHex, this.clock());
    return dailySales.filter((d) => d.date >= range.from && d.date <= range.to);
  }
}

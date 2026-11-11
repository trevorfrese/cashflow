import type {
  CommercePlatform,
  ConnectionAccessMethod,
  DailySales,
  PayoutDestination,
  PlatformPayout,
} from '@cashflow/shared';

import type { Config } from '../../config.ts';
import { CloverCommerceDataProvider } from './clover.ts';
import { MockCommerceDataProvider } from './mock.ts';
import { ShopifyCommerceDataProvider } from './shopify.ts';
import { SquareCommerceDataProvider } from './square.ts';
import { StripeCommerceDataProvider } from './stripe.ts';
import type {
  CommerceCredentials,
  CommerceDataProvider,
  LinkedCommerceAccount,
  OAuthGrant,
  PlatformAccountIdentity,
  SalesRange,
  SandboxBank,
  SandboxMerchant,
} from './types.ts';

export type {
  CommerceCredentials,
  CommerceDataProvider,
  LinkedCommerceAccount,
  OAuthGrant,
  PlatformAccountIdentity,
  SandboxBank,
  SandboxMerchant,
} from './types.ts';
export { TokenRefreshError } from './types.ts';

/**
 * Every platform through one object. Each platform is served by its own adapter: the sandbox
 * by default, or the real adapter that `COMMERCE_PROVIDER` names for its platform.
 */
export class CommerceRouter implements CommerceDataProvider {
  readonly name: string;
  private readonly adapters = new Map<CommercePlatform, CommerceDataProvider>();

  constructor(
    private readonly fallback: CommerceDataProvider,
    real: { platform: CommercePlatform; adapter: CommerceDataProvider } | null = null,
  ) {
    this.name = real ? real.adapter.name : fallback.name;
    if (real) this.adapters.set(real.platform, real.adapter);
  }

  adapter(platform: CommercePlatform): CommerceDataProvider {
    return this.adapters.get(platform) ?? this.fallback;
  }

  /** The provider name stored on a link for the platform. */
  nameFor(platform: CommercePlatform): string {
    return this.adapter(platform).name;
  }

  accessMethod(platform: CommercePlatform): ConnectionAccessMethod {
    return this.adapter(platform).accessMethod(platform);
  }
  readOnlyScopes(platform: CommercePlatform): string[] {
    return this.adapter(platform).readOnlyScopes(platform);
  }
  authorizationUrl(input: Parameters<CommerceDataProvider['authorizationUrl']>[0]) {
    return this.adapter(input.platform).authorizationUrl(input);
  }
  exchangeCode(input: Parameters<CommerceDataProvider['exchangeCode']>[0]): Promise<OAuthGrant> {
    return this.adapter(input.platform).exchangeCode(input);
  }
  refresh(platform: CommercePlatform, refreshToken: string): Promise<OAuthGrant> {
    return this.adapter(platform).refresh(platform, refreshToken);
  }
  revoke(c: CommerceCredentials): Promise<void> {
    return this.adapter(c.platform).revoke(c);
  }
  getAccountIdentity(c: CommerceCredentials): Promise<PlatformAccountIdentity> {
    return this.adapter(c.platform).getAccountIdentity(c);
  }
  getPayoutDestinations(
    c: CommerceCredentials,
    sandbox?: SandboxBank | null,
  ): Promise<PayoutDestination[]> {
    return this.adapter(c.platform).getPayoutDestinations(c, sandbox);
  }
  getDailySales(c: CommerceCredentials, range: SalesRange): Promise<DailySales[]> {
    return this.adapter(c.platform).getDailySales(c, range);
  }
  getPayouts(
    c: CommerceCredentials,
    range: SalesRange,
    sandbox?: SandboxBank | null,
  ): Promise<PlatformPayout[]> {
    return this.adapter(c.platform).getPayouts(c, range, sandbox);
  }
  createLinkToken(businessId: string, platform: CommercePlatform) {
    return this.adapter(platform).createLinkToken(businessId, platform);
  }
  exchangePublicToken(
    publicToken: string,
    platform: CommercePlatform,
    sandbox?: SandboxMerchant,
  ): Promise<LinkedCommerceAccount & { grant: OAuthGrant }> {
    return this.adapter(platform).exchangePublicToken(publicToken, platform, sandbox);
  }
}

export function createCommerceDataProvider(config: Config): CommerceRouter {
  const mock = new MockCommerceDataProvider();
  switch (config.COMMERCE_PROVIDER) {
    case 'square':
      return new CommerceRouter(mock, {
        platform: 'SQUARE',
        adapter: new SquareCommerceDataProvider(config),
      });
    case 'shopify':
      return new CommerceRouter(mock, {
        platform: 'SHOPIFY',
        adapter: new ShopifyCommerceDataProvider(config),
      });
    case 'stripe':
      return new CommerceRouter(mock, {
        platform: 'STRIPE',
        adapter: new StripeCommerceDataProvider(config),
      });
    case 'clover':
      return new CommerceRouter(mock, {
        platform: 'CLOVER',
        adapter: new CloverCommerceDataProvider(config),
      });
    case 'mock':
    default:
      return new CommerceRouter(mock);
  }
}

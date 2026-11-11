import type {
  CommercePlatform,
  ConnectionAccessMethod,
  DailySales,
  PayoutDestination,
  PlatformPayout,
} from '@cashflow/shared';

import type { Config } from '../../config.ts';
import { READ_ONLY_SCOPES } from './mock.ts';
import type {
  CommerceCredentials,
  CommerceDataProvider,
  LinkedCommerceAccount,
  OAuthGrant,
  PlatformAccountIdentity,
  SalesRange,
} from './types.ts';

/**
 * The shared shape of the real platform adapters. Each one is compile-only: it checks its
 * configuration in the constructor (sandbox credentials, the token encryption key) and every
 * call throws until someone implements it against the platform's sandbox. NOT EXERCISED.
 */
export abstract class SkeletonCommerceProvider implements CommerceDataProvider {
  abstract readonly name: string;
  protected abstract readonly platform: CommercePlatform;

  protected constructor(config: Config, required: Record<string, string | undefined>) {
    const missing = Object.entries(required)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) {
      throw new Error(`This commerce adapter requires ${missing.join(' and ')}`);
    }
    if (!config.CONNECTION_TOKEN_KEY) {
      throw new Error('A real commerce adapter requires CONNECTION_TOKEN_KEY');
    }
  }

  protected notImplemented(method: string): Error {
    return new Error(
      `${this.constructor.name}.${method} is not implemented. See the notes in providers/commerce/${this.name}.ts.`,
    );
  }

  accessMethod(_platform: CommercePlatform): ConnectionAccessMethod {
    return 'DIRECT_OAUTH';
  }

  readOnlyScopes(platform: CommercePlatform): string[] {
    return READ_ONLY_SCOPES[platform];
  }

  authorizationUrl(_input: {
    platform: CommercePlatform;
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): { url: string; scopes: string[]; sandbox: boolean } {
    throw this.notImplemented('authorizationUrl');
  }

  async exchangeCode(_input: {
    platform: CommercePlatform;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthGrant> {
    throw this.notImplemented('exchangeCode');
  }

  async refresh(_platform: CommercePlatform, _refreshToken: string): Promise<OAuthGrant> {
    throw this.notImplemented('refresh');
  }

  async revoke(_credentials: CommerceCredentials): Promise<void> {
    throw this.notImplemented('revoke');
  }

  async getAccountIdentity(_credentials: CommerceCredentials): Promise<PlatformAccountIdentity> {
    throw this.notImplemented('getAccountIdentity');
  }

  async getPayoutDestinations(_credentials: CommerceCredentials): Promise<PayoutDestination[]> {
    throw this.notImplemented('getPayoutDestinations');
  }

  async getDailySales(
    _credentials: CommerceCredentials,
    _range: SalesRange,
  ): Promise<DailySales[]> {
    throw this.notImplemented('getDailySales');
  }

  async getPayouts(
    _credentials: CommerceCredentials,
    _range: SalesRange,
  ): Promise<PlatformPayout[]> {
    throw this.notImplemented('getPayouts');
  }

  async createLinkToken(
    _businessId: string,
    _platform: CommercePlatform,
  ): Promise<{ linkToken: string }> {
    throw this.notImplemented('createLinkToken');
  }

  async exchangePublicToken(
    _publicToken: string,
    _platform: CommercePlatform,
  ): Promise<LinkedCommerceAccount & { grant: OAuthGrant }> {
    throw this.notImplemented('exchangePublicToken');
  }
}

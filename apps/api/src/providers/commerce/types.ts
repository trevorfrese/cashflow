import type {
  BankTransaction,
  CommercePlatform,
  ConnectionAccessMethod,
  DailySales,
  IsoDate,
  PayoutDestination,
  PlatformPayout,
} from '@cashflow/shared';

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

/** A platform-issued grant. Tokens are encrypted before they are stored. */
export interface OAuthGrant {
  providerItemId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  /** The read-only scopes the merchant actually granted. */
  scopes: string[];
}

export interface CommerceCredentials {
  platform: CommercePlatform;
  providerItemId: string;
  /** Decrypted for the call and dropped. Null on links made before tokens were stored. */
  accessToken: string | null;
}

/** The merchant account as the platform reports it. Never what the applicant typed. */
export interface PlatformAccountIdentity {
  legalName: string | null;
  platformAccountId: string | null;
  country: string | null;
  accountCreatedOn: IsoDate | null;
  taxIdLast4: string | null;
  locationName: string;
}

/**
 * Only the sandbox reads this. The mock platform has no real merchant, so it is told who the
 * business is when the owner "approves" on the mock consent page, and which sandbox bank
 * account it pays into, so that the two sandbox generators tell one story. A real adapter
 * ignores it.
 */
export interface SandboxMerchant {
  legalName?: string;
  ownerName?: string;
  taxIdLast4?: string | null;
}

export interface SandboxBank {
  /** Card settlement deposits in the business's connected sandbox bank, oldest first. */
  transactions: BankTransaction[];
  accountMask: string;
  institutionName: string;
}

export class TokenRefreshError extends Error {
  constructor(message = 'The platform refused to refresh the token') {
    super(message);
    this.name = 'TokenRefreshError';
  }
}

/**
 * Reads sales and settlements from a point of sale or commerce platform through a direct,
 * read-only OAuth connection: CashFlow sends the owner to the platform's consent screen with a
 * state and (where supported) a PKCE challenge, exchanges the code for tokens, refreshes them
 * before they expire, and revokes them on disconnect. Read only. CashFlow never moves money
 * through a commerce platform.
 */
export interface CommerceDataProvider {
  readonly name: string;
  /** How data for the platform is obtained by this deployment. */
  accessMethod(platform: CommercePlatform): ConnectionAccessMethod;
  readOnlyScopes(platform: CommercePlatform): string[];
  /** The URL the owner is sent to. `sandbox` is true for CashFlow's own mock consent page. */
  authorizationUrl(input: {
    platform: CommercePlatform;
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): { url: string; scopes: string[]; sandbox: boolean };
  exchangeCode(input: {
    platform: CommercePlatform;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthGrant>;
  refresh(platform: CommercePlatform, refreshToken: string): Promise<OAuthGrant>;
  revoke(credentials: CommerceCredentials): Promise<void>;
  getAccountIdentity(credentials: CommerceCredentials): Promise<PlatformAccountIdentity>;
  getPayoutDestinations(
    credentials: CommerceCredentials,
    sandbox?: SandboxBank | null,
  ): Promise<PayoutDestination[]>;
  /** One row per calendar day with sales, oldest first. Days with no sales are omitted. */
  getDailySales(credentials: CommerceCredentials, range: SalesRange): Promise<DailySales[]>;
  /** Settlement batches paid out in the range, oldest first. */
  getPayouts(
    credentials: CommerceCredentials,
    range: SalesRange,
    sandbox?: SandboxBank | null,
  ): Promise<PlatformPayout[]>;

  // The original sandbox shortcut, kept for `POST /v1/commerce-links`.
  createLinkToken(businessId: string, platform: CommercePlatform): Promise<{ linkToken: string }>;
  exchangePublicToken(
    publicToken: string,
    platform: CommercePlatform,
    sandbox?: SandboxMerchant,
  ): Promise<LinkedCommerceAccount & { grant: OAuthGrant }>;
}

import { createHash } from 'node:crypto';

import type {
  CommercePlatform,
  ConnectionAccessMethod,
  DailySales,
  PayoutDestination,
  PlatformPayout,
} from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS, addDays } from '@cashflow/shared';

import { todayIso } from '../../dates.ts';
import {
  decodeCommerceItemId,
  encodeCommerceItemId,
  generateSales,
  generateSalesAt,
  parseCommerceFlags,
  parseCommerceScenario,
  type DecodedCommerceItem,
} from './synthetic.ts';
import {
  TokenRefreshError,
  type CommerceCredentials,
  type CommerceDataProvider,
  type LinkedCommerceAccount,
  type OAuthGrant,
  type PlatformAccountIdentity,
  type SalesRange,
  type SandboxBank,
  type SandboxMerchant,
} from './types.ts';

const LOCATIONS = ['Main Street', 'Downtown', 'Harbor District', 'Northside', 'Online store'];

/** The business the `owner_mismatch` keyword's platform account belongs to. */
export const OTHER_MERCHANT = 'Harlow Ventures LLC';
/** Where `payout_elsewhere` pays: an account no sandbox bank token produces. */
export const ELSEWHERE_DESTINATION: PayoutDestination = {
  institutionName: 'Harbor Credit Union',
  mask: '0731',
  ref: 'mock_ba_elsewhere',
};

/** Read-only scopes each platform's real consent screen would ask for. */
export const READ_ONLY_SCOPES: Record<CommercePlatform, string[]> = {
  SQUARE: [
    'MERCHANT_PROFILE_READ',
    'PAYMENTS_READ',
    'ORDERS_READ',
    'PAYOUTS_READ',
    'BANK_ACCOUNTS_READ',
  ],
  SHOPIFY: ['read_orders', 'read_shopify_payments_payouts', 'read_shopify_payments_accounts'],
  STRIPE: ['read_only'],
  CLOVER: ['MERCHANT_R', 'ORDERS_R', 'PAYMENTS_R'],
  // Toast has no self-serve API: a read-only seat instead of scopes.
  TOAST: [],
};

export const methodFor = (platform: CommercePlatform): ConnectionAccessMethod =>
  platform === 'TOAST' ? 'DELEGATED_SEAT' : 'DIRECT_OAUTH';

const b64json = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
const unb64json = <T>(s: string): T =>
  JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as T;

/** PKCE S256: base64url(sha256(verifier)). */
export const codeChallengeFor = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

interface MockCode {
  platform: CommercePlatform;
  scenario: string;
  merchant: SandboxMerchant;
  challenge: string | null;
}

interface MockToken {
  item: string;
  merchant: SandboxMerchant;
  gen: number;
}

/**
 * The code the sandbox consent page hands back, as a real platform would on its redirect. It
 * carries the scenario keywords and the PKCE challenge the authorization started with, so the
 * exchange can check the verifier.
 */
export function mockAuthorizationCode(code: MockCode): string {
  return `mock_code.${b64json(code)}`;
}

/**
 * Deterministic fake point of sale. Scenario keywords are the sandbox bank's (see
 * bank-link/synthetic.ts), plus `sales_<dollars>` to pin monthly gross sales, a platform name
 * to override the one requested, and COMMERCE_FLAGS in synthetic.ts. A token containing
 * `fail` makes the exchange fail. Sales are anchored on the day the account is connected.
 *
 * Payouts: when the business has a connected sandbox bank, the mock platform's payouts are
 * that bank's card settlement deposits (the sandbox platform and the sandbox bank are two
 * independent generators, and this is how they tell one story). Without one, payouts are the
 * card portion of net sales less a 2.9% processing fee, paid the next day.
 */
export class MockCommerceDataProvider implements CommerceDataProvider {
  readonly name = 'mock';

  constructor(private readonly clock: () => string = todayIso) {}

  accessMethod(platform: CommercePlatform): ConnectionAccessMethod {
    return methodFor(platform);
  }

  readOnlyScopes(platform: CommercePlatform): string[] {
    return READ_ONLY_SCOPES[platform];
  }

  authorizationUrl(input: {
    platform: CommercePlatform;
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): { url: string; scopes: string[]; sandbox: boolean } {
    const params = new URLSearchParams({
      state: input.state,
      platform: input.platform,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return {
      url: `/v1/connections/oauth/mock-authorize?${params.toString()}`,
      scopes: READ_ONLY_SCOPES[input.platform],
      sandbox: true,
    };
  }

  private grant(code: MockCode): OAuthGrant {
    const token = code.scenario;
    if (token.includes('fail')) throw new Error('Mock commerce link failure requested by token');
    const digest = createHash('sha256').update(`pos:${token}`).digest();
    const seedHex = digest.subarray(8, 14).toString('hex');
    const spec = parseCommerceScenario(token, code.platform);
    const anchor = this.clock();
    const item = encodeCommerceItemId(spec, seedHex, anchor, parseCommerceFlags(token));
    return this.tokens({ item, merchant: code.merchant, gen: 0 }, decodeCommerceItemId(item));
  }

  private tokens(t: MockToken, item: DecodedCommerceItem): OAuthGrant {
    const expired = item.flags.includes('expired');
    const anchor = item.anchor ?? this.clock();
    return {
      providerItemId: t.item,
      accessToken: `mock_cat.${b64json(t)}`,
      refreshToken: `mock_crt.${b64json(t)}`,
      // Square access tokens last 30 days. An `expired` account's lapses the day after it
      // was connected, and cannot be refreshed.
      expiresAt: new Date(
        `${expired ? addDays(anchor, 1) : addDays(this.clock(), 30)}T00:00:00.000Z`,
      ),
      scopes: READ_ONLY_SCOPES[item.spec.platform],
    };
  }

  async exchangeCode(input: {
    platform: CommercePlatform;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<OAuthGrant> {
    if (!input.code.startsWith('mock_code.')) throw new Error('Unrecognized authorization code');
    const code = unb64json<MockCode>(input.code.slice(10));
    if (code.platform !== input.platform) throw new Error('Code was issued for another platform');
    if (code.challenge !== null && code.challenge !== codeChallengeFor(input.codeVerifier)) {
      throw new Error('PKCE verification failed');
    }
    return this.grant(code);
  }

  async refresh(_platform: CommercePlatform, refreshToken: string): Promise<OAuthGrant> {
    if (!refreshToken.startsWith('mock_crt.')) throw new TokenRefreshError('Unrecognized token');
    const t = unb64json<MockToken>(refreshToken.slice(9));
    const item = decodeCommerceItemId(t.item);
    if (item.flags.includes('expired') && item.anchor && this.clock() > item.anchor) {
      throw new TokenRefreshError('The merchant must approve access again');
    }
    return this.tokens({ ...t, gen: t.gen + 1 }, item);
  }

  async revoke(_credentials: CommerceCredentials): Promise<void> {
    // Nothing to tell in the sandbox. A real adapter calls the platform's revoke endpoint.
  }

  private merchant(credentials: CommerceCredentials): SandboxMerchant {
    const token = credentials.accessToken;
    if (!token?.startsWith('mock_cat.')) return {};
    return unb64json<MockToken>(token.slice(9)).merchant;
  }

  private assertUsable(item: DecodedCommerceItem): void {
    if (item.flags.includes('expired') && item.anchor && this.clock() > item.anchor) {
      throw new TokenRefreshError('The access token has expired');
    }
  }

  async getAccountIdentity(credentials: CommerceCredentials): Promise<PlatformAccountIdentity> {
    const item = decodeCommerceItemId(credentials.providerItemId);
    const merchant = this.merchant(credentials);
    const anchor = item.anchor ?? this.clock();
    const digest = createHash('sha256').update(item.seedHex).digest();
    return {
      legalName: item.flags.includes('owner_mismatch')
        ? OTHER_MERCHANT
        : (merchant.legalName ?? null),
      platformAccountId: `mock_merchant_${item.seedHex}`,
      country: 'US',
      accountCreatedOn: addDays(anchor, item.flags.includes('new_account') ? -45 : -365 * 3),
      taxIdLast4: item.flags.includes('taxid_mismatch') ? '9999' : (merchant.taxIdLast4 ?? null),
      locationName: `${COMMERCE_PLATFORM_LABELS[item.spec.platform]} · ${LOCATIONS[digest[0]! % LOCATIONS.length]!}`,
    };
  }

  async getPayoutDestinations(
    credentials: CommerceCredentials,
    sandbox?: SandboxBank | null,
  ): Promise<PayoutDestination[]> {
    const item = decodeCommerceItemId(credentials.providerItemId);
    if (item.flags.includes('payout_elsewhere')) return [ELSEWHERE_DESTINATION];
    if (!sandbox) return [];
    return [{ institutionName: sandbox.institutionName, mask: sandbox.accountMask, ref: null }];
  }

  async getDailySales(credentials: CommerceCredentials, range: SalesRange): Promise<DailySales[]> {
    const item = decodeCommerceItemId(credentials.providerItemId);
    this.assertUsable(item);
    return this.sales(item).filter((d) => d.date >= range.from && d.date <= range.to);
  }

  private sales(item: DecodedCommerceItem): DailySales[] {
    const today = this.clock();
    const anchor = item.anchor ?? today;
    let rows =
      item.anchor && today > item.anchor
        ? generateSalesAt(item.spec, item.seedHex, item.anchor, today).dailySales
        : generateSales(item.spec, item.seedHex, anchor).dailySales;
    if (item.flags.includes('new_account')) {
      rows = rows.filter((d) => d.date >= addDays(anchor, -45));
    }
    if (item.flags.includes('unsettled')) {
      // Sales on the platform that never settle: gross runs well above what is paid out.
      const from = addDays(anchor, -120);
      rows = rows.map((d) =>
        d.date >= from ? { ...d, grossCents: Math.round(d.grossCents * 1.8) } : d,
      );
    }
    if (item.flags.includes('rewrites') && item.anchor && today > item.anchor) {
      const final = addDays(today, -10);
      rows = rows.map((d) =>
        d.date <= final ? { ...d, grossCents: Math.round(d.grossCents * 1.15) } : d,
      );
    }
    return rows;
  }

  async getPayouts(
    credentials: CommerceCredentials,
    range: SalesRange,
    sandbox?: SandboxBank | null,
  ): Promise<PlatformPayout[]> {
    const item = decodeCommerceItemId(credentials.providerItemId);
    this.assertUsable(item);
    const elsewhere = item.flags.includes('payout_elsewhere');
    const mask = elsewhere ? ELSEWHERE_DESTINATION.mask : (sandbox?.accountMask ?? null);
    const ref = elsewhere ? ELSEWHERE_DESTINATION.ref : null;
    let payouts: PlatformPayout[];
    if (sandbox) {
      payouts = sandbox.transactions
        .filter((t) => t.category === 'CARD_SETTLEMENT' && t.amountCents > 0)
        .map((t, i) => ({
          id: `mock_po_${t.date.replaceAll('-', '')}_${i}`,
          date: t.date,
          amountCents: t.amountCents,
          destinationMask: mask,
          destinationRef: ref,
          locationId: null,
        }));
    } else {
      payouts = [];
      for (const d of this.sales(item)) {
        const cardNet =
          (d.grossCents * d.cardShareBps) / 10_000 - d.refundsCents - d.chargebacksCents;
        const amount = Math.round(cardNet * 0.971);
        if (amount <= 0) continue;
        payouts.push({
          id: `mock_po_${d.date.replaceAll('-', '')}`,
          date: addDays(d.date, 1),
          amountCents: amount,
          destinationMask: mask,
          destinationRef: ref,
          locationId: null,
        });
      }
    }
    return payouts.filter((p) => p.date >= range.from && p.date <= range.to);
  }

  async createLinkToken(
    businessId: string,
    platform: CommercePlatform,
  ): Promise<{ linkToken: string }> {
    return { linkToken: `mock_pos_link_${platform.toLowerCase()}_${businessId}` };
  }

  async exchangePublicToken(
    publicToken: string,
    platform: CommercePlatform,
    sandbox?: SandboxMerchant,
  ): Promise<LinkedCommerceAccount & { grant: OAuthGrant }> {
    const grant = this.grant({
      platform,
      scenario: publicToken,
      merchant: sandbox ?? {},
      challenge: null,
    });
    const item = decodeCommerceItemId(grant.providerItemId);
    const identity = await this.getAccountIdentity({
      platform: item.spec.platform,
      providerItemId: grant.providerItemId,
      accessToken: grant.accessToken,
    });
    const anchor = item.anchor ?? this.clock();
    return {
      providerItemId: grant.providerItemId,
      platform: item.spec.platform,
      locationName: identity.locationName,
      connectedSince: item.flags.includes('new_account')
        ? addDays(anchor, -45)
        : generateSales(item.spec, item.seedHex, anchor).connectedSince,
      grant,
    };
  }
}

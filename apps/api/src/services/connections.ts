import { randomBytes } from 'node:crypto';

import type {
  BankSnapshotPayload,
  CommercePlatform,
  CommerceSnapshotPayload,
  IsoDate,
  PayoutDestination,
  VisibleBankAccount,
} from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS, addDays, daysBetween } from '@cashflow/shared';

import { clockNow, effectiveAt, todayIso } from '../dates.ts';
import type { Db } from '../db.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type {
  BankLink,
  BeneficialOwner,
  Business,
  CommerceLink,
  DataSnapshot,
  Prisma,
} from '../generated/prisma/client.ts';
import { ReauthRequiredError, type BankCredentials } from '../providers/bank-link/index.ts';
import {
  TokenRefreshError,
  type CommerceCredentials,
  type SandboxBank,
} from '../providers/commerce/index.ts';
import { codeChallengeFor, mockAuthorizationCode } from '../providers/commerce/mock.ts';
import { ReportPullError } from '../providers/delegated-seat/index.ts';
import type { Providers } from '../providers/index.ts';
import { CURRENT_POLICY, VERACITY_POLICY_V3 } from '../underwriting/policy.ts';
import type {
  BankPull,
  BankSourceFacts,
  CommercePull,
  CommerceSourceFacts,
  VeracityInput,
} from '../veracity/types.ts';
import { recordAudit, type AuditActor } from './audit.ts';
import { createSnapshot } from './snapshots.ts';

/**
 * Data connections: connecting, pulling, refreshing, and disconnecting, with provenance.
 *
 * Every pull is stored as a snapshot (`snapshots.ts`) and audited by id, hash and counts,
 * never by content. Tokens a platform or aggregator issues are sealed by the token vault
 * before they touch the database and are opened only for the call that needs them. Nothing in
 * this file logs, returns, or audits a token.
 */

type Deps = { db: Db; providers: Providers };

/** How much history underwriting reads: a little over a year. */
export const UNDERWRITING_LOOKBACK_DAYS = 400;

/** Refresh a token this close to its expiry. */
export const TOKEN_REFRESH_LEAD_DAYS = 3;
/** A connection on a business with an active plan is pulled again after this many days. */
export const REFRESH_CADENCE_DAYS = 7;
/** An OAuth authorization in flight expires after this many minutes. */
export const AUTHORIZATION_TTL_MINUTES = 15;

const veracityPolicy = () => CURRENT_POLICY.veracity ?? VERACITY_POLICY_V3;
const aad = (businessId: string) => `business:${businessId}`;
const system: AuditActor = { type: 'system', id: 'connections' };

const sealOrNull = (deps: Deps, businessId: string, token: string | null) =>
  token ? deps.providers.vault.encrypt(token, aad(businessId)) : null;
const openOrNull = (deps: Deps, businessId: string, sealed: string | null) =>
  sealed ? deps.providers.vault.decrypt(sealed, aad(businessId)) : null;

export const bankCredentials = (deps: Deps, link: BankLink): BankCredentials => ({
  providerItemId: link.providerItemId,
  accessToken: openOrNull(deps, link.businessId, link.accessTokenEnc),
});

const commerceCredentials = (deps: Deps, link: CommerceLink): CommerceCredentials => ({
  platform: link.platform,
  providerItemId: link.providerItemId,
  accessToken: openOrNull(deps, link.businessId, link.accessTokenEnc),
});

const destinationsOf = (link: CommerceLink): PayoutDestination[] =>
  Array.isArray(link.payoutDestinations)
    ? (link.payoutDestinations as unknown as PayoutDestination[])
    : [];
const visibleOf = (link: BankLink): VisibleBankAccount[] =>
  Array.isArray(link.visibleAccounts)
    ? (link.visibleAccounts as unknown as VisibleBankAccount[])
    : [];

const iso = (d: Date) => d.toISOString().slice(0, 10);

// ---------- Banks ----------

/**
 * Exchange an aggregator public token, record what the bank reports about the account, and
 * take the first pull. `POST /v1/bank-links` and the demo builders both come through here.
 */
export async function connectBank(
  deps: Deps,
  args: {
    businessId: string;
    publicToken: string;
    asOf?: IsoDate;
    createdAt?: Date;
    actor?: AuditActor;
  },
): Promise<BankLink> {
  const { db, providers } = deps;
  const asOf = args.asOf ?? todayIso();
  const business = await db.business.findUniqueOrThrow({
    where: { id: args.businessId },
    include: { owners: { orderBy: { createdAt: 'asc' } } },
  });
  const linked = await providers.bankLink.exchangePublicToken(args.publicToken, {
    legalName: business.legalName,
    ownerNames: business.owners.map((o) => o.fullName),
  });
  const creds = { providerItemId: linked.providerItemId, accessToken: linked.accessToken };
  const [identity, accounts, status] = await Promise.all([
    providers.bankLink.getIdentity(creds),
    providers.bankLink.listAccounts(creds),
    providers.bankLink.getItemStatus(creds),
  ]);
  const at = args.createdAt ?? effectiveAt(asOf);
  const link = await db.$transaction(async (tx) => {
    const row = await tx.bankLink.create({
      data: {
        businessId: args.businessId,
        provider: providers.bankLink.name,
        providerItemId: linked.providerItemId,
        providerAccountToken: linked.providerAccountToken,
        institutionName: linked.institutionName,
        accountMask: linked.accountMask,
        availableBalanceCents: linked.availableBalanceCents,
        status: 'LINKED',
        accessMethod: 'AGGREGATOR',
        institutionAuthorized: status.institutionAuthorized ?? linked.institutionAuthorized,
        platformAccountId: identity.platformAccountId,
        accountOwnerNames: identity.ownerNames,
        accountType: identity.accountType,
        accountOpenedOn: identity.openedOn,
        visibleAccounts: accounts as unknown as Prisma.InputJsonValue,
        accessTokenEnc: sealOrNull(deps, args.businessId, linked.accessToken),
        consentScopes: linked.scopes,
        consentExpiresAt: linked.consentExpiresAt,
        health: status.health === 'HEALTHY' ? 'HEALTHY' : 'REAUTH_REQUIRED',
        createdAt: at,
      },
    });
    const actor = args.actor ?? system;
    await recordAudit(tx, {
      actor,
      eventType: 'CONNECTION_CONNECTED',
      subjectType: 'connection',
      subjectId: row.id,
      payload: {
        kind: 'BANK',
        businessId: args.businessId,
        accessMethod: 'AGGREGATOR',
        provider: row.provider,
        institutionAuthorized: row.institutionAuthorized,
        accountsVisible: accounts.length,
      },
      at,
    });
    await recordAudit(tx, {
      actor,
      eventType: 'CONSENT_GRANTED',
      subjectType: 'connection',
      subjectId: row.id,
      payload: { scopes: linked.scopes, expiresAt: linked.consentExpiresAt?.toISOString() ?? null },
      at,
    });
    return row;
  });
  await pullBank(deps, link, 'CONNECT', asOf);
  return db.bankLink.findUniqueOrThrow({ where: { id: link.id } });
}

/** Pull a bank connection into a new snapshot. Null, with the link marked, when it fails. */
export async function pullBank(
  deps: Deps,
  link: BankLink,
  reason: 'CONNECT' | 'APPLICATION' | 'REFRESH' | 'REUNDERWRITE',
  asOf: IsoDate,
): Promise<DataSnapshot | null> {
  const { db, providers } = deps;
  const from = addDays(asOf, -(UNDERWRITING_LOOKBACK_DAYS - 1));
  const at = effectiveAt(asOf);
  try {
    const [transactions, balance] = await Promise.all([
      providers.bankLink.getTransactions(link.providerItemId, { from, to: asOf }),
      providers.bankLink.refreshBalance(link.providerItemId),
    ]);
    const payload: BankSnapshotPayload = { transactions, currentBalanceCents: balance };
    return await db.$transaction(async (tx) => {
      const snapshot = await createSnapshot(tx, {
        kind: 'BANK',
        businessId: link.businessId,
        bankLinkId: link.id,
        provider: link.provider,
        reason,
        pulledAt: at,
        windowFrom: from,
        windowTo: asOf,
        payload,
      });
      await tx.bankLink.update({
        where: { id: link.id },
        data: {
          lastPulledAt: at,
          lastPullError: null,
          availableBalanceCents: balance,
          ...(link.health === 'REVOKED' ? {} : { health: 'HEALTHY' }),
        },
      });
      await recordAudit(tx, {
        actor: system,
        eventType: 'DATA_PULLED',
        subjectType: 'connection',
        subjectId: link.id,
        payload: pullAudit(snapshot),
        at,
      });
      return snapshot;
    });
  } catch (err) {
    const health = err instanceof ReauthRequiredError ? 'REAUTH_REQUIRED' : 'ERROR';
    const message = err instanceof Error ? err.message : String(err);
    await db.$transaction(async (tx) => {
      await tx.bankLink.update({
        where: { id: link.id },
        data: { health, lastPullError: message.slice(0, 300) },
      });
      await recordAudit(tx, {
        actor: system,
        eventType: 'DATA_PULL_FAILED',
        subjectType: 'connection',
        subjectId: link.id,
        payload: { kind: 'BANK', reason, health, error: message.slice(0, 300) },
        severity: 'warning',
        at,
      });
    });
    return null;
  }
}

const pullAudit = (s: DataSnapshot) => ({
  snapshotId: s.id,
  kind: s.kind,
  reason: s.reason,
  contentHash: s.contentHash,
  windowFrom: s.windowFrom,
  windowTo: s.windowTo,
  recordCounts: s.recordCounts,
  payloadBytes: s.payloadBytes,
});

// ---------- Platforms ----------

/** The sandbox bank the mock platform pays into: the business's newest connected bank pull. */
async function sandboxBankFor(deps: Deps, businessId: string): Promise<SandboxBank | null> {
  const link = await deps.db.bankLink.findFirst({
    where: { businessId, status: 'LINKED' },
    orderBy: { createdAt: 'desc' },
  });
  if (!link) return null;
  const snapshot = await deps.db.dataSnapshot.findFirst({
    where: { bankLinkId: link.id },
    orderBy: [{ pulledAt: 'desc' }, { createdAt: 'desc' }],
  });
  const payload = snapshot?.payload as unknown as BankSnapshotPayload | undefined;
  return {
    transactions: (payload?.transactions ?? []).filter((t) => t.category === 'CARD_SETTLEMENT'),
    accountMask: link.accountMask,
    institutionName: link.institutionName,
  };
}

const usesSandbox = (deps: Deps, link: Pick<CommerceLink, 'accessMethod' | 'platform'>) =>
  link.accessMethod === 'DELEGATED_SEAT'
    ? deps.providers.delegatedSeat.name === 'mock'
    : deps.providers.commerce.nameFor(link.platform) === 'mock';

/** What the sandbox platform is told about the merchant on its consent page. */
const sandboxMerchant = (business: Business & { owners: BeneficialOwner[] }) => ({
  legalName: business.legalName,
  ownerName: business.owners[0]?.fullName,
  taxIdLast4: business.taxIdLast4,
});

/**
 * Refresh the token when it is close to expiry. Throws `TokenRefreshError` (after marking the
 * link REAUTH_REQUIRED) when the platform refuses: the owner has to approve again.
 */
async function freshCommerceCredentials(
  deps: Deps,
  link: CommerceLink,
  asOf: IsoDate,
): Promise<CommerceLink> {
  if (link.accessMethod !== 'DIRECT_OAUTH' || !link.tokenExpiresAt || !link.refreshTokenEnc)
    return link;
  const horizon = new Date(effectiveAt(asOf).getTime() + TOKEN_REFRESH_LEAD_DAYS * 86_400_000);
  if (link.tokenExpiresAt > horizon) return link;
  return refreshCommerceToken(deps, link, asOf);
}

export async function refreshCommerceToken(
  deps: Deps,
  link: CommerceLink,
  asOf: IsoDate,
): Promise<CommerceLink> {
  const { db, providers } = deps;
  const at = effectiveAt(asOf);
  const refreshToken = openOrNull(deps, link.businessId, link.refreshTokenEnc);
  if (!refreshToken) throw new TokenRefreshError('No refresh token on record');
  try {
    const grant = await providers.commerce.refresh(link.platform, refreshToken);
    return await db.$transaction(async (tx) => {
      const row = await tx.commerceLink.update({
        where: { id: link.id },
        data: {
          accessTokenEnc: sealOrNull(deps, link.businessId, grant.accessToken),
          refreshTokenEnc:
            sealOrNull(deps, link.businessId, grant.refreshToken) ?? link.refreshTokenEnc,
          tokenExpiresAt: grant.expiresAt,
          scopes: grant.scopes,
        },
      });
      await recordAudit(tx, {
        actor: system,
        eventType: 'TOKEN_REFRESHED',
        subjectType: 'connection',
        subjectId: link.id,
        payload: { expiresAt: grant.expiresAt?.toISOString() ?? null, scopes: grant.scopes },
        at,
      });
      return row;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.$transaction(async (tx) => {
      await tx.commerceLink.update({
        where: { id: link.id },
        data: { health: 'REAUTH_REQUIRED', lastPullError: message.slice(0, 300) },
      });
      await recordAudit(tx, {
        actor: system,
        eventType: 'TOKEN_REFRESH_FAILED',
        subjectType: 'connection',
        subjectId: link.id,
        payload: { error: message.slice(0, 300) },
        severity: 'warning',
        at,
      });
    });
    throw err instanceof TokenRefreshError ? err : new TokenRefreshError(message);
  }
}

/** Pull a platform connection into a new snapshot. Null, with the link marked, when it fails. */
export async function pullCommerce(
  deps: Deps,
  original: CommerceLink,
  reason: 'CONNECT' | 'APPLICATION' | 'REFRESH' | 'REUNDERWRITE' | 'SEAT_VERIFIED',
  asOf: IsoDate,
): Promise<DataSnapshot | null> {
  const { db, providers } = deps;
  const from = addDays(asOf, -(UNDERWRITING_LOOKBACK_DAYS - 1));
  const range = { from, to: asOf };
  const at = effectiveAt(asOf);
  try {
    let payload: CommerceSnapshotPayload;
    let destinations: PayoutDestination[];
    const business = await db.business.findUniqueOrThrow({
      where: { id: original.businessId },
      include: { owners: { orderBy: { createdAt: 'asc' } } },
    });
    const bank = usesSandbox(deps, original)
      ? await sandboxBankFor(deps, original.businessId)
      : null;
    if (original.accessMethod === 'DELEGATED_SEAT') {
      const seat = { platform: original.platform, providerItemId: original.providerItemId };
      const sandbox = { merchant: sandboxMerchant(business), bank };
      const puller = providers.delegatedSeat.puller;
      // Each report whole or not at all: a puller throws rather than return part of one.
      const [account, dailySales, payouts] = [
        await puller.account(seat, sandbox),
        await puller.dailySales(seat, range, sandbox),
        await puller.payouts(seat, range, sandbox),
      ];
      payload = { dailySales, payouts };
      destinations = account.payoutDestinations;
    } else {
      const link = await freshCommerceCredentials(deps, original, asOf);
      const creds = commerceCredentials(deps, link);
      const [dailySales, payouts, dest] = await Promise.all([
        providers.commerce.getDailySales(creds, range),
        providers.commerce.getPayouts(creds, range, bank),
        providers.commerce.getPayoutDestinations(creds, bank),
      ]);
      payload = { dailySales, payouts };
      destinations = dest;
    }
    const before = destinationsOf(original);
    const changed =
      before.length > 0 &&
      JSON.stringify(before.map((d) => d.mask).sort()) !==
        JSON.stringify(destinations.map((d) => d.mask).sort());
    return await db.$transaction(async (tx) => {
      const snapshot = await createSnapshot(tx, {
        kind: 'COMMERCE',
        businessId: original.businessId,
        commerceLinkId: original.id,
        provider: original.provider,
        reason,
        pulledAt: at,
        windowFrom: from,
        windowTo: asOf,
        payload,
      });
      await tx.commerceLink.update({
        where: { id: original.id },
        data: {
          lastPulledAt: at,
          lastPullError: null,
          health: 'HEALTHY',
          payoutDestinations: destinations as unknown as Prisma.InputJsonValue,
        },
      });
      await recordAudit(tx, {
        actor: system,
        eventType: 'DATA_PULLED',
        subjectType: 'connection',
        subjectId: original.id,
        payload: {
          ...pullAudit(snapshot),
          platform: original.platform,
          accessMethod: original.accessMethod,
        },
        at,
      });
      if (changed) {
        await recordAudit(tx, {
          actor: system,
          eventType: 'PAYOUT_DESTINATION_CHANGED',
          subjectType: 'connection',
          subjectId: original.id,
          payload: {
            businessId: original.businessId,
            platform: original.platform,
            fromMasks: before.map((d) => d.mask),
            toMasks: destinations.map((d) => d.mask),
          },
          severity: 'warning',
          at,
        });
      }
      return snapshot;
    });
  } catch (err) {
    const health =
      err instanceof TokenRefreshError ||
      (err instanceof ReportPullError && err.reason === 'SEAT_INACTIVE')
        ? 'REAUTH_REQUIRED'
        : 'ERROR';
    const message = err instanceof Error ? err.message : String(err);
    await db.$transaction(async (tx) => {
      await tx.commerceLink.update({
        where: { id: original.id },
        data: { health, lastPullError: message.slice(0, 300) },
      });
      await recordAudit(tx, {
        actor: system,
        eventType: 'DATA_PULL_FAILED',
        subjectType: 'connection',
        subjectId: original.id,
        payload: {
          kind: 'COMMERCE',
          platform: original.platform,
          accessMethod: original.accessMethod,
          reason,
          health,
          failure: err instanceof ReportPullError ? err.reason : null,
          error: message.slice(0, 300),
        },
        severity: 'warning',
        at,
      });
    });
    return null;
  }
}

/** Store a newly granted platform connection with what the platform reports about it. */
async function storeCommerceGrant(
  deps: Deps,
  args: {
    business: Business & { owners: BeneficialOwner[] };
    platform: CommercePlatform;
    grant: {
      providerItemId: string;
      accessToken: string;
      refreshToken: string | null;
      expiresAt: Date | null;
      scopes: string[];
    };
    asOf: IsoDate;
    actor: AuditActor;
    via: 'OAUTH' | 'SANDBOX_TOKEN';
  },
): Promise<CommerceLink> {
  const { db, providers } = deps;
  const { business, platform, grant, asOf } = args;
  const creds: CommerceCredentials = {
    platform,
    providerItemId: grant.providerItemId,
    accessToken: grant.accessToken,
  };
  const identity = await providers.commerce.getAccountIdentity(creds);
  const at = effectiveAt(asOf);
  const link = await db.$transaction(async (tx) => {
    const row = await tx.commerceLink.create({
      data: {
        businessId: business.id,
        provider: providers.commerce.nameFor(platform),
        platform,
        providerItemId: grant.providerItemId,
        locationName: identity.locationName,
        connectedSince: identity.accountCreatedOn ?? asOf,
        status: 'LINKED',
        accessMethod: 'DIRECT_OAUTH',
        legalName: identity.legalName,
        platformAccountId: identity.platformAccountId,
        country: identity.country,
        accountCreatedOn: identity.accountCreatedOn,
        taxIdLast4: identity.taxIdLast4,
        scopes: grant.scopes,
        accessTokenEnc: sealOrNull(deps, business.id, grant.accessToken),
        refreshTokenEnc: sealOrNull(deps, business.id, grant.refreshToken),
        tokenExpiresAt: grant.expiresAt,
        health: 'HEALTHY',
        createdAt: at,
      },
    });
    await recordAudit(tx, {
      actor: args.actor,
      eventType: 'CONNECTION_CONNECTED',
      subjectType: 'connection',
      subjectId: row.id,
      payload: {
        kind: 'COMMERCE',
        businessId: business.id,
        platform,
        accessMethod: 'DIRECT_OAUTH',
        provider: row.provider,
        via: args.via,
      },
      at,
    });
    await recordAudit(tx, {
      actor: args.actor,
      eventType: 'CONSENT_GRANTED',
      subjectType: 'connection',
      subjectId: row.id,
      payload: { scopes: grant.scopes, expiresAt: grant.expiresAt?.toISOString() ?? null },
      at,
    });
    return row;
  });
  await pullCommerce(deps, link, 'CONNECT', asOf);
  return db.commerceLink.findUniqueOrThrow({ where: { id: link.id } });
}

async function businessWithOwners(db: Db, businessId: string) {
  return db.business.findUniqueOrThrow({
    where: { id: businessId },
    include: { owners: { orderBy: { createdAt: 'asc' } } },
  });
}

/**
 * The original sandbox shortcut (`POST /v1/commerce-links`): a token stands in for the whole
 * consent round trip. Toast goes to a seat that is active at once in the sandbox.
 */
export async function connectCommerceWithToken(
  deps: Deps,
  args: {
    businessId: string;
    platform: CommercePlatform;
    publicToken: string;
    asOf?: IsoDate;
    actor?: AuditActor;
  },
): Promise<CommerceLink> {
  const asOf = args.asOf ?? todayIso();
  const business = await businessWithOwners(deps.db, args.businessId);
  const linked = await deps.providers.commerce.exchangePublicToken(
    args.publicToken,
    args.platform,
    sandboxMerchant(business),
  );
  const platform = linked.platform;
  if (deps.providers.commerce.accessMethod(platform) === 'DELEGATED_SEAT') {
    return activeSandboxSeat(
      deps,
      business,
      platform,
      linked.providerItemId,
      asOf,
      args.actor ?? system,
    );
  }
  return storeCommerceGrant(deps, {
    business,
    platform,
    grant: linked.grant,
    asOf,
    actor: args.actor ?? system,
    via: 'SANDBOX_TOKEN',
  });
}

async function activeSandboxSeat(
  deps: Deps,
  business: Business & { owners: BeneficialOwner[] },
  platform: CommercePlatform,
  providerItemId: string,
  asOf: IsoDate,
  actor: AuditActor,
): Promise<CommerceLink> {
  const invitation = deps.providers.delegatedSeat.invitation(platform);
  const link = await deps.db.commerceLink.create({
    data: {
      businessId: business.id,
      provider: deps.providers.delegatedSeat.name,
      platform,
      providerItemId,
      locationName: `${COMMERCE_PLATFORM_LABELS[platform]} (read-only seat)`,
      connectedSince: asOf,
      status: 'PENDING',
      accessMethod: 'DELEGATED_SEAT',
      seatServiceUser: invitation.serviceUserEmail,
      health: 'PENDING',
      createdAt: effectiveAt(asOf),
    },
  });
  return verifySeat(deps, link.id, asOf, actor);
}

// ---------- OAuth ----------

export async function startOAuth(
  deps: Deps,
  args: { businessId: string; userId: string; platform: CommercePlatform; redirectUri: string },
) {
  const { db, providers } = deps;
  if (providers.commerce.accessMethod(args.platform) !== 'DIRECT_OAUTH') {
    throw unprocessable(
      'SEAT_REQUIRED',
      `${COMMERCE_PLATFORM_LABELS[args.platform]} has no API to approve access through. Use the read-only seat invitation instead.`,
    );
  }
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const { url, scopes, sandbox } = providers.commerce.authorizationUrl({
    platform: args.platform,
    state,
    codeChallenge: codeChallengeFor(verifier),
    redirectUri: args.redirectUri,
  });
  const expiresAt = new Date(clockNow().getTime() + AUTHORIZATION_TTL_MINUTES * 60_000);
  await db.connectionAuthorization.create({
    data: {
      state,
      businessId: args.businessId,
      userId: args.userId,
      platform: args.platform,
      provider: providers.commerce.nameFor(args.platform),
      redirectUri: args.redirectUri,
      // The verifier is a secret until the exchange: sealed like a token.
      codeVerifierEnc: providers.vault.encrypt(verifier, `oauth:${state}`),
      scopes,
      expiresAt,
    },
  });
  return {
    authorizationUrl: url,
    state,
    accessMethod: 'DIRECT_OAUTH' as const,
    scopes,
    expiresAt: expiresAt.toISOString(),
    sandbox,
  };
}

async function openAuthorization(deps: Deps, state: string, userId: string) {
  const auth = await deps.db.connectionAuthorization.findUnique({ where: { state } });
  if (!auth) throw notFound('Authorization');
  if (auth.userId !== userId) throw forbidden();
  if (auth.consumedAt)
    throw conflict('AUTHORIZATION_USED', 'This authorization was already completed');
  if (auth.expiresAt < clockNow())
    throw unprocessable('AUTHORIZATION_EXPIRED', 'This authorization expired. Start again.');
  return auth;
}

/**
 * The sandbox's stand-in for the platform's consent screen: the owner approves (or declines)
 * read-only access and is sent back with a code, exactly as a real redirect would. Refused
 * for a platform on a real adapter.
 */
export async function mockAuthorize(
  deps: Deps,
  args: { state: string; userId: string; scenario: string; approve: boolean },
) {
  const auth = await openAuthorization(deps, args.state, args.userId);
  if (deps.providers.commerce.nameFor(auth.platform) !== 'mock') {
    throw unprocessable('NOT_SANDBOX', 'The sandbox approval page only serves sandbox platforms');
  }
  const sep = auth.redirectUri.includes('?') ? '&' : '?';
  if (!args.approve) {
    return {
      redirectUrl: `${auth.redirectUri}${sep}error=access_denied&state=${encodeURIComponent(auth.state)}`,
      state: auth.state,
      code: null,
      error: 'access_denied',
    };
  }
  const business = await businessWithOwners(deps.db, auth.businessId);
  const verifier = deps.providers.vault.decrypt(auth.codeVerifierEnc, `oauth:${auth.state}`);
  const code = mockAuthorizationCode({
    platform: auth.platform,
    scenario: args.scenario,
    merchant: sandboxMerchant(business),
    challenge: codeChallengeFor(verifier),
  });
  return {
    redirectUrl: `${auth.redirectUri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(auth.state)}`,
    state: auth.state,
    code,
    error: null,
  };
}

/** The platform's redirect: exchange the code (with the PKCE verifier) and connect. */
export async function completeOAuth(
  deps: Deps,
  args: { state: string; userId: string; code?: string; error?: string; asOf?: IsoDate },
): Promise<CommerceLink> {
  const auth = await openAuthorization(deps, args.state, args.userId);
  // Consume first, atomically: a code can be exchanged once.
  const consumed = await deps.db.connectionAuthorization.updateMany({
    where: { id: auth.id, consumedAt: null },
    data: { consumedAt: clockNow() },
  });
  if (consumed.count === 0)
    throw conflict('AUTHORIZATION_USED', 'This authorization was already completed');
  if (args.error || !args.code) {
    throw unprocessable(
      'ACCESS_NOT_APPROVED',
      'Access was not approved, so nothing was connected.',
    );
  }
  const verifier = deps.providers.vault.decrypt(auth.codeVerifierEnc, `oauth:${auth.state}`);
  let grant;
  try {
    grant = await deps.providers.commerce.exchangeCode({
      platform: auth.platform,
      code: args.code,
      codeVerifier: verifier,
      redirectUri: auth.redirectUri,
    });
  } catch (err) {
    throw unprocessable(
      'COMMERCE_LINK_FAILED',
      err instanceof Error ? err.message : 'Connection failed',
    );
  }
  const business = await businessWithOwners(deps.db, auth.businessId);
  const link = await storeCommerceGrant(deps, {
    business,
    platform: auth.platform,
    grant,
    asOf: args.asOf ?? todayIso(),
    actor: { type: 'user', id: args.userId },
    via: 'OAUTH',
  });
  await deps.db.connectionAuthorization.update({
    where: { id: auth.id },
    data: { commerceLinkId: link.id },
  });
  return link;
}

// ---------- Delegated seats ----------

export async function createSeatInvitation(
  deps: Deps,
  args: {
    businessId: string;
    platform: CommercePlatform;
    scenario?: string;
    userId: string;
    asOf?: IsoDate;
  },
) {
  const { db, providers } = deps;
  const seats = providers.delegatedSeat;
  if (!seats.supports(args.platform)) {
    throw unprocessable(
      'OAUTH_AVAILABLE',
      `${COMMERCE_PLATFORM_LABELS[args.platform]} connects directly: approve read-only access on its site instead.`,
    );
  }
  const asOf = args.asOf ?? todayIso();
  const handle = await seats.createSeat(args.platform, args.businessId, args.scenario);
  const invitation = seats.invitation(args.platform);
  const at = effectiveAt(asOf);
  const link = await db.$transaction(async (tx) => {
    const row = await tx.commerceLink.create({
      data: {
        businessId: args.businessId,
        provider: seats.name,
        platform: args.platform,
        providerItemId: handle.providerItemId,
        locationName: `${COMMERCE_PLATFORM_LABELS[args.platform]} (read-only seat)`,
        connectedSince: asOf,
        status: 'PENDING',
        accessMethod: 'DELEGATED_SEAT',
        seatServiceUser: invitation.serviceUserEmail,
        health: 'PENDING',
        createdAt: at,
      },
    });
    await recordAudit(tx, {
      actor: { type: 'user', id: args.userId },
      eventType: 'SEAT_INVITED',
      subjectType: 'connection',
      subjectId: row.id,
      payload: {
        businessId: args.businessId,
        platform: args.platform,
        serviceUser: invitation.serviceUserEmail,
      },
      at,
    });
    return row;
  });
  return { link, invitation };
}

/** Check the seat. Active: record what the account reports and take the first pull. */
export async function verifySeat(
  deps: Deps,
  linkId: string,
  asOf: IsoDate = todayIso(),
  actor: AuditActor = system,
): Promise<CommerceLink> {
  const { db, providers } = deps;
  const link = await db.commerceLink.findUniqueOrThrow({ where: { id: linkId } });
  if (link.accessMethod !== 'DELEGATED_SEAT') {
    throw unprocessable('NOT_A_SEAT', 'This connection is not a delegated seat');
  }
  const seat = { platform: link.platform, providerItemId: link.providerItemId };
  const status = await providers.delegatedSeat.verifySeat(seat);
  const at = effectiveAt(asOf);
  await recordAudit(db, {
    actor,
    eventType: 'SEAT_VERIFIED',
    subjectType: 'connection',
    subjectId: link.id,
    payload: { active: status.active, reason: status.reason },
    at,
  });
  if (!status.active) {
    return db.commerceLink.update({
      where: { id: link.id },
      data: { health: 'PENDING', lastPullError: status.reason },
    });
  }
  const business = await businessWithOwners(db, link.businessId);
  let account;
  try {
    account = await providers.delegatedSeat.puller.account(seat, {
      merchant: sandboxMerchant(business),
      bank: usesSandbox(deps, link) ? await sandboxBankFor(deps, link.businessId) : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return db.commerceLink.update({
      where: { id: link.id },
      data: { health: 'ERROR', lastPullError: message.slice(0, 300) },
    });
  }
  const updated = await db.commerceLink.update({
    where: { id: link.id },
    data: {
      status: 'LINKED',
      health: 'HEALTHY',
      seatVerifiedAt: at,
      legalName: account.identity.legalName,
      platformAccountId: account.identity.platformAccountId,
      country: account.identity.country,
      accountCreatedOn: account.identity.accountCreatedOn,
      taxIdLast4: account.identity.taxIdLast4,
      locationName: account.identity.locationName,
      connectedSince: account.identity.accountCreatedOn ?? link.connectedSince,
      payoutDestinations: account.payoutDestinations as unknown as Prisma.InputJsonValue,
      lastPullError: null,
    },
  });
  await pullCommerce(deps, updated, 'SEAT_VERIFIED', asOf);
  return db.commerceLink.findUniqueOrThrow({ where: { id: link.id } });
}

// ---------- Disconnect ----------

/** Revoke at the platform, delete the tokens, keep the row and its snapshots as evidence. */
export async function disconnect(
  deps: Deps,
  args: { kind: 'BANK' | 'COMMERCE'; id: string; userId: string },
): Promise<void> {
  const { db, providers } = deps;
  const at = clockNow();
  if (args.kind === 'BANK') {
    const link = await db.bankLink.findUniqueOrThrow({ where: { id: args.id } });
    await providers.bankLink.revoke(bankCredentials(deps, link)).catch(() => undefined);
    await db.$transaction(async (tx) => {
      await tx.bankLink.update({
        where: { id: link.id },
        data: { status: 'DISCONNECTED', health: 'REVOKED', revokedAt: at, accessTokenEnc: null },
      });
      await recordAudit(tx, {
        actor: { type: 'user', id: args.userId },
        eventType: 'CONNECTION_REVOKED',
        subjectType: 'connection',
        subjectId: link.id,
        payload: { kind: 'BANK', businessId: link.businessId },
        at,
      });
    });
    return;
  }
  const link = await db.commerceLink.findUniqueOrThrow({ where: { id: args.id } });
  if (link.accessMethod === 'DIRECT_OAUTH') {
    await providers.commerce.revoke(commerceCredentials(deps, link)).catch(() => undefined);
  }
  await db.$transaction(async (tx) => {
    await tx.commerceLink.update({
      where: { id: link.id },
      data: {
        status: 'DISCONNECTED',
        health: 'REVOKED',
        revokedAt: at,
        accessTokenEnc: null,
        refreshTokenEnc: null,
        tokenExpiresAt: null,
      },
    });
    await recordAudit(tx, {
      actor: { type: 'user', id: args.userId },
      eventType: 'CONNECTION_REVOKED',
      subjectType: 'connection',
      subjectId: link.id,
      payload: {
        kind: 'COMMERCE',
        businessId: link.businessId,
        platform: link.platform,
        accessMethod: link.accessMethod,
        // A seat is removed by the merchant on their account; CashFlow stops using it now.
        note:
          link.accessMethod === 'DELEGATED_SEAT'
            ? 'Remove the CashFlow reports user from the account'
            : null,
      },
      at,
    });
  });
}

// ---------- What a decision reads ----------

function toBankPull(s: DataSnapshot): BankPull {
  const payload = s.payload as unknown as BankSnapshotPayload;
  return {
    snapshotId: s.id,
    contentHash: s.contentHash,
    pulledAt: s.pulledAt.toISOString(),
    pulledOn: iso(s.pulledAt),
    windowFrom: s.windowFrom,
    windowTo: s.windowTo,
    transactions: payload.transactions,
  };
}

function toCommercePull(s: DataSnapshot): CommercePull {
  const payload = s.payload as unknown as CommerceSnapshotPayload;
  return {
    snapshotId: s.id,
    contentHash: s.contentHash,
    pulledAt: s.pulledAt.toISOString(),
    pulledOn: iso(s.pulledAt),
    windowFrom: s.windowFrom,
    windowTo: s.windowTo,
    dailySales: payload.dailySales,
    payouts: payload.payouts,
  };
}

/**
 * The freshness rule. A snapshot pulled within the policy's age of `asOf` (and not after it)
 * is used; otherwise the connection is pulled again first. A failed re-pull leaves no current
 * snapshot: the checks then ask the owner to reconnect, and nothing stale is decided on.
 */
async function currentAndPrior<T extends 'bank' | 'commerce'>(
  deps: Deps,
  which: T,
  link: T extends 'bank' ? BankLink : CommerceLink,
  asOf: IsoDate,
  reason: 'APPLICATION' | 'REFRESH' | 'REUNDERWRITE',
): Promise<{ current: DataSnapshot | null; prior: DataSnapshot[] }> {
  const where = which === 'bank' ? { bankLinkId: link.id } : { commerceLinkId: link.id };
  const asOfEnd = new Date(`${asOf}T23:59:59.999Z`);
  const recent = await deps.db.dataSnapshot.findMany({
    where: { ...where, pulledAt: { lte: asOfEnd } },
    orderBy: [{ pulledAt: 'desc' }, { createdAt: 'desc' }],
    take: 3,
  });
  const maxAge = veracityPolicy().freshness.maxSnapshotAgeDays;
  const newest = recent[0];
  let current: DataSnapshot | null =
    newest &&
    daysBetween(iso(newest.pulledAt), asOf) <= maxAge &&
    newest.windowTo >= addDays(asOf, -maxAge)
      ? newest
      : null;
  // Sandbox only: the mock platform pays into the business's connected sandbox bank, so a pull
  // taken before that bank was connected is taken again. A real platform's payouts do not
  // depend on what CashFlow has connected.
  if (current && which === 'commerce' && usesSandbox(deps, link as CommerceLink)) {
    const newerBank = await deps.db.bankLink.findFirst({
      where: { businessId: link.businessId, status: 'LINKED', createdAt: { gt: current.pulledAt } },
      select: { id: true },
    });
    if (newerBank) current = null;
  }
  if (!current) {
    current =
      which === 'bank'
        ? await pullBank(deps, link as BankLink, reason, asOf)
        : await pullCommerce(deps, link as CommerceLink, reason, asOf);
  }
  const prior = recent.filter(
    (s) => s.id !== current?.id && (!current || s.pulledAt <= current.pulledAt),
  );
  return { current, prior: prior.slice(0, 2) };
}

export interface DecisionData {
  bankData: {
    transactions: BankSnapshotPayload['transactions'];
    currentBalanceCents: number | null;
    asOf: IsoDate;
  } | null;
  commerceData: {
    platform: CommercePlatform;
    dailySales: CommerceSnapshotPayload['dailySales'];
    connectedSince: IsoDate;
  } | null;
  veracity: VeracityInput;
}

/**
 * Everything a decision reads about the business's data, through snapshots: the bank and
 * platform data the engine scores, and the facts the veracity checks run on. Underwriting,
 * re-underwriting and the refresh job all come through here, so the freshness rule is one
 * rule.
 */
export async function gatherDecisionData(
  deps: Deps,
  args: {
    businessId: string;
    bankLink: BankLink | null;
    commerceLink: CommerceLink | null;
    timeInBusinessMonths: number;
    asOf: IsoDate;
    reason: 'APPLICATION' | 'REFRESH' | 'REUNDERWRITE';
    periodicReview?: boolean;
  },
): Promise<DecisionData> {
  const { db } = deps;
  const business = await businessWithOwners(db, args.businessId);
  const others = await db.bankLink.findMany({
    where: {
      businessId: args.businessId,
      status: 'LINKED',
      ...(args.bankLink ? { id: { not: args.bankLink.id } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });
  const banks: BankSourceFacts[] = [];
  let bankData: DecisionData['bankData'] = null;
  for (const link of args.bankLink ? [args.bankLink, ...others] : []) {
    const { current, prior } = await currentAndPrior(deps, 'bank', link, args.asOf, args.reason);
    const fresh = current ? await db.bankLink.findUniqueOrThrow({ where: { id: link.id } }) : link;
    const primary = link.id === args.bankLink?.id;
    if (primary && current) {
      const payload = current.payload as unknown as BankSnapshotPayload;
      const from = addDays(args.asOf, -(UNDERWRITING_LOOKBACK_DAYS - 1));
      bankData = {
        transactions: payload.transactions.filter((t) => t.date >= from && t.date <= args.asOf),
        currentBalanceCents: payload.currentBalanceCents,
        asOf: args.asOf,
      };
    }
    banks.push({
      connectionId: link.id,
      primary,
      institutionName: link.institutionName,
      accountMask: link.accountMask,
      institutionAuthorized: link.institutionAuthorized,
      ownerNames: link.accountOwnerNames,
      accountType: (link.accountType as BankSourceFacts['accountType']) ?? null,
      openedOn: link.accountOpenedOn,
      visibleAccounts: visibleOf(link),
      health: fresh.health,
      current: current ? toBankPull(current) : null,
      prior: prior.map(toBankPull),
      pullError: current ? null : fresh.lastPullError,
    });
  }

  const commerce: CommerceSourceFacts[] = [];
  let commerceData: DecisionData['commerceData'] = null;
  if (args.commerceLink) {
    const link = args.commerceLink;
    const { current, prior } = await currentAndPrior(
      deps,
      'commerce',
      link,
      args.asOf,
      args.reason,
    );
    const fresh = await db.commerceLink.findUniqueOrThrow({ where: { id: link.id } });
    if (current) {
      const payload = current.payload as unknown as CommerceSnapshotPayload;
      commerceData = {
        platform: link.platform,
        dailySales: payload.dailySales.filter((d) => d.date <= args.asOf),
        connectedSince: link.connectedSince,
      };
    }
    commerce.push({
      connectionId: link.id,
      primary: true,
      platform: link.platform,
      accessMethod: link.accessMethod,
      legalName: link.legalName,
      taxIdLast4: link.taxIdLast4,
      accountCreatedOn: link.accountCreatedOn,
      payoutDestinations: destinationsOf(fresh),
      health: fresh.health,
      current: current ? toCommercePull(current) : null,
      prior: prior.map(toCommercePull),
      pullError: current ? null : fresh.lastPullError,
    });
  }

  return {
    bankData,
    commerceData,
    veracity: {
      asOf: args.asOf,
      applicant: {
        legalName: business.legalName,
        dba: business.dba,
        taxIdLast4: business.taxIdLast4,
        ownerNames: business.owners.map((o) => o.fullName),
        timeInBusinessMonths: args.timeInBusinessMonths,
      },
      banks,
      commerce,
      ...(args.periodicReview ? { periodicReview: true } : {}),
    },
  };
}

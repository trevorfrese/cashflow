import type {
  Connection,
  ConnectionActionView,
  ConnectionCheckView,
  ConnectionList,
  DataSnapshotView,
  OperatorConnection,
  OperatorConnections,
  PayoutDestination,
  TrustTier,
  VeracityAssessment,
  VeracityFinding,
  VisibleBankAccount,
} from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS } from '@cashflow/shared';

import type { Db } from '../db.ts';
import type {
  BankLink,
  CommerceLink,
  DataSnapshot,
  UnderwritingDecision,
} from '../generated/prisma/client.ts';
import { bankMethodTier, platformMethodTier } from '../veracity/assess.ts';

/**
 * How connections are shown. The owner sees how the data is obtained, its health, what it
 * verified, and anything they can do; never a finding's internals, never a token. An
 * operator sees everything the platform reported, the snapshots, and the full findings, and
 * still never a token.
 */

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function methodDescription(link: {
  accessMethod: string;
  platform?: string | null;
  status?: string;
}): string {
  const name = link.platform
    ? COMMERCE_PLATFORM_LABELS[link.platform as keyof typeof COMMERCE_PLATFORM_LABELS]
    : 'your bank';
  switch (link.accessMethod) {
    case 'DIRECT_OAUTH':
      return `You approved read-only access on ${name}'s site. We never see your password.`;
    case 'DELEGATED_SEAT':
      // A seat that is still waiting has not been added yet: say what to do, not what was done.
      if (link.status === 'PENDING')
        return `You add CashFlow's own read-only reports user to your ${name} account. We never see your password.`;
      return `You added CashFlow's own read-only reports user to your ${name} account. We never see your password.`;
    default:
      return 'Connected through our bank data partner with read-only access. We never see your bank password.';
  }
}

/** The newest decision on the business that carries a veracity assessment. */
export async function latestAssessment(
  db: Db,
  businessId: string,
  applicationId?: string,
): Promise<{ decision: UnderwritingDecision; veracity: VeracityAssessment } | null> {
  const decisions = await db.underwritingDecision.findMany({
    where: applicationId ? { applicationId } : { application: { businessId } },
    orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
    take: 20,
  });
  for (const d of decisions) {
    const v = (d.snapshot as { veracity?: VeracityAssessment | null } | null)?.veracity;
    if (v) return { decision: d, veracity: v };
  }
  return null;
}

const ACTION_MESSAGES: Record<ConnectionActionView['code'], string> = {
  CONNECT_PAYOUT_ACCOUNT:
    'We could not match the bank account your sales are paid into with a connected account. Connect that account to continue.',
  RECONNECT:
    'This connection needs you to sign in again. Reconnect it to keep your data up to date.',
  SHARE_ACCOUNTS:
    'Money moves regularly from this account to an account that is not connected. Connect that account to continue.',
  CONNECT_BANK: 'Connect your business bank account so we can verify revenue and cash flow.',
  CONTACT_SUPPORT: 'Contact support and we will help you finish connecting your accounts.',
};

function actionsFor(findings: readonly VeracityFinding[], health: string): ConnectionActionView[] {
  const out = new Map<ConnectionActionView['code'], ConnectionActionView>();
  for (const f of findings) {
    if (
      f.consequence === 'NEEDS_INFO' &&
      (f.customerAction === 'CONNECT_PAYOUT_ACCOUNT' ||
        f.customerAction === 'RECONNECT' ||
        f.customerAction === 'SHARE_ACCOUNTS')
    ) {
      out.set(f.customerAction, {
        code: f.customerAction,
        message: f.customerMessage ?? ACTION_MESSAGES[f.customerAction],
      });
    }
  }
  if ((health === 'REAUTH_REQUIRED' || health === 'ERROR') && !out.has('RECONNECT')) {
    out.set('RECONNECT', { code: 'RECONNECT', message: ACTION_MESSAGES.RECONNECT });
  }
  return [...out.values()];
}

const has = (findings: readonly VeracityFinding[], ...codes: string[]) =>
  findings.some((f) => codes.includes(f.code));

/** Only what the owner can see: verified checks, and failing ones the owner can act on. */
function bankChecks(link: BankLink, findings: readonly VeracityFinding[]): ConnectionCheckView[] {
  const checks: ConnectionCheckView[] = [];
  if (
    link.accountOwnerNames.length > 0 &&
    !has(findings, 'BANK_OWNER_MISMATCH', 'BOTH_SOURCES_OTHER_BUSINESS')
  ) {
    checks.push({ label: 'Account holder matches your business', ok: true });
  }
  checks.push({
    label:
      link.institutionAuthorized === true
        ? "Connected through your bank's own sign-in"
        : 'Connected through our bank data partner',
    ok: true,
  });
  const fresh = link.health === 'HEALTHY' && !has(findings, 'BANK_DATA_UNAVAILABLE');
  checks.push({
    label: fresh ? 'Transactions are up to date' : 'Transactions could not be refreshed',
    ok: fresh,
  });
  return checks;
}

function commerceChecks(
  link: CommerceLink,
  findings: readonly VeracityFinding[],
  verified: boolean,
): ConnectionCheckView[] {
  const checks: ConnectionCheckView[] = [];
  if (link.status === 'PENDING') {
    return [{ label: 'Waiting for the CashFlow reports user to be added', ok: false }];
  }
  if (
    link.legalName &&
    !has(
      findings,
      'PLATFORM_NAME_MISMATCH',
      'PLATFORM_TAX_ID_MISMATCH',
      'BOTH_SOURCES_OTHER_BUSINESS',
    )
  ) {
    checks.push({ label: 'Business name matches your profile', ok: true });
  }
  if (has(findings, 'PAYOUT_ACCOUNT_NOT_CONNECTED', 'PAYOUTS_PARTLY_TO_UNSEEN_ACCOUNT')) {
    checks.push({ label: 'Sales are paid into an account that is not connected', ok: false });
  } else if (verified) {
    checks.push({ label: 'Payouts match deposits in your connected bank', ok: true });
  }
  const fresh = link.health === 'HEALTHY' && !has(findings, 'PLATFORM_DATA_UNAVAILABLE');
  checks.push({
    label: fresh ? 'Sales are up to date' : 'Sales could not be refreshed',
    ok: fresh,
  });
  return checks;
}

function tierOf(
  assessment: VeracityAssessment | null,
  connectionId: string,
  fallback: TrustTier,
): TrustTier {
  return assessment?.sources.find((s) => s.connectionId === connectionId)?.trustTier ?? fallback;
}

export function toConnection(
  link: (BankLink & { kind: 'BANK' }) | (CommerceLink & { kind: 'COMMERCE' }),
  assessment: VeracityAssessment | null,
): Connection {
  const findings = (assessment?.findings ?? []).filter((f) => f.connectionId === link.id);
  if (link.kind === 'BANK') {
    return {
      id: link.id,
      kind: 'BANK',
      businessId: link.businessId,
      platform: null,
      name: link.institutionName,
      detail: `Account ending ${link.accountMask}`,
      accessMethod: link.accessMethod,
      methodDescription: methodDescription(link),
      trustTier:
        link.status === 'LINKED' ? tierOf(assessment, link.id, bankMethodTier(link)) : 'NONE',
      health: link.health,
      status: link.status,
      connectedAt: iso(link.createdAt),
      lastPulledAt: isoOrNull(link.lastPulledAt),
      checks: link.status === 'LINKED' ? bankChecks(link, findings) : [],
      actions: link.status === 'DISCONNECTED' ? [] : actionsFor(findings, link.health),
    };
  }
  const verified =
    assessment?.sources.find((s) => s.connectionId === link.id)?.independentlyVerified ?? false;
  return {
    id: link.id,
    kind: 'COMMERCE',
    businessId: link.businessId,
    platform: link.platform,
    name: COMMERCE_PLATFORM_LABELS[link.platform],
    detail: link.locationName,
    accessMethod: link.accessMethod,
    methodDescription: methodDescription(link),
    trustTier:
      link.status === 'LINKED' ? tierOf(assessment, link.id, platformMethodTier(link)) : 'NONE',
    health: link.health,
    status: link.status,
    connectedAt: iso(link.createdAt),
    lastPulledAt: isoOrNull(link.lastPulledAt),
    checks: link.status === 'DISCONNECTED' ? [] : commerceChecks(link, findings, verified),
    actions: link.status === 'DISCONNECTED' ? [] : actionsFor(findings, link.health),
    seatServiceUser: link.accessMethod === 'DELEGATED_SEAT' ? link.seatServiceUser : null,
  };
}

export async function connectionList(db: Db, businessId: string): Promise<ConnectionList> {
  const [banks, platforms, latest] = await Promise.all([
    db.bankLink.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    db.commerceLink.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    latestAssessment(db, businessId),
  ]);
  const assessment = latest?.veracity ?? null;
  const connections = [
    ...banks.map((b) => toConnection({ ...b, kind: 'BANK' as const }, assessment)),
    ...platforms.map((c) => toConnection({ ...c, kind: 'COMMERCE' as const }, assessment)),
  ];
  const actions: ConnectionActionView[] = [];
  if (!banks.some((b) => b.status === 'LINKED')) {
    actions.push({ code: 'CONNECT_BANK', message: ACTION_MESSAGES.CONNECT_BANK });
  }
  return { connections, actions };
}

// ---------- Operator ----------

const snapshotView = (s: DataSnapshot): DataSnapshotView => ({
  id: s.id,
  pulledAt: iso(s.pulledAt),
  windowFrom: s.windowFrom,
  windowTo: s.windowTo,
  hashPrefix: s.contentHash.slice(0, 12),
  contentHash: s.contentHash,
  reason: s.reason,
  recordCounts: (s.recordCounts ?? {}) as Record<string, number>,
  payloadBytes: s.payloadBytes,
});

const SNAPSHOT_FIELDS = {
  id: true,
  pulledAt: true,
  windowFrom: true,
  windowTo: true,
  contentHash: true,
  reason: true,
  recordCounts: true,
  payloadBytes: true,
  bankLinkId: true,
  commerceLinkId: true,
} as const;

export async function operatorConnections(
  db: Db,
  businessId: string,
  applicationId?: string,
): Promise<OperatorConnections> {
  const [banks, platforms, snapshots, latest] = await Promise.all([
    db.bankLink.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    db.commerceLink.findMany({ where: { businessId }, orderBy: { createdAt: 'asc' } }),
    db.dataSnapshot.findMany({
      where: { businessId },
      orderBy: [{ pulledAt: 'desc' }, { createdAt: 'desc' }],
      select: SNAPSHOT_FIELDS,
      take: 200,
    }),
    latestAssessment(db, businessId, applicationId),
  ]);
  const snaps = (pick: (s: (typeof snapshots)[number]) => boolean) =>
    snapshots
      .filter(pick)
      .slice(0, 20)
      .map((s) => snapshotView(s as DataSnapshot));
  const connections: OperatorConnection[] = [
    ...banks.map((b) => ({
      id: b.id,
      kind: 'BANK' as const,
      provider: b.provider,
      platform: null,
      name: b.institutionName,
      detail: `Account ending ${b.accountMask}`,
      accessMethod: b.accessMethod,
      methodTier: bankMethodTier(b),
      health: b.health,
      status: b.status,
      scopes: b.consentScopes,
      tokenExpiresAt: isoOrNull(b.consentExpiresAt),
      hasStoredToken: b.accessTokenEnc !== null,
      lastPulledAt: isoOrNull(b.lastPulledAt),
      lastPullError: b.lastPullError,
      revokedAt: isoOrNull(b.revokedAt),
      connectedAt: iso(b.createdAt),
      identity: {
        legalName: null,
        platformAccountId: b.platformAccountId,
        country: null,
        accountCreatedOn: b.accountOpenedOn,
        taxIdLast4: null,
        ownerNames: b.accountOwnerNames,
        accountType: (b.accountType as 'BUSINESS' | 'PERSONAL' | null) ?? null,
        institutionAuthorized: b.institutionAuthorized,
        payoutDestinations: [],
        otherAccounts: (Array.isArray(b.visibleAccounts)
          ? b.visibleAccounts
          : []) as unknown as VisibleBankAccount[],
        serviceUser: null,
      },
      snapshots: snaps((s) => s.bankLinkId === b.id),
    })),
    ...platforms.map((c) => ({
      id: c.id,
      kind: 'COMMERCE' as const,
      provider: c.provider,
      platform: c.platform,
      name: COMMERCE_PLATFORM_LABELS[c.platform],
      detail: c.locationName,
      accessMethod: c.accessMethod,
      methodTier: platformMethodTier(c),
      health: c.health,
      status: c.status,
      scopes: c.scopes,
      tokenExpiresAt: isoOrNull(c.tokenExpiresAt),
      hasStoredToken: c.accessTokenEnc !== null,
      lastPulledAt: isoOrNull(c.lastPulledAt),
      lastPullError: c.lastPullError,
      revokedAt: isoOrNull(c.revokedAt),
      connectedAt: iso(c.createdAt),
      identity: {
        legalName: c.legalName,
        platformAccountId: c.platformAccountId,
        country: c.country,
        accountCreatedOn: c.accountCreatedOn,
        taxIdLast4: c.taxIdLast4,
        ownerNames: [],
        accountType: null,
        institutionAuthorized: null,
        payoutDestinations: (Array.isArray(c.payoutDestinations)
          ? c.payoutDestinations
          : []) as unknown as PayoutDestination[],
        otherAccounts: [],
        serviceUser: c.seatServiceUser,
      },
      snapshots: snaps((s) => s.commerceLinkId === c.id),
    })),
  ];
  return {
    businessId,
    connections,
    assessment: latest
      ? {
          decisionId: latest.decision.id,
          applicationId: latest.decision.applicationId,
          decidedAt: iso(latest.decision.decidedAt),
          kind: latest.decision.kind,
          policyVersion: latest.decision.policyVersion,
          veracity: latest.veracity,
        }
      : null,
  };
}

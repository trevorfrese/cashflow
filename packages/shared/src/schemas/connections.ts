import { z } from 'zod';

import { BankLinkStatus, ConnectionAccessMethod, ConnectionHealth, TrustTier } from '../enums';
import { BankTransaction } from './bank-data';
import { CommercePlatform, DailySales } from './commerce';
import { Cents, Id, IsoDateSchema, IsoDateTimeSchema } from './common';

export const ConnectionKind = z.enum(['BANK', 'COMMERCE']);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

/** Bank account type as the aggregator reports it. */
export const BankAccountType = z.enum(['BUSINESS', 'PERSONAL']);
export type BankAccountType = z.infer<typeof BankAccountType>;

/** One settlement batch the platform paid out, as the platform reports it. */
export const PlatformPayout = z.object({
  id: z.string(),
  /** The date the platform says the money arrives in the destination account. */
  date: IsoDateSchema,
  amountCents: Cents,
  /** Last four digits of the destination account, as the platform reports it. */
  destinationMask: z.string().nullable(),
  /** The platform's reference for the destination, when it gives one. */
  destinationRef: z.string().nullable().default(null),
  /** A location id, for platforms that pay each location separately. */
  locationId: z.string().nullable().default(null),
});
export type PlatformPayout = z.infer<typeof PlatformPayout>;

/** Where the platform says it pays the merchant. */
export const PayoutDestination = z.object({
  institutionName: z.string().nullable(),
  mask: z.string().nullable(),
  ref: z.string().nullable(),
});
export type PayoutDestination = z.infer<typeof PayoutDestination>;

/** Another account visible on the same bank login, shared with CashFlow or not. */
export const VisibleBankAccount = z.object({
  mask: z.string(),
  name: z.string(),
  type: BankAccountType.nullable(),
  /** The owner chose to share it with CashFlow. */
  shared: z.boolean(),
});
export type VisibleBankAccount = z.infer<typeof VisibleBankAccount>;

// ---------- Veracity ----------

export const VeracityCheck = z.enum([
  'OWNERSHIP',
  'PAYOUT_DESTINATION',
  'SETTLEMENT',
  'COMPLETENESS',
  'CONSISTENCY',
  'ACCOUNT_AGE',
  'FRESHNESS',
  'METHOD',
]);
export type VeracityCheck = z.infer<typeof VeracityCheck>;

/**
 * What a finding does to a decision. One per finding; `excludesSource` on the finding says
 * whether, as well, the source stops counting toward verified revenue.
 */
export const VeracityConsequence = z.enum([
  'KNOCKOUT',
  'NEEDS_INFO',
  'REFER',
  'CAP',
  'EXCLUDE_SOURCE',
  'REDUCE_DEPTH',
  'INFORM',
]);
export type VeracityConsequence = z.infer<typeof VeracityConsequence>;

export const VeracitySeverity = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type VeracitySeverity = z.infer<typeof VeracitySeverity>;

/** Something the owner can do about a finding. Shown to the owner. */
export const ConnectionActionCode = z.enum([
  'CONNECT_PAYOUT_ACCOUNT',
  'RECONNECT',
  'SHARE_ACCOUNTS',
  'CONNECT_BANK',
  'CONTACT_SUPPORT',
]);
export type ConnectionActionCode = z.infer<typeof ConnectionActionCode>;

export const VeracityFinding = z.object({
  code: z.string(),
  check: VeracityCheck,
  severity: VeracitySeverity,
  consequence: VeracityConsequence,
  /** The source stops counting toward verified revenue. */
  excludesSource: z.boolean(),
  source: ConnectionKind,
  /** The connection the finding is about. Null in the evals. */
  connectionId: z.string().nullable(),
  /** For an operator. Never shown to the owner. */
  detail: z.string(),
  /** The numbers behind it. Never shown to the owner. */
  evidence: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
  /**
   * Specific, non-accusatory wording the owner may see, or null when the finding is internal.
   * Never names the rule.
   */
  customerMessage: z.string().nullable(),
  customerAction: ConnectionActionCode.nullable(),
});
export type VeracityFinding = z.infer<typeof VeracityFinding>;

/** Settlement reconciliation between platform payouts and bank deposits. */
export const SettlementReconciliation = z.object({
  connectionId: z.string().nullable(),
  /** Payouts in the window that should have reached a connected account. */
  payoutsConsidered: z.number().int().min(0),
  payoutsAmountCents: Cents,
  matchedCount: z.number().int().min(0),
  matchedAmountCents: Cents,
  matchedShareByCountBps: z.number().int().min(0).max(10_000).nullable(),
  matchedShareByAmountBps: z.number().int().min(0).max(10_000).nullable(),
  /** Payouts the platform sent to an account that is not connected. */
  unlinkedPayouts: z.number().int().min(0),
  unlinkedAmountCents: Cents,
  /** Bank deposits that name the platform and match no payout. */
  claimedUnmatchedDeposits: z.number().int().min(0),
  claimedUnmatchedAmountCents: Cents,
  /** Platform payouts over the card portion of net sales, for completeness. */
  payoutToCardSalesBps: z.number().int().min(0).nullable(),
  /** Up to ten unmatched payouts, for an operator. */
  unmatchedSample: z.array(z.object({ id: z.string(), date: IsoDateSchema, amountCents: Cents })),
});
export type SettlementReconciliation = z.infer<typeof SettlementReconciliation>;

export const SourceAssessment = z.object({
  connectionId: z.string().nullable(),
  kind: ConnectionKind,
  label: z.string(),
  accessMethod: ConnectionAccessMethod,
  /** Tier from the method alone. */
  methodTier: TrustTier,
  /** Tier after the findings. */
  trustTier: TrustTier,
  /** The source counts toward verified revenue. */
  usableForRevenue: z.boolean(),
  /** Independently verified: usable, and corroborated by the other source. */
  independentlyVerified: z.boolean(),
  findingCodes: z.array(z.string()),
});
export type SourceAssessment = z.infer<typeof SourceAssessment>;

export const SnapshotRef = z.object({
  id: z.string(),
  connectionId: z.string(),
  kind: ConnectionKind,
  contentHash: z.string(),
  pulledAt: IsoDateTimeSchema,
});
export type SnapshotRef = z.infer<typeof SnapshotRef>;

export const VeracityOutcome = z.enum([
  'CLEAR',
  'INFORM',
  'REDUCE_DEPTH',
  'EXCLUDE_SOURCE',
  'CAP',
  'REFER',
  'NEEDS_INFO',
  'KNOCKOUT',
]);
export type VeracityOutcome = z.infer<typeof VeracityOutcome>;

/** The whole assessment, stored on the decision snapshot. Internal. */
export const VeracityAssessment = z.object({
  asOf: IsoDateSchema,
  findings: z.array(VeracityFinding),
  sources: z.array(SourceAssessment),
  reconciliation: z.array(SettlementReconciliation),
  /** The pulls the assessment read, so a decision can be reproduced and audited. */
  snapshots: z.array(SnapshotRef),
  overall: z.object({
    outcome: VeracityOutcome,
    /** The best tier among the sources usable for revenue. */
    trustTier: TrustTier,
    /** Sources usable for revenue and corroborated by another source. */
    independentlyVerifiedSources: z.number().int().min(0),
  }),
});
export type VeracityAssessment = z.infer<typeof VeracityAssessment>;

// ---------- Customer views ----------

/** One thing a connection verified, or could not, in words for the owner. */
export const ConnectionCheckView = z.object({
  label: z.string(),
  ok: z.boolean(),
});
export type ConnectionCheckView = z.infer<typeof ConnectionCheckView>;

export const ConnectionActionView = z.object({
  code: ConnectionActionCode,
  message: z.string(),
});
export type ConnectionActionView = z.infer<typeof ConnectionActionView>;

/** A connection as the owner sees it. No token, no internal finding. */
export const Connection = z.object({
  id: Id,
  kind: ConnectionKind,
  businessId: Id,
  /** Point of sale platform, or null for a bank. */
  platform: CommercePlatform.nullable(),
  /** "Square", or the bank's name. */
  name: z.string(),
  /** "Account ending 1234", or the location name. */
  detail: z.string(),
  accessMethod: ConnectionAccessMethod,
  /** One plain sentence on how the data is obtained. */
  methodDescription: z.string(),
  trustTier: TrustTier,
  health: ConnectionHealth,
  status: BankLinkStatus,
  connectedAt: IsoDateTimeSchema,
  lastPulledAt: IsoDateTimeSchema.nullable(),
  checks: z.array(ConnectionCheckView),
  actions: z.array(ConnectionActionView),
});
export type Connection = z.infer<typeof Connection>;

export const ConnectionList = z.object({
  connections: z.array(Connection),
  /** Actions that are about the business rather than one connection (connect a bank). */
  actions: z.array(ConnectionActionView),
});
export type ConnectionList = z.infer<typeof ConnectionList>;

export const StartOAuthRequest = z.object({
  businessId: Id,
  platform: CommercePlatform,
  /** Where the platform sends the owner back. The app's own route in the sandbox. */
  redirectUri: z.string().min(1).max(500).optional(),
});
export type StartOAuthRequest = z.infer<typeof StartOAuthRequest>;

export const StartOAuthResponse = z.object({
  authorizationUrl: z.string(),
  state: z.string(),
  accessMethod: ConnectionAccessMethod,
  /** Read-only scopes requested. */
  scopes: z.array(z.string()),
  expiresAt: IsoDateTimeSchema,
  /** The sandbox provider: the URL is CashFlow's own mock approval page. */
  sandbox: z.boolean(),
});
export type StartOAuthResponse = z.infer<typeof StartOAuthResponse>;

export const OAuthCallbackRequest = z.object({
  state: z.string().min(1),
  code: z.string().min(1).optional(),
  /** Set by the platform when the owner declined. */
  error: z.string().optional(),
});
export type OAuthCallbackRequest = z.infer<typeof OAuthCallbackRequest>;

/**
 * The sandbox approval page. It stands in for the platform's own consent screen: the owner
 * "signs in" on the platform and approves read-only access, and the platform redirects back
 * with a code. `scenario` takes the sandbox keywords (see apps/api/README.md).
 */
export const MockAuthorizeRequest = z.object({
  state: z.string().min(1),
  scenario: z.string().max(200).default('healthy'),
  approve: z.boolean().default(true),
});
export type MockAuthorizeRequest = z.infer<typeof MockAuthorizeRequest>;

export const MockAuthorizeResponse = z.object({
  /** The redirect the platform would send the browser to. */
  redirectUrl: z.string(),
  state: z.string(),
  code: z.string().nullable(),
  error: z.string().nullable(),
});
export type MockAuthorizeResponse = z.infer<typeof MockAuthorizeResponse>;

export const CreateSeatInvitationRequest = z.object({
  businessId: Id,
  platform: CommercePlatform,
  /** Sandbox keywords for the mock seat (see apps/api/README.md). */
  scenario: z.string().max(200).optional(),
});
export type CreateSeatInvitationRequest = z.infer<typeof CreateSeatInvitationRequest>;

/** What the owner must do to give CashFlow's service user a read-only seat. */
export const SeatInvitation = z.object({
  connection: Connection,
  /** CashFlow's own service user, which the owner adds to the account. */
  serviceUserEmail: z.string(),
  role: z.string(),
  steps: z.array(z.string()),
});
export type SeatInvitation = z.infer<typeof SeatInvitation>;

// ---------- Operator views ----------

export const DataSnapshotView = z.object({
  id: Id,
  pulledAt: IsoDateTimeSchema,
  windowFrom: IsoDateSchema,
  windowTo: IsoDateSchema,
  /** The first 12 characters of the sha256. */
  hashPrefix: z.string(),
  contentHash: z.string(),
  reason: z.string(),
  recordCounts: z.record(z.string(), z.number().int()),
  payloadBytes: z.number().int().min(0),
});
export type DataSnapshotView = z.infer<typeof DataSnapshotView>;

/** A connection with everything an operator needs, still without any token. */
export const OperatorConnection = z.object({
  id: Id,
  kind: ConnectionKind,
  provider: z.string(),
  platform: CommercePlatform.nullable(),
  name: z.string(),
  detail: z.string(),
  accessMethod: ConnectionAccessMethod,
  methodTier: TrustTier,
  health: ConnectionHealth,
  status: BankLinkStatus,
  scopes: z.array(z.string()),
  tokenExpiresAt: IsoDateTimeSchema.nullable(),
  /** A token is stored, encrypted. Never the token itself. */
  hasStoredToken: z.boolean(),
  lastPulledAt: IsoDateTimeSchema.nullable(),
  lastPullError: z.string().nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
  connectedAt: IsoDateTimeSchema,
  /** What the platform or aggregator reports about the account, never the applicant. */
  identity: z.object({
    legalName: z.string().nullable(),
    platformAccountId: z.string().nullable(),
    country: z.string().nullable(),
    accountCreatedOn: IsoDateSchema.nullable(),
    taxIdLast4: z.string().nullable(),
    ownerNames: z.array(z.string()),
    accountType: BankAccountType.nullable(),
    institutionAuthorized: z.boolean().nullable(),
    payoutDestinations: z.array(PayoutDestination),
    otherAccounts: z.array(VisibleBankAccount),
    serviceUser: z.string().nullable(),
  }),
  snapshots: z.array(DataSnapshotView),
});
export type OperatorConnection = z.infer<typeof OperatorConnection>;

export const OperatorConnections = z.object({
  businessId: Id,
  connections: z.array(OperatorConnection),
  /** The veracity assessment of the decision asked about, or of the latest decision. */
  assessment: z
    .object({
      decisionId: Id,
      applicationId: Id,
      decidedAt: IsoDateTimeSchema,
      kind: z.string(),
      policyVersion: z.string(),
      veracity: VeracityAssessment,
    })
    .nullable(),
});
export type OperatorConnections = z.infer<typeof OperatorConnections>;

/** The normalized payload of one bank pull, as stored in a snapshot. */
export const BankSnapshotPayload = z.object({
  transactions: z.array(BankTransaction),
  currentBalanceCents: z.number().int().nullable(),
});
export type BankSnapshotPayload = z.infer<typeof BankSnapshotPayload>;

/** The normalized payload of one platform pull, as stored in a snapshot. */
export const CommerceSnapshotPayload = z.object({
  dailySales: z.array(DailySales),
  payouts: z.array(PlatformPayout),
});
export type CommerceSnapshotPayload = z.infer<typeof CommerceSnapshotPayload>;

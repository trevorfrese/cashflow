import type {
  BankAccountType,
  BankTransaction,
  CommercePlatform,
  ConnectionAccessMethod,
  ConnectionHealth,
  DailySales,
  IsoDate,
  PayoutDestination,
  PlatformPayout,
  TrustTier,
  VisibleBankAccount,
} from '@cashflow/shared';

/**
 * Facts the veracity checks read. The service gathers them from the connections and their
 * snapshots; the portfolio evals build them from the simulation. The checks are pure.
 */

export interface ApplicantFacts {
  legalName: string;
  dba: string | null;
  taxIdLast4: string | null;
  /** Beneficial owners' full names. */
  ownerNames: string[];
  timeInBusinessMonths: number;
}

/** One pull of a bank connection. */
export interface BankPull {
  snapshotId: string | null;
  contentHash: string | null;
  /** ISO timestamp of the pull. */
  pulledAt: string;
  pulledOn: IsoDate;
  windowFrom: IsoDate;
  windowTo: IsoDate;
  transactions: readonly BankTransaction[];
}

export interface CommercePull {
  snapshotId: string | null;
  contentHash: string | null;
  pulledAt: string;
  pulledOn: IsoDate;
  windowFrom: IsoDate;
  windowTo: IsoDate;
  dailySales: readonly DailySales[];
  payouts: readonly PlatformPayout[];
}

export interface BankSourceFacts {
  connectionId: string | null;
  /** The account underwriting reads. Other linked accounts only add deposits to match. */
  primary: boolean;
  institutionName: string;
  accountMask: string;
  /** The bank authorized the connection through OAuth. Null when unknown. */
  institutionAuthorized: boolean | null;
  ownerNames: readonly string[];
  accountType: BankAccountType | null;
  openedOn: IsoDate | null;
  visibleAccounts: readonly VisibleBankAccount[];
  health: ConnectionHealth;
  /** The pull this decision reads. Null when there is none or the re-pull failed. */
  current: BankPull | null;
  /** Earlier pulls, newest first. */
  prior: readonly BankPull[];
  pullError: string | null;
}

export interface CommerceSourceFacts {
  connectionId: string | null;
  primary: boolean;
  platform: CommercePlatform;
  accessMethod: ConnectionAccessMethod;
  legalName: string | null;
  taxIdLast4: string | null;
  accountCreatedOn: IsoDate | null;
  payoutDestinations: readonly PayoutDestination[];
  health: ConnectionHealth;
  current: CommercePull | null;
  prior: readonly CommercePull[];
  pullError: string | null;
}

export interface VeracityInput {
  asOf: IsoDate;
  applicant: ApplicantFacts;
  banks: readonly BankSourceFacts[];
  commerce: readonly CommerceSourceFacts[];
  /** A periodic review of a running plan: actions the owner can take do not stop scoring. */
  periodicReview?: boolean;
}

/** Every threshold the checks use. Lives on the credit policy (`veracity`). */
export interface VeracityPolicy {
  /** Dice similarity of normalized name tokens at or above which two names match. */
  nameMatchThreshold: number;
  reconciliation: {
    /** Payouts in this many days before the decision are reconciled. */
    windowDays: number;
    /** The most recent days are left out: payouts still in transit. */
    inTransitDays: number;
    /** A deposit may post this many days before the platform's payout date... */
    daysBefore: number;
    /** ...or this many after it (weekends, holds, slow banks). */
    daysAfter: number;
    /** Amount tolerance: the larger of this share of the payout and `toleranceMinCents`. */
    toleranceBps: number;
    toleranceMinCents: number;
    /** Most payouts combined into one deposit, or deposits that make up one payout. */
    maxCombine: number;
    /** Fewer payouts than this are too few to judge a match rate on. */
    minPayouts: number;
    /** Matched share by amount under this: the platform does not count toward revenue. */
    excludeBelowBps: number;
    /** Under this: also referred. */
    referBelowBps: number;
    /** Deposits naming the platform with no payout, as a share of such deposits. */
    claimedUnmatchedShareBps: number;
    claimedUnmatchedMinCount: number;
    /** Payouts under this share of the card part of net sales: sales that are not paid out. */
    minPayoutToCardSalesBps: number;
    /** Payouts to an account that is not connected, as a share of payouts, that refers. */
    unseenPayoutShareBps: number;
  };
  completeness: {
    /** Transfers out to accounts not connected, over 90 days, as a share of revenue. */
    unseenTransferShareBps: number;
    /** In each of this many 30 day windows. */
    unseenTransferWindows: number;
    /** Bank revenue under this share of point of sale card sales, without payouts data. */
    minBankToCardSalesBps: number;
  };
  consistency: {
    /** The last days of an earlier pull may legitimately change: pending items post late. */
    pendingToleranceDays: number;
    /** Changes in final periods this many or more, or this share of volume, are material. */
    materialItems: number;
    materialShareBps: number;
  };
  age: {
    recentAccountMonths: number;
    /** A business claiming at least this long is "established" for the bank account check. */
    establishedBankMonths: number;
    establishedPlatformMonths: number;
    /** Bank revenue since the platform account opened above the same span before, by this. */
    surgeBps: number;
    gapDays: number;
  };
  freshness: {
    /** A pull older than this at decision time is re-pulled first. */
    maxSnapshotAgeDays: number;
    /** The newest transaction more than this many days old: the feed is stale. */
    maxDataAgeDays: number;
  };
  depth: {
    /** Data depth credit for the bank history, by trust tier. */
    tierMultiplier: Record<TrustTier, number>;
  };
}

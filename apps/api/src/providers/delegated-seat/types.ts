import type {
  CommercePlatform,
  DailySales,
  IsoDate,
  PayoutDestination,
  PlatformPayout,
} from '@cashflow/shared';

import type { PlatformAccountIdentity, SandboxBank, SandboxMerchant } from '../commerce/types.ts';

/**
 * Platforms without a self-serve API (Toast): the merchant invites CashFlow's own service
 * user onto their account as a read-only reports user, and CashFlow's agent signs in with
 * CashFlow's credentials for that seat and pulls reports. CashFlow never holds the merchant's
 * password. Design and limits: `apps/api/DATA_CONNECTIONS.md`, "Delegated seats".
 */

export interface SeatInvitationSpec {
  /** CashFlow's service user. The merchant adds this, and only this, to their account. */
  serviceUserEmail: string;
  role: string;
  steps: string[];
}

/** What CashFlow records about a seat. No credential of any kind. */
export interface SeatHandle {
  platform: CommercePlatform;
  /** The merchant account the seat is on (a Toast restaurant guid). */
  providerItemId: string;
}

export interface SeatStatus {
  active: boolean;
  /** Why not, in words for an operator. */
  reason: string | null;
}

export interface ReportRange {
  from: IsoDate;
  to: IsoDate;
}

export interface AccountReport {
  identity: PlatformAccountIdentity;
  payoutDestinations: PayoutDestination[];
}

/** Sandbox only, as for the commerce mock. A real puller ignores it. */
export interface SeatSandbox {
  merchant?: SandboxMerchant;
  bank?: SandboxBank | null;
}

export type ReportPullFailure =
  /** The page or export did not have the shape the puller expects. Fail closed. */
  | 'LAYOUT_CHANGED'
  /** The seat was removed or never activated. */
  | 'SEAT_INACTIVE'
  /** The platform throttled us; retried on a later run. */
  | 'RATE_LIMITED'
  /** Sign in or session setup failed. */
  | 'SESSION_FAILED';

/**
 * A pull failed. Nothing from it is used: a report that is not complete and in the expected
 * shape is no report. The connection goes to ERROR.
 */
export class ReportPullError extends Error {
  constructor(
    readonly reason: ReportPullFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ReportPullError';
  }
}

/**
 * Pulls reports through a seat. The real one is a headless browser or agent session signed
 * in as CashFlow's service user, one isolated session per merchant. Each call returns a whole
 * report or throws `ReportPullError`: never a partial one.
 */
export interface ReportPuller {
  readonly name: string;
  account(seat: SeatHandle, sandbox?: SeatSandbox): Promise<AccountReport>;
  dailySales(seat: SeatHandle, range: ReportRange, sandbox?: SeatSandbox): Promise<DailySales[]>;
  payouts(seat: SeatHandle, range: ReportRange, sandbox?: SeatSandbox): Promise<PlatformPayout[]>;
}

export interface DelegatedSeatProvider {
  readonly name: string;
  supports(platform: CommercePlatform): boolean;
  invitation(platform: CommercePlatform): SeatInvitationSpec;
  /**
   * Record a seat for a business, pending until verified. `scenario` takes the sandbox
   * keywords; a real provider ignores it and asks the merchant for the account to look for.
   */
  createSeat(
    platform: CommercePlatform,
    businessId: string,
    scenario?: string,
  ): Promise<SeatHandle>;
  /** Is CashFlow's service user on the account, active, and limited to read-only reports. */
  verifySeat(seat: SeatHandle): Promise<SeatStatus>;
  readonly puller: ReportPuller;
}

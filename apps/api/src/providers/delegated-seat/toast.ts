import type { CommercePlatform, DailySales, PlatformPayout } from '@cashflow/shared';

import type { Config } from '../../config.ts';
import type {
  AccountReport,
  DelegatedSeatProvider,
  ReportPuller,
  ReportRange,
  SeatHandle,
  SeatInvitationSpec,
  SeatStatus,
} from './types.ts';

const refuse = (method: string) =>
  new Error(
    `ToastSeatProvider.${method} is not implemented. There is no real browser automation in this repository. See apps/api/DATA_CONNECTIONS.md.`,
  );

/**
 * Skeleton for the Toast delegated seat. Compile only and NOT EXERCISED, and deliberately
 * without any browser automation. What a real one would be, under the constraints in
 * DATA_CONNECTIONS.md (the seat is CashFlow's and read only; its credentials come from the
 * secret store by reference, never from a merchant; one isolated session per merchant;
 * politeness limits; fail closed on any layout change; every pull audited; the platform's
 * terms reviewed by counsel first):
 *
 *   invitation   Toast Web, Employees: add CashFlow's service user with a custom job that has
 *                only the "View reports" permissions (sales summary, payments, deposits).
 *   verifySeat   Sign in as the service user, list the restaurants the seat can see, confirm
 *                the merchant's restaurant is there and that the job has no write access.
 *   puller       Reports > Sales summary (daily), Reports > Payments, Deposits report. Each
 *                export is parsed against a pinned column layout; any difference throws
 *                ReportPullError('LAYOUT_CHANGED') and nothing is stored.
 *
 * Toast's partner API (for integration partners) would replace all of this with a direct
 * connection if a partnership were in place: that is the preferred path.
 */
export class ToastSeatProvider implements DelegatedSeatProvider {
  readonly name = 'toast';
  readonly puller: ReportPuller = {
    name: 'toast-browser',
    account: async (_seat: SeatHandle): Promise<AccountReport> => {
      throw refuse('puller.account');
    },
    dailySales: async (_seat: SeatHandle, _range: ReportRange): Promise<DailySales[]> => {
      throw refuse('puller.dailySales');
    },
    payouts: async (_seat: SeatHandle, _range: ReportRange): Promise<PlatformPayout[]> => {
      throw refuse('puller.payouts');
    },
  };

  constructor(config: Config) {
    if (!config.TOAST_SEAT_SERVICE_USER || !config.TOAST_SEAT_CREDENTIALS_REF) {
      throw new Error(
        'DELEGATED_SEAT_PROVIDER=toast requires TOAST_SEAT_SERVICE_USER and TOAST_SEAT_CREDENTIALS_REF (a secret store reference, never a password in the environment)',
      );
    }
    if (!config.CONNECTION_TOKEN_KEY) {
      throw new Error('DELEGATED_SEAT_PROVIDER=toast requires CONNECTION_TOKEN_KEY');
    }
  }

  supports(platform: CommercePlatform): boolean {
    return platform === 'TOAST';
  }

  invitation(_platform: CommercePlatform): SeatInvitationSpec {
    throw refuse('invitation');
  }

  async createSeat(_platform: CommercePlatform, _businessId: string): Promise<SeatHandle> {
    throw refuse('createSeat');
  }

  async verifySeat(_seat: SeatHandle): Promise<SeatStatus> {
    throw refuse('verifySeat');
  }
}

import { createHash } from 'node:crypto';

import type { CommercePlatform, DailySales, PlatformPayout } from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS } from '@cashflow/shared';

import { todayIso } from '../../dates.ts';
import { MockCommerceDataProvider } from '../commerce/mock.ts';
import { decodeCommerceItemId } from '../commerce/synthetic.ts';
import type { CommerceCredentials } from '../commerce/types.ts';
import {
  ReportPullError,
  type AccountReport,
  type DelegatedSeatProvider,
  type ReportPuller,
  type ReportRange,
  type SeatHandle,
  type SeatInvitationSpec,
  type SeatSandbox,
  type SeatStatus,
} from './types.ts';

/** The sandbox service user. Not a mailbox anyone reads. */
export const MOCK_SERVICE_USER = 'reports+sandbox@cashflow.example';

/**
 * Sandbox seats. The data is the mock commerce platform's, so a Toast seat in the sandbox
 * tells the same story as a Square connection with the same keywords. `seat_inactive` makes
 * verification fail; `seat_layout_changed` makes every report pull fail as a layout change would.
 */
export class MockReportPuller implements ReportPuller {
  readonly name = 'mock';

  constructor(private readonly platform: MockCommerceDataProvider) {}

  private credentials(seat: SeatHandle, sandbox?: SeatSandbox): CommerceCredentials {
    const merchant = sandbox?.merchant ?? {};
    const token = `mock_cat.${Buffer.from(JSON.stringify({ item: seat.providerItemId, merchant, gen: 0 })).toString('base64url')}`;
    return { platform: seat.platform, providerItemId: seat.providerItemId, accessToken: token };
  }

  private check(seat: SeatHandle): void {
    const { flags } = decodeCommerceItemId(seat.providerItemId);
    if (flags.includes('seat_inactive')) {
      throw new ReportPullError(
        'SEAT_INACTIVE',
        'The CashFlow reports user is not active on the account',
      );
    }
    if (flags.includes('seat_layout_changed')) {
      throw new ReportPullError(
        'LAYOUT_CHANGED',
        'The sales summary export did not have the expected columns',
      );
    }
  }

  async account(seat: SeatHandle, sandbox?: SeatSandbox): Promise<AccountReport> {
    this.check(seat);
    const creds = this.credentials(seat, sandbox);
    return {
      identity: await this.platform.getAccountIdentity(creds),
      payoutDestinations: await this.platform.getPayoutDestinations(creds, sandbox?.bank),
    };
  }

  async dailySales(
    seat: SeatHandle,
    range: ReportRange,
    sandbox?: SeatSandbox,
  ): Promise<DailySales[]> {
    this.check(seat);
    return this.platform.getDailySales(this.credentials(seat, sandbox), range);
  }

  async payouts(
    seat: SeatHandle,
    range: ReportRange,
    sandbox?: SeatSandbox,
  ): Promise<PlatformPayout[]> {
    this.check(seat);
    return this.platform.getPayouts(this.credentials(seat, sandbox), range, sandbox?.bank);
  }
}

export class MockDelegatedSeatProvider implements DelegatedSeatProvider {
  readonly name = 'mock';
  readonly puller: MockReportPuller;
  private readonly platform: MockCommerceDataProvider;

  constructor(private readonly clock: () => string = todayIso) {
    this.platform = new MockCommerceDataProvider(clock);
    this.puller = new MockReportPuller(this.platform);
  }

  supports(platform: CommercePlatform): boolean {
    return platform === 'TOAST';
  }

  invitation(platform: CommercePlatform): SeatInvitationSpec {
    const name = COMMERCE_PLATFORM_LABELS[platform];
    return {
      serviceUserEmail: MOCK_SERVICE_USER,
      role: 'Read-only reports',
      steps: [
        `Sign in to ${name} Web as the account owner or an admin.`,
        'Open Employees, then add an employee.',
        `Enter ${MOCK_SERVICE_USER} as the email, with the name CashFlow Reports.`,
        'Give it a reports-only role with no access to payments, payroll, or settings.',
        'Save. Then come back here and tap Check connection.',
      ],
    };
  }

  async createSeat(
    platform: CommercePlatform,
    businessId: string,
    scenario = 'healthy',
  ): Promise<SeatHandle> {
    const linked = await this.platform.exchangePublicToken(
      `${scenario}_${createHash('sha256').update(businessId).digest('hex').slice(0, 8)}`,
      platform,
    );
    return { platform, providerItemId: linked.providerItemId };
  }

  async verifySeat(seat: SeatHandle): Promise<SeatStatus> {
    const { flags } = decodeCommerceItemId(seat.providerItemId);
    if (flags.includes('seat_inactive')) {
      return { active: false, reason: 'CashFlow Reports has not been added to the account yet' };
    }
    return { active: true, reason: null };
  }
}

import type { BankTransaction, DailySales, IsoDate, PlatformPayout } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';

import { VERACITY_POLICY_V3 } from '../underwriting/policy.ts';
import { account, AS_OF } from '../underwriting/test-support.ts';
import type {
  ApplicantFacts,
  BankPull,
  BankSourceFacts,
  CommercePull,
  CommerceSourceFacts,
  VeracityInput,
} from './types.ts';

/** Builders for the veracity unit tests. Not used outside tests. */

export const POLICY = VERACITY_POLICY_V3;
export { AS_OF };

export const applicant = (over: Partial<ApplicantFacts> = {}): ApplicantFacts => ({
  legalName: 'Blue Door Bakery LLC',
  dba: 'Blue Door Bakery',
  taxIdLast4: '4821',
  ownerNames: ['Dana Rivera'],
  timeInBusinessMonths: 60,
  ...over,
});

export const bankPull = (
  transactions: readonly BankTransaction[] = account(),
  pulledOn: IsoDate = AS_OF,
): BankPull => ({
  snapshotId: `snap_bank_${pulledOn}`,
  contentHash: `hash_${pulledOn}`,
  pulledAt: `${pulledOn}T12:00:00.000Z`,
  pulledOn,
  windowFrom: addDays(pulledOn, -399),
  windowTo: pulledOn,
  transactions,
});

export const bank = (over: Partial<BankSourceFacts> = {}): BankSourceFacts => ({
  connectionId: 'bank_1',
  primary: true,
  institutionName: 'First Street Bank',
  accountMask: '4821',
  institutionAuthorized: true,
  ownerNames: ['Blue Door Bakery LLC'],
  accountType: 'BUSINESS',
  openedOn: '2019-01-01',
  visibleAccounts: [{ mask: '4821', name: 'Business Checking', type: 'BUSINESS', shared: true }],
  health: 'HEALTHY',
  current: bankPull(),
  prior: [],
  pullError: null,
  ...over,
});

/** Platform sales whose card part is what `account()` deposits each day. */
export function salesFor(transactions: readonly BankTransaction[]): DailySales[] {
  return transactions
    .filter((t) => t.category === 'CARD_SETTLEMENT')
    .map((t) => ({
      date: t.date,
      grossCents: Math.round(t.amountCents / 0.85),
      refundsCents: 0,
      chargebacksCents: 0,
      orderCount: 20,
      cardShareBps: 8500,
    }));
}

/** One payout per card deposit, same day, same amount, to the given mask. */
export function payoutsFor(
  transactions: readonly BankTransaction[],
  mask: string | null = '4821',
): PlatformPayout[] {
  return transactions
    .filter((t) => t.category === 'CARD_SETTLEMENT')
    .map((t, i) => ({
      id: `po_${i}`,
      date: t.date,
      amountCents: t.amountCents,
      destinationMask: mask,
      destinationRef: null,
      locationId: null,
    }));
}

export const commercePull = (
  over: Partial<CommercePull> = {},
  transactions: readonly BankTransaction[] = account(),
): CommercePull => ({
  snapshotId: `snap_pos_${AS_OF}`,
  contentHash: `poshash_${AS_OF}`,
  pulledAt: `${AS_OF}T12:00:00.000Z`,
  pulledOn: AS_OF,
  windowFrom: addDays(AS_OF, -399),
  windowTo: AS_OF,
  dailySales: salesFor(transactions),
  payouts: payoutsFor(transactions),
  ...over,
});

export const pos = (over: Partial<CommerceSourceFacts> = {}): CommerceSourceFacts => ({
  connectionId: 'pos_1',
  primary: true,
  platform: 'SQUARE',
  accessMethod: 'DIRECT_OAUTH',
  legalName: 'Blue Door Bakery LLC',
  taxIdLast4: '4821',
  accountCreatedOn: '2020-01-01',
  payoutDestinations: [{ institutionName: 'First Street Bank', mask: '4821', ref: null }],
  health: 'HEALTHY',
  current: commercePull(),
  prior: [],
  pullError: null,
  ...over,
});

export const input = (over: Partial<VeracityInput> = {}): VeracityInput => ({
  asOf: AS_OF,
  applicant: applicant(),
  banks: [bank()],
  commerce: [pos()],
  ...over,
});

/** An account whose daily deposits all differ, so a match cannot be a coincidence. */
export const variedAccount = (asOf: IsoDate = AS_OF, days = 400) =>
  account({ asOf, days, dailySalesCents: (d) => 90_000 + ((d * 7919) % 20_000) });

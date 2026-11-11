import { createHash } from 'node:crypto';

import type { BankTransaction, IsoDate, VisibleBankAccount } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';

import { todayIso } from '../../dates.ts';
import {
  decodeItemId,
  encodeItemId,
  generateHistory,
  generateHistoryAt,
  parseBankFlags,
  parseScenario,
  type DecodedItem,
  type SyntheticHistory,
} from './synthetic.ts';
import {
  ReauthRequiredError,
  type BankAccountIdentity,
  type BankCredentials,
  type BankLinkProvider,
  type ItemStatus,
  type LinkedAccount,
  type SandboxHolder,
  type TransactionRange,
} from './types.ts';

const INSTITUTIONS = [
  'First Street Bank',
  'Harbor Credit Union',
  'Meridian Bank',
  'Oak & Main Savings',
];

/** The business the `borrowed` keyword's account belongs to. */
export const BORROWED_HOLDER = 'Harlow Ventures LLC';

interface MockProfile {
  legalName: string | null;
  ownerNames: string[];
  mask?: string;
}

const encodeProfile = (p: MockProfile) =>
  `mock_bat.${Buffer.from(JSON.stringify(p), 'utf8').toString('base64url')}`;

function decodeProfile(token: string | null): MockProfile {
  if (!token?.startsWith('mock_bat.')) return { legalName: null, ownerNames: [] };
  // The sandbox token only carries what the mock needs to answer identity calls.
  try {
    return JSON.parse(Buffer.from(token.slice(9), 'base64url').toString('utf8')) as MockProfile;
  } catch {
    return { legalName: null, ownerNames: [] };
  }
}

/**
 * Deterministic fake bank. The public token picks the institution, the scenario, and the
 * revenue level, so demos and tests are repeatable. Keywords in the token select a scenario
 * (see SCENARIOS in synthetic.ts): healthy (default), growing, thin_margin, declining,
 * volatile, overdrafts, heavy_debt, seasonal, new_business, low_balance, no_balance, batched.
 * `rev_48000` pins monthly revenue to $48,000 and `rent_6200` pins the observed rent.
 * A token containing `fail` makes the exchange fail. BANK_FLAGS in synthetic.ts change what
 * the bank reports about the account: personal, borrowed, new_account, hidden, legacy,
 * rewrites, expired.
 *
 * The history is anchored on the day the token is linked and continues from there, so a
 * later pull sees the same past.
 *
 * Any account token this provider returns contains "mock_acct_" and the MockPaymentsProvider
 * charges it successfully unless the token also contains "fail".
 */
export class MockBankLinkProvider implements BankLinkProvider {
  readonly name = 'mock';

  constructor(private readonly clock: () => string = todayIso) {}

  async createLinkToken(businessId: string): Promise<{ linkToken: string }> {
    return { linkToken: `mock_link_${businessId}` };
  }

  async exchangePublicToken(publicToken: string, sandbox?: SandboxHolder): Promise<LinkedAccount> {
    if (publicToken.includes('fail')) {
      throw new Error('Mock bank link failure requested by token');
    }
    const digest = createHash('sha256').update(publicToken).digest();
    const institution = INSTITUTIONS[digest[0]! % INSTITUTIONS.length]!;
    const mask = (1000 + (digest.readUInt16BE(1) % 9000)).toString();
    const seedHex = digest.subarray(8, 14).toString('hex');
    const spec = parseScenario(publicToken);
    const flags = parseBankFlags(publicToken);
    const anchor = this.clock();
    const history = generateHistory(spec, seedHex, anchor);
    return {
      providerItemId: encodeItemId(spec, seedHex, anchor, flags),
      providerAccountToken: `mock_acct_${digest.subarray(14, 22).toString('hex')}`,
      institutionName: institution,
      accountMask: mask,
      availableBalanceCents: history.currentBalanceCents,
      accessToken: encodeProfile({
        legalName: sandbox?.legalName ?? null,
        ownerNames: sandbox?.ownerNames ?? [],
        mask,
      }),
      institutionAuthorized: !flags.includes('legacy'),
      scopes: ['transactions', 'identity', 'auth'],
      consentExpiresAt: null,
    };
  }

  private history(item: DecodedItem): SyntheticHistory {
    const today = this.clock();
    // Links made before histories were anchored regenerate as of today, as they always did.
    if (!item.anchor || today <= item.anchor) {
      return generateHistory(item.spec, item.seedHex, item.anchor ?? today);
    }
    return generateHistoryAt(item.spec, item.seedHex, item.anchor, today);
  }

  private expired(item: DecodedItem): boolean {
    return item.flags.includes('expired') && item.anchor !== null && this.clock() > item.anchor;
  }

  async refreshBalance(providerItemId: string): Promise<number | null> {
    return this.history(decodeItemId(providerItemId)).currentBalanceCents;
  }

  async getTransactions(
    providerItemId: string,
    range: TransactionRange,
  ): Promise<BankTransaction[]> {
    const item = decodeItemId(providerItemId);
    if (this.expired(item)) throw new ReauthRequiredError();
    let { transactions } = this.history(item);
    if (item.flags.includes('rewrites') && item.anchor && this.clock() > item.anchor) {
      // What a doctored feed looks like on a later pull: overdraft fees and debt payments
      // that were in the first pull are gone from a period that was already final.
      const final = addDays(this.clock(), -10);
      transactions = transactions.filter(
        (t) =>
          !(
            t.date <= final &&
            (t.category === 'NSF_FEE' ||
              t.category === 'MCA_PAYMENT' ||
              t.category === 'LOAN_PAYMENT')
          ),
      );
    }
    return transactions.filter((t) => t.date >= range.from && t.date <= range.to);
  }

  async getIdentity(credentials: BankCredentials): Promise<BankAccountIdentity> {
    const item = decodeItemId(credentials.providerItemId);
    const profile = decodeProfile(credentials.accessToken);
    const opened: IsoDate | null = item.anchor
      ? addDays(item.anchor, item.flags.includes('new_account') ? -60 : -365 * 6)
      : null;
    let ownerNames: string[] = profile.legalName ? [profile.legalName] : [];
    let accountType: BankAccountIdentity['accountType'] = profile.legalName ? 'BUSINESS' : null;
    if (item.flags.includes('personal') && profile.ownerNames[0]) {
      ownerNames = [profile.ownerNames[0]];
      accountType = 'PERSONAL';
    }
    if (item.flags.includes('borrowed')) {
      ownerNames = [BORROWED_HOLDER];
      accountType = 'BUSINESS';
    }
    return {
      platformAccountId: `mock_account_${item.seedHex}`,
      ownerNames,
      accountType,
      openedOn: opened,
    };
  }

  async listAccounts(credentials: BankCredentials): Promise<VisibleBankAccount[]> {
    const item = decodeItemId(credentials.providerItemId);
    const digest = createHash('sha256').update(item.seedHex).digest();
    const shared: VisibleBankAccount = {
      mask:
        decodeProfile(credentials.accessToken).mask ??
        String(1000 + (digest.readUInt16BE(0) % 9000)),
      name: 'Business Checking',
      type: item.flags.includes('personal') ? 'PERSONAL' : 'BUSINESS',
      shared: true,
    };
    if (!item.flags.includes('hidden')) return [shared];
    return [
      shared,
      {
        mask: String(1000 + (digest.readUInt16BE(2) % 9000)),
        name: 'Business Savings',
        type: 'BUSINESS',
        shared: false,
      },
      {
        mask: String(1000 + (digest.readUInt16BE(4) % 9000)),
        name: 'Operating Account 2',
        type: 'BUSINESS',
        shared: false,
      },
    ];
  }

  async getItemStatus(credentials: BankCredentials): Promise<ItemStatus> {
    const item = decodeItemId(credentials.providerItemId);
    const expired = this.expired(item);
    return {
      health: expired ? 'REAUTH_REQUIRED' : 'HEALTHY',
      institutionAuthorized: !item.flags.includes('legacy'),
      consentExpiresAt: null,
      error: expired ? 'ITEM_LOGIN_REQUIRED' : null,
    };
  }

  async revoke(_credentials: BankCredentials): Promise<void> {
    // The sandbox has nothing to tell. A real aggregator call removes the item.
  }
}

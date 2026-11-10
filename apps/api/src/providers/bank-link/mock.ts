import { createHash } from 'node:crypto';

import type { BankTransaction } from '@cashflow/shared';

import { todayIso } from '../../dates.ts';
import { decodeItemId, encodeItemId, generateHistory, parseScenario } from './synthetic.ts';
import type { BankLinkProvider, LinkedAccount, TransactionRange } from './types.ts';

const INSTITUTIONS = [
  'First Street Bank',
  'Harbor Credit Union',
  'Meridian Bank',
  'Oak & Main Savings',
];

/**
 * Deterministic fake bank. The public token picks the institution, the scenario, and the
 * revenue level, so demos and tests are repeatable. Keywords in the token select a scenario
 * (see SCENARIOS in synthetic.ts): healthy (default), growing, thin_margin, declining,
 * volatile, overdrafts, heavy_debt, seasonal, new_business, low_balance, no_balance.
 * `rev_48000` pins monthly revenue to $48,000 and `rent_6200` pins the observed rent.
 * A token containing `fail` makes the exchange fail.
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

  async exchangePublicToken(publicToken: string): Promise<LinkedAccount> {
    if (publicToken.includes('fail')) {
      throw new Error('Mock bank link failure requested by token');
    }
    const digest = createHash('sha256').update(publicToken).digest();
    const institution = INSTITUTIONS[digest[0]! % INSTITUTIONS.length]!;
    const mask = (1000 + (digest.readUInt16BE(1) % 9000)).toString();
    const seedHex = digest.subarray(8, 14).toString('hex');
    const spec = parseScenario(publicToken);
    const history = generateHistory(spec, seedHex, this.clock());
    return {
      providerItemId: encodeItemId(spec, seedHex),
      providerAccountToken: `mock_acct_${digest.subarray(14, 22).toString('hex')}`,
      institutionName: institution,
      accountMask: mask,
      availableBalanceCents: history.currentBalanceCents,
    };
  }

  async refreshBalance(providerItemId: string): Promise<number | null> {
    const { spec, seedHex } = decodeItemId(providerItemId);
    return generateHistory(spec, seedHex, this.clock()).currentBalanceCents;
  }

  async getTransactions(
    providerItemId: string,
    range: TransactionRange,
  ): Promise<BankTransaction[]> {
    const { spec, seedHex } = decodeItemId(providerItemId);
    const { transactions } = generateHistory(spec, seedHex, this.clock());
    return transactions.filter((t) => t.date >= range.from && t.date <= range.to);
  }
}

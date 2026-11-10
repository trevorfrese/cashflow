import { createHash } from 'node:crypto';

import type { BankLinkProvider, LinkedAccount } from './types.ts';

const INSTITUTIONS = [
  'First Street Bank',
  'Harbor Credit Union',
  'Meridian Bank',
  'Oak & Main Savings',
];

/**
 * Deterministic fake bank. The public token picks the institution and balance so demos and
 * tests are repeatable. Special tokens:
 *   mock_low_balance  -> balance of $500
 *   mock_no_balance   -> balance unknown (null)
 *   mock_fail         -> exchange fails
 * Any account token this provider returns contains "mock_acct_" and the MockPaymentsProvider
 * charges it successfully unless the token also contains "fail".
 */
export class MockBankLinkProvider implements BankLinkProvider {
  readonly name = 'mock';

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
    let availableBalanceCents: number | null = 800_000 + (digest.readUInt32BE(3) % 2_500_000);
    if (publicToken.includes('low_balance')) availableBalanceCents = 50_000;
    if (publicToken.includes('no_balance')) availableBalanceCents = null;
    return {
      providerItemId: `mock_item_${digest.subarray(8, 14).toString('hex')}`,
      providerAccountToken: `mock_acct_${digest.subarray(14, 22).toString('hex')}`,
      institutionName: institution,
      accountMask: mask,
      availableBalanceCents,
    };
  }

  async refreshBalance(providerItemId: string): Promise<number | null> {
    const digest = createHash('sha256').update(providerItemId).digest();
    return 800_000 + (digest.readUInt32BE(0) % 2_500_000);
  }
}

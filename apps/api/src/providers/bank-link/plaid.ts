import type { Config } from '../../config.ts';
import type { BankLinkProvider, LinkedAccount } from './types.ts';

/**
 * Skeleton for a Plaid sandbox adapter. It compiles against the interface and documents the
 * calls a real implementation makes, but it carries no SDK dependency and refuses to run
 * without sandbox credentials. Filling it in is a contained task:
 *
 *   pnpm --filter @cashflow/api add plaid
 *   createLinkToken  -> plaid.linkTokenCreate({ user: { client_user_id }, products: ['auth', 'transactions'], ... })
 *   exchangePublicToken -> plaid.itemPublicTokenExchange({ public_token }) then accountsBalanceGet
 *   refreshBalance   -> plaid.accountsBalanceGet({ access_token })
 *
 * The Plaid access token belongs in `providerAccountToken`. For ACH debits you would also
 * create a processor token for your PaymentsProvider (Stripe: processorStripeBankAccountTokenCreate).
 */
export class PlaidBankLinkProvider implements BankLinkProvider {
  readonly name = 'plaid';

  constructor(config: Config) {
    if (!config.PLAID_CLIENT_ID || !config.PLAID_SECRET) {
      throw new Error('BANK_LINK_PROVIDER=plaid requires PLAID_CLIENT_ID and PLAID_SECRET');
    }
    if (config.PLAID_ENV !== 'sandbox') {
      throw new Error(
        'This project only supports PLAID_ENV=sandbox. It never touches real bank data.',
      );
    }
  }

  async createLinkToken(_businessId: string): Promise<{ linkToken: string }> {
    throw new Error(
      'PlaidBankLinkProvider.createLinkToken is not implemented. See the notes in plaid.ts.',
    );
  }

  async exchangePublicToken(_publicToken: string): Promise<LinkedAccount> {
    throw new Error(
      'PlaidBankLinkProvider.exchangePublicToken is not implemented. See the notes in plaid.ts.',
    );
  }

  async refreshBalance(_providerItemId: string): Promise<number | null> {
    throw new Error(
      'PlaidBankLinkProvider.refreshBalance is not implemented. See the notes in plaid.ts.',
    );
  }
}

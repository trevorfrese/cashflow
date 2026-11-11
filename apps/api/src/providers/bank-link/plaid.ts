import type { BankTransaction, VisibleBankAccount } from '@cashflow/shared';

import type { Config } from '../../config.ts';
import type {
  BankAccountIdentity,
  BankCredentials,
  BankLinkProvider,
  ItemStatus,
  LinkedAccount,
  TransactionRange,
} from './types.ts';

const notImplemented = (method: string) =>
  new Error(`PlaidBankLinkProvider.${method} is not implemented. See the notes in plaid.ts.`);

/**
 * Skeleton for a Plaid sandbox adapter. It compiles against the interface and documents the
 * calls a real implementation makes, but it carries no SDK dependency and refuses to run
 * without sandbox credentials and a token encryption key. NOT EXERCISED: nothing below has
 * been run against Plaid. Filling it in is a contained task:
 *
 *   pnpm --filter @cashflow/api add plaid
 *   createLinkToken     -> linkTokenCreate({ user: { client_user_id }, products: ['transactions', 'auth'],
 *                          required_if_supported_products: ['identity'], redirect_uri (for OAuth banks) })
 *                          Large banks (Chase, Wells Fargo, Bank of America, Capital One...) connect
 *                          through the bank's own OAuth. Link handles it with the redirect_uri.
 *   exchangePublicToken -> itemPublicTokenExchange({ public_token }) -> access_token (encrypt it),
 *                          then accountsGet for the chosen account's mask and itemGet for consent.
 *   refreshBalance      -> accountsBalanceGet({ access_token })
 *   getTransactions     -> transactionsSync with a stored cursor (or transactionsGet), mapping
 *                          personal_finance_category onto TransactionCategory (bank-data.ts).
 *   getIdentity         -> identityGet: accounts[].owners[].names, plus accounts[].subtype
 *                          (business accounts are reported by most OAuth banks). Open date is
 *                          not part of Identity; where it matters, Plaid's account history in
 *                          Assets (assetReportCreate, days_requested) is the nearest product.
 *   listAccounts        -> accountsGet: every account on the item. Link's account select
 *                          decides which are "shared"; the item still lists the others.
 *   getItemStatus       -> itemGet: item.error (ITEM_LOGIN_REQUIRED means reconnect through
 *                          Link update mode), consent_expiration_time, and whether the
 *                          institution is an OAuth institution (institutionsGetById, oauth).
 *   revoke              -> itemRemove({ access_token })
 *
 * The access token is a platform-issued credential: it is stored only through the token vault
 * (`src/crypto/token-vault.ts`) and never logged. For ACH debits you would also create a
 * processor token for the PaymentsProvider (Stripe: processorStripeBankAccountTokenCreate),
 * which is what `providerAccountToken` holds. There is no credentialed (password) path.
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
    if (!config.CONNECTION_TOKEN_KEY) {
      throw new Error('BANK_LINK_PROVIDER=plaid requires CONNECTION_TOKEN_KEY');
    }
  }

  async createLinkToken(_businessId: string): Promise<{ linkToken: string }> {
    throw notImplemented('createLinkToken');
  }

  async exchangePublicToken(_publicToken: string): Promise<LinkedAccount> {
    throw notImplemented('exchangePublicToken');
  }

  async refreshBalance(_providerItemId: string): Promise<number | null> {
    throw notImplemented('refreshBalance');
  }

  async getTransactions(
    _providerItemId: string,
    _range: TransactionRange,
  ): Promise<BankTransaction[]> {
    throw notImplemented('getTransactions');
  }

  async getIdentity(_credentials: BankCredentials): Promise<BankAccountIdentity> {
    throw notImplemented('getIdentity');
  }

  async listAccounts(_credentials: BankCredentials): Promise<VisibleBankAccount[]> {
    throw notImplemented('listAccounts');
  }

  async getItemStatus(_credentials: BankCredentials): Promise<ItemStatus> {
    throw notImplemented('getItemStatus');
  }

  async revoke(_credentials: BankCredentials): Promise<void> {
    throw notImplemented('revoke');
  }
}

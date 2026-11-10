import type { BankTransaction, IsoDate } from '@cashflow/shared';

export interface LinkedAccount {
  /** Provider's id for the connection (Plaid item id, for example). */
  providerItemId: string;
  /** Opaque token the PaymentsProvider can debit. Stored, never shown to clients. */
  providerAccountToken: string;
  institutionName: string;
  accountMask: string;
  availableBalanceCents: number | null;
}

export interface TransactionRange {
  from: IsoDate;
  to: IsoDate;
}

/**
 * Connects a business bank account and reads balances and transactions for underwriting
 * and collections. Shaped after Plaid: create a link token, the client completes Link,
 * exchange the resulting public token for a durable connection, then pull data by item id.
 */
export interface BankLinkProvider {
  readonly name: string;
  createLinkToken(businessId: string): Promise<{ linkToken: string }>;
  exchangePublicToken(publicToken: string): Promise<LinkedAccount>;
  refreshBalance(providerItemId: string): Promise<number | null>;
  /** Posted transactions in the range, oldest first. Underwriting asks for the last 12 months. */
  getTransactions(providerItemId: string, range: TransactionRange): Promise<BankTransaction[]>;
}

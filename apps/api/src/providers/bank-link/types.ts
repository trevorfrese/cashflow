export interface LinkedAccount {
  /** Provider's id for the connection (Plaid item id, for example). */
  providerItemId: string;
  /** Opaque token the PaymentsProvider can debit. Stored, never shown to clients. */
  providerAccountToken: string;
  institutionName: string;
  accountMask: string;
  availableBalanceCents: number | null;
}

/**
 * Connects a business bank account and reads balances for underwriting and collections.
 * Shaped after Plaid Link: create a link token, the client completes Link, exchange the
 * resulting public token for a durable connection.
 */
export interface BankLinkProvider {
  readonly name: string;
  createLinkToken(businessId: string): Promise<{ linkToken: string }>;
  exchangePublicToken(publicToken: string): Promise<LinkedAccount>;
  refreshBalance(providerItemId: string): Promise<number | null>;
}

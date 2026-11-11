import type {
  BankAccountType,
  BankTransaction,
  IsoDate,
  VisibleBankAccount,
} from '@cashflow/shared';

export interface LinkedAccount {
  /** Provider's id for the connection (Plaid item id, for example). */
  providerItemId: string;
  /** Opaque token the PaymentsProvider can debit. Stored, never shown to clients. */
  providerAccountToken: string;
  institutionName: string;
  accountMask: string;
  availableBalanceCents: number | null;
  /**
   * The aggregator's access token for the item. Encrypted before it is stored and never
   * returned, logged, or written to an audit payload.
   */
  accessToken: string | null;
  /** The bank authorized the connection through its own OAuth. Null when unknown. */
  institutionAuthorized: boolean | null;
  /** Read-only products consented to. */
  scopes: string[];
  /** When the consent lapses and the owner must reconnect, where the bank sets one. */
  consentExpiresAt: Date | null;
}

export interface BankCredentials {
  providerItemId: string;
  /** Decrypted for the call and dropped. Null on links made before tokens were stored. */
  accessToken: string | null;
}

/** What the bank reports about the account itself. Never what the applicant typed. */
export interface BankAccountIdentity {
  platformAccountId: string | null;
  /** Account holder names on the bank's record. Empty when the bank gave none. */
  ownerNames: string[];
  accountType: BankAccountType | null;
  openedOn: IsoDate | null;
}

export interface ItemStatus {
  health: 'HEALTHY' | 'REAUTH_REQUIRED' | 'ERROR';
  institutionAuthorized: boolean | null;
  consentExpiresAt: Date | null;
  error: string | null;
}

/**
 * Only the sandbox reads this: the mock bank has no real account holder, so it is told the
 * business's names when it is linked and reports them back as the bank would. A real adapter
 * ignores it: the names it reports come from the bank.
 */
export interface SandboxHolder {
  legalName: string;
  ownerNames: string[];
}

export interface TransactionRange {
  from: IsoDate;
  to: IsoDate;
}

/** The connection needs the owner to reconnect. Nothing from the failed call is used. */
export class ReauthRequiredError extends Error {
  constructor(message = 'The bank connection needs to be reauthorized') {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

/**
 * Connects a business bank account through an aggregator and reads it for underwriting and
 * collections. Shaped after Plaid: create a link token, the client completes Link (OAuth at
 * the bank for the institutions that support it), exchange the public token for a durable
 * item, then read by item.
 *
 * Beyond transactions it reports what veracity needs: the account holder and account type,
 * when the account was opened, every account visible on the login (so one cannot be hidden
 * by sharing another), whether the bank authorized the connection through OAuth, and the
 * item's health. There is no credentialed login path: CashFlow never holds a bank password.
 */
export interface BankLinkProvider {
  readonly name: string;
  createLinkToken(businessId: string): Promise<{ linkToken: string }>;
  exchangePublicToken(publicToken: string, sandbox?: SandboxHolder): Promise<LinkedAccount>;
  refreshBalance(providerItemId: string): Promise<number | null>;
  /** Posted transactions in the range, oldest first. Underwriting asks for the last 13 months. */
  getTransactions(providerItemId: string, range: TransactionRange): Promise<BankTransaction[]>;
  getIdentity(credentials: BankCredentials): Promise<BankAccountIdentity>;
  /** Every account on the login, shared or not. */
  listAccounts(credentials: BankCredentials): Promise<VisibleBankAccount[]>;
  getItemStatus(credentials: BankCredentials): Promise<ItemStatus>;
  /** Ends the aggregator's access to the item. */
  revoke(credentials: BankCredentials): Promise<void>;
}

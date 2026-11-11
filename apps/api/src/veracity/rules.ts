import type {
  ConnectionActionCode,
  VeracityCheck,
  VeracityConsequence,
  VeracitySeverity,
} from '@cashflow/shared';

/**
 * The one place that says what each veracity finding does.
 *
 * The rule of thumb is the integrity checks': decline automatically only on a pattern with no
 * innocent reading; send to a person what an honest business can show; ask the owner when the
 * owner can fix it; and when a source cannot be trusted, stop counting it and fall back to
 * the other one rather than punish the applicant. A missing or failed connection is never a
 * decline on its own. The measured false positive and detection rates behind each choice are
 * in `apps/api/evals/report.md`, "Veracity".
 *
 * Owner wording is specific and plain, never accusatory, and never names a rule.
 */
export interface VeracityRule {
  check: VeracityCheck;
  severity: VeracitySeverity;
  consequence: VeracityConsequence;
  /** The source stops counting toward verified revenue, whatever else happens. */
  excludesSource: boolean;
  why: string;
  customerMessage: string | null;
  customerAction: ConnectionActionCode | null;
}

const REVIEW =
  'We are taking a closer look at the accounts you connected. We will be in touch if we need anything.';

export const VERACITY_RULES = {
  // ---------- Ownership ----------
  BOTH_SOURCES_OTHER_BUSINESS: {
    check: 'OWNERSHIP',
    severity: 'CRITICAL',
    consequence: 'KNOCKOUT',
    excludesSource: true,
    why: "The bank says the account is held by another business and the platform names another business too. Two independent sources agreeing that the data is someone else's has no innocent reading worth an automatic approval, and a reviewer cannot fix it: the owner has to connect their own accounts.",
    customerMessage:
      "We could not confirm that the connected accounts are held in your business's name. Connect accounts in your business's name, or contact support and we will help.",
    customerAction: 'CONTACT_SUPPORT',
  },
  BANK_OWNER_MISMATCH: {
    check: 'OWNERSHIP',
    severity: 'HIGH',
    consequence: 'REFER',
    excludesSource: false,
    why: 'The account holder the bank reports is neither the business nor a listed owner. Spouses, holding companies and unlisted partners are common innocent readings, so a person looks.',
    customerMessage: REVIEW,
    customerAction: null,
  },
  PLATFORM_NAME_MISMATCH: {
    check: 'OWNERSHIP',
    severity: 'HIGH',
    consequence: 'REFER',
    excludesSource: true,
    why: 'The legal name on the platform account matches neither the legal name nor the trading name. A previous company name or a parent company is the common innocent reading. Its sales are not counted until a person has looked.',
    customerMessage: REVIEW,
    customerAction: null,
  },
  PLATFORM_TAX_ID_MISMATCH: {
    check: 'OWNERSHIP',
    severity: 'HIGH',
    consequence: 'REFER',
    excludesSource: true,
    why: 'The platform reports a tax id ending in different digits. A typo is possible on either side.',
    customerMessage: REVIEW,
    customerAction: null,
  },
  PERSONAL_ACCOUNT: {
    check: 'OWNERSHIP',
    severity: 'LOW',
    consequence: 'INFORM',
    excludesSource: false,
    why: "A personal account in a listed owner's name. Normal for a sole proprietor; recorded.",
    customerMessage: null,
    customerAction: null,
  },

  // ---------- Payout destination ----------
  PAYOUT_ACCOUNT_NOT_CONNECTED: {
    check: 'PAYOUT_DESTINATION',
    severity: 'MEDIUM',
    consequence: 'NEEDS_INFO',
    excludesSource: true,
    why: 'The platform pays every payout into an account that is not connected: the sales are real, but the money goes where we cannot see it. The owner can fix it in a minute by connecting that account, so ask.',
    customerMessage:
      'We could not match the bank account your sales are paid into with a connected account. Connect that account to continue.',
    customerAction: 'CONNECT_PAYOUT_ACCOUNT',
  },
  PAYOUTS_PARTLY_TO_UNSEEN_ACCOUNT: {
    check: 'PAYOUT_DESTINATION',
    severity: 'HIGH',
    consequence: 'NEEDS_INFO',
    excludesSource: true,
    why: 'A material share of payouts goes to an account that is not connected. Honest businesses split payouts by location; routing sales away from the account we underwrite is also how revenue is padded. Either way the owner can settle it by connecting that account, so ask. (A first run referred it: seed 1 let 30% of such fraud through review.)',
    customerMessage:
      'Some of your sales are paid into a bank account that is not connected. Connect that account to continue.',
    customerAction: 'CONNECT_PAYOUT_ACCOUNT',
  },

  // ---------- Settlement reconciliation ----------
  SETTLEMENT_UNMATCHED: {
    check: 'SETTLEMENT',
    severity: 'HIGH',
    consequence: 'REFER',
    excludesSource: true,
    why: 'Fewer than half of the payouts the platform says it sent to a connected account arrived there. Either the platform data or the account is not what it seems.',
    customerMessage: REVIEW,
    customerAction: null,
  },
  SETTLEMENT_LOW_MATCH: {
    check: 'SETTLEMENT',
    severity: 'MEDIUM',
    consequence: 'EXCLUDE_SOURCE',
    excludesSource: true,
    why: 'Payouts reconcile, but not well enough to rely on platform sales as revenue. Revenue falls back to the bank figure; nothing else changes.',
    customerMessage: null,
    customerAction: null,
  },
  DEPOSITS_WITHOUT_PAYOUT: {
    check: 'SETTLEMENT',
    severity: 'HIGH',
    consequence: 'REFER',
    excludesSource: true,
    why: 'Deposits that name the platform but match no payout it reports: revenue that claims a source the source has no record of.',
    customerMessage: REVIEW,
    customerAction: null,
  },

  // ---------- Completeness ----------
  SALES_NOT_PAID_OUT: {
    check: 'COMPLETENESS',
    severity: 'HIGH',
    consequence: 'REFER',
    excludesSource: true,
    why: 'The platform reports far more card sales than it ever paid out: sales that do not settle. Holds and reserves explain a little, not this much.',
    customerMessage: REVIEW,
    customerAction: null,
  },
  POS_REVENUE_NOT_IN_BANK: {
    check: 'COMPLETENESS',
    severity: 'MEDIUM',
    consequence: 'EXCLUDE_SOURCE',
    excludesSource: true,
    why: 'Without payout data from the platform, its card sales run well above what reaches any connected account. Use the bank figure.',
    customerMessage: null,
    customerAction: null,
  },
  TRANSFERS_TO_UNSEEN_ACCOUNTS: {
    check: 'COMPLETENESS',
    severity: 'MEDIUM',
    consequence: 'NEEDS_INFO',
    excludesSource: false,
    why: 'Sustained, material transfers out to accounts that are not connected. Saving profit is the innocent reading; paying debts from an account we were not shown is the other. Only the owner can tell them apart, by connecting the account, so ask. (A first run referred it: review let 30% of hidden account fraud through.)',
    customerMessage:
      'Money moves regularly from this account to an account that is not connected. Connect that account to continue.',
    customerAction: 'SHARE_ACCOUNTS',
  },
  UNSHARED_ACCOUNTS: {
    check: 'COMPLETENESS',
    severity: 'LOW',
    consequence: 'INFORM',
    excludesSource: false,
    why: 'Other accounts are visible on the same login and were not shared. Most businesses keep a savings account; recorded for the reviewer and for the transfer check.',
    customerMessage: null,
    customerAction: null,
  },
  TRANSFERS_FROM_UNSEEN_ACCOUNTS: {
    check: 'COMPLETENESS',
    severity: 'LOW',
    consequence: 'INFORM',
    excludesSource: false,
    why: 'Money comes in regularly from an account that is not connected. The integrity checks already score non sales credits; recorded.',
    customerMessage: null,
    customerAction: null,
  },

  // ---------- Consistency over time ----------
  HISTORY_REWRITTEN: {
    check: 'CONSISTENCY',
    severity: 'CRITICAL',
    consequence: 'KNOCKOUT',
    excludesSource: true,
    why: 'A later pull removed debits from days that were already final, and added nothing. Late posting is confined to the last few days, which the check forgives; aggregator re-syncs change ids and labels, which it ignores, and can duplicate items, which is an addition and goes to HISTORY_CHANGED. Posted overdraft fees and loan payments vanishing from a closed period has no innocent reading. (A first run also knocked out flattering additions: duplicated credits from honest re-syncs were declined.)',
    customerMessage:
      'We could not verify the account history we received. Contact support and we will help you finish your application.',
    customerAction: 'CONTACT_SUPPORT',
  },
  HISTORY_CHANGED: {
    check: 'CONSISTENCY',
    severity: 'HIGH',
    consequence: 'REFER',
    excludesSource: false,
    why: 'Material changes to final history that do not all point one way: a bank correction or an aggregator fault is possible. A person compares the pulls.',
    customerMessage: REVIEW,
    customerAction: null,
  },
  SALES_HISTORY_CHANGED: {
    check: 'CONSISTENCY',
    severity: 'HIGH',
    consequence: 'REFER',
    excludesSource: true,
    why: 'The platform reported different sales for days that were final at the earlier pull.',
    customerMessage: REVIEW,
    customerAction: null,
  },
  HISTORY_MINOR_CHANGES: {
    check: 'CONSISTENCY',
    severity: 'LOW',
    consequence: 'INFORM',
    excludesSource: false,
    why: 'A few final items changed, below materiality. Recorded so a pattern across pulls is visible.',
    customerMessage: null,
    customerAction: null,
  },

  // ---------- Account age and continuity ----------
  PLATFORM_NEW_WITH_SURGE: {
    check: 'ACCOUNT_AGE',
    severity: 'HIGH',
    consequence: 'REFER',
    excludesSource: true,
    why: 'A platform account opened recently by a business that claims to be established, and bank revenue jumped when it opened. A platform switch keeps revenue level; a burst of fresh volume does not.',
    customerMessage: REVIEW,
    customerAction: null,
  },
  PLATFORM_ACCOUNT_RECENT: {
    check: 'ACCOUNT_AGE',
    severity: 'LOW',
    consequence: 'REDUCE_DEPTH',
    excludesSource: false,
    why: 'A young platform account cannot corroborate a long history. Usually a platform switch: no penalty beyond not counting it as a second source.',
    customerMessage: null,
    customerAction: null,
  },
  BANK_ACCOUNT_RECENT: {
    check: 'ACCOUNT_AGE',
    severity: 'LOW',
    consequence: 'INFORM',
    excludesSource: false,
    why: 'A recently opened account at an established business: usually a bank switch. The short history is already scored and checked (SHORT_ACCOUNT_HISTORY).',
    customerMessage: null,
    customerAction: null,
  },
  DATA_GAP: {
    check: 'ACCOUNT_AGE',
    severity: 'LOW',
    consequence: 'INFORM',
    excludesSource: false,
    why: 'Two weeks or more with no transactions inside the history. Closures and holidays happen; recorded.',
    customerMessage: null,
    customerAction: null,
  },

  // ---------- Freshness ----------
  BANK_DATA_UNAVAILABLE: {
    check: 'FRESHNESS',
    severity: 'MEDIUM',
    consequence: 'NEEDS_INFO',
    excludesSource: false,
    why: 'The bank could not be pulled fresh at decision time. We never decide on stale data, and never decline for a connection problem: ask the owner to reconnect.',
    customerMessage:
      'We could not refresh the data from your bank. Reconnect your bank account to continue.',
    customerAction: 'RECONNECT',
  },
  PLATFORM_DATA_UNAVAILABLE: {
    check: 'FRESHNESS',
    severity: 'LOW',
    consequence: 'EXCLUDE_SOURCE',
    excludesSource: true,
    why: 'The platform could not be pulled fresh. The decision uses the bank alone rather than stale platform data, and the owner is asked to reconnect.',
    customerMessage:
      'We could not refresh your point of sale data, so we used your bank data alone. Reconnect it to include your sales.',
    customerAction: 'RECONNECT',
  },

  // ---------- Method strength ----------
  LEGACY_BANK_CONNECTION: {
    check: 'METHOD',
    severity: 'LOW',
    consequence: 'REDUCE_DEPTH',
    excludesSource: false,
    why: "The bank connection was not authorized through the bank's own OAuth. The data is still the bank's, through a weaker channel: three quarters of the data depth credit.",
    customerMessage: null,
    customerAction: null,
  },
  DELEGATED_SEAT_SOURCE: {
    check: 'METHOD',
    severity: 'LOW',
    consequence: 'INFORM',
    excludesSource: false,
    why: 'Sales read through a delegated read-only seat rather than an API: trust tier MEDIUM, still a second source when it reconciles.',
    customerMessage: null,
    customerAction: null,
  },
} as const satisfies Record<string, VeracityRule>;

export type VeracityCode = keyof typeof VERACITY_RULES;

export const VERACITY_CODES = Object.keys(VERACITY_RULES) as VeracityCode[];

/** Worst first. */
export const CONSEQUENCE_ORDER: readonly VeracityConsequence[] = [
  'KNOCKOUT',
  'NEEDS_INFO',
  'REFER',
  'CAP',
  'EXCLUDE_SOURCE',
  'REDUCE_DEPTH',
  'INFORM',
];

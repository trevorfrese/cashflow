import { z } from 'zod';

/**
 * The reason catalog: every principal reason the underwriting engine, the integrity and
 * veracity checks, identity verification, and a reviewer can give an applicant, in one place.
 *
 * Each entry has a stable code (stored on decisions and notices, never renamed), a short
 * title and plain applicant text, guidance on what would change the outcome, whether it may
 * be stated as a principal reason on an adverse action notice, and which part of the
 * engine produces it. The engine renders the specific text for its own reasons at decision
 * time, with the applicant's numbers in it ("Verified revenue of $4,100 a month is below our
 * $5,000 minimum"). The catalog text is used where no specific text exists: a reviewer's
 * pick, or a decision stored before this catalog.
 *
 * Applicant text and guidance are written for the owner: no rule names, no internal terms,
 * no basis points. `INTERNAL_JARGON` below is the test for that.
 *
 * Regulation B (12 CFR 1002.9(b)(2)) requires the specific principal reasons for adverse
 * action. "Insufficient score" and "internal standards" are not specific reasons, so the
 * overall score is never a principal reason: it is expanded into the factors that lost the
 * most points (see `principal.ts`).
 */

/** What a reason is about, and so where it can appear. */
export const ReasonKind = z.enum([
  /** A rule that declines on its own: a credit rule, a capacity limit, a trust check. */
  'DECLINE',
  /** Why an approval is for less than the rent requested. */
  'COUNTER_OFFER',
  /** A scorecard factor. Helps or hurts; never declines alone. */
  'FACTOR',
  /** Something the applicant is asked to provide. */
  'NEEDS_INFO',
  /** A headline or status line. Never a principal reason. */
  'STATUS',
]);
export type ReasonKind = z.infer<typeof ReasonKind>;

/** Which part of underwriting produces the reason. */
export const ReasonSource = z.enum([
  'CREDIT_RULE',
  'CAPACITY',
  'SCORECARD',
  'INTEGRITY',
  'VERACITY',
  'IDENTITY',
  'INFORMATION',
  'REVIEWER',
  'STATUS',
]);
export type ReasonSource = z.infer<typeof ReasonSource>;

/** The review actions a reviewer may pick a reason for. */
export const ReviewerReasonAction = z.enum(['DECLINE', 'REQUEST_INFO']);
export type ReviewerReasonAction = z.infer<typeof ReviewerReasonAction>;

export interface ReasonCatalogEntry {
  code: string;
  /** Short plain label, for example "Cash buffer". */
  title: string;
  /** Plain text for the applicant, used when the engine has no specific text for it. */
  applicantText: string;
  /** What would change the outcome. Specific and actionable. */
  guidance: string;
  /** For a scorecard factor: what it measures, in a sentence. */
  measures?: string;
  /** May be stated as a principal reason on an adverse action notice. */
  adverseActionEligible: boolean;
  kind: ReasonKind;
  source: ReasonSource;
  /** Internal: the rule or factor that produces it. Never shown to the applicant. */
  producedBy: string;
  /**
   * The scorecard factor this rule restates, if any. A factor already covered by a rule
   * that declined is not listed again as a separate principal reason.
   */
  relatedFactor: string | null;
  /** Review actions a reviewer may pick this reason for. Empty: not a reviewer pick. */
  reviewerActions: readonly ReviewerReasonAction[];
}

const DECLINE_PICK = ['DECLINE'] as const;
const INFO_PICK = ['REQUEST_INFO'] as const;
const NONE = [] as const;

export const REASON_CATALOG = [
  // ---- Credit rules: decline on their own ----
  {
    code: 'TIME_IN_BUSINESS',
    title: 'Time in business',
    applicantText: 'The business has not been operating long enough for us to front rent.',
    guidance:
      'Apply again when the business has been operating longer. If the months in business on your application are wrong, correct them and apply again.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CREDIT_RULE',
    producedBy: 'engine.ts: minimum months in business',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'REVENUE_TOO_LOW',
    title: 'Monthly revenue',
    applicantText: 'Verified monthly revenue is below the minimum we need to front rent.',
    guidance:
      'Connect every account that receives your sales so all of your revenue is counted, or apply again when monthly revenue has grown.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CREDIT_RULE',
    producedBy: 'engine.ts: minimum verified revenue',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'EXCESSIVE_OVERDRAFTS',
    title: 'Overdraft fees',
    applicantText:
      'The account was charged too many overdraft or returned item fees in the last 90 days.',
    guidance:
      'Keep the balance above zero so that no overdraft or returned item fees are charged for three months, then apply again.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CREDIT_RULE',
    producedBy: 'engine.ts: overdraft fees in 90 days',
    relatedFactor: 'ACCOUNT_CONDUCT',
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'NEGATIVE_BALANCE_DAYS',
    title: 'Days overdrawn',
    applicantText: 'The account was overdrawn on too many days in the last 90 days.',
    guidance: 'Keep the account balance above zero for three months, then apply again.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CREDIT_RULE',
    producedBy: 'engine.ts: negative balance days in 90 days',
    relatedFactor: 'ACCOUNT_CONDUCT',
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'RENT_EXCEEDS_REVENUE_SHARE',
    title: 'Rent compared with revenue',
    applicantText: 'The rent requested is too large a share of verified monthly revenue.',
    guidance:
      'Connect any other account that receives your sales so all of your revenue is counted, or apply for a lease with a lower rent.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CREDIT_RULE',
    producedBy: 'engine.ts: maximum rent to revenue',
    relatedFactor: 'RENT_TO_REVENUE',
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'REVENUE_DECLINING',
    title: 'Falling revenue',
    applicantText: 'Revenue has fallen sharply in recent months.',
    guidance:
      'Apply again once revenue has steadied. If the drop is seasonal, connecting an account with more than a year of history lets us compare the same weeks a year earlier.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CREDIT_RULE',
    producedBy: 'engine.ts: quarter over quarter decline, and detectDecline',
    relatedFactor: 'REVENUE_TREND',
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'DECLINE_WITH_THIN_BUFFER',
    title: 'Falling revenue with little cash on hand',
    applicantText:
      'Revenue is falling and there is little cash in the account to absorb a further drop.',
    guidance: 'Build up the cash balance, or wait until revenue steadies, then apply again.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CREDIT_RULE',
    producedBy: 'engine.ts: detectDecline with a thin buffer',
    relatedFactor: 'REVENUE_TREND',
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'NEGATIVE_FREE_CASH_FLOW',
    title: 'No cash left after expenses',
    applicantText:
      'After operating expenses, owner draws and existing debt payments, the business is not left with cash to repay rent.',
    guidance:
      'Apply again when monthly deposits are clearly more than monthly spending, debt payments and owner draws together.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CREDIT_RULE',
    producedBy: 'engine.ts: free cash flow at or below zero',
    relatedFactor: 'CASH_FLOW_COVERAGE',
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'SCORE_BELOW_MINIMUM',
    title: 'Overall cash flow strength',
    applicantText:
      'Taken together, the cash flow measures marked as hurting fell short of what we need to approve.',
    guidance: 'Improving the measures marked as hurting is what would change the outcome.',
    // Not a specific reason under Regulation B: it is expanded into the factors that lost
    // the most points.
    adverseActionEligible: false,
    kind: 'DECLINE',
    source: 'SCORECARD',
    producedBy: 'engine.ts: minimum score',
    relatedFactor: null,
    reviewerActions: NONE,
  },

  // ---- Capacity, price and exposure ----
  {
    code: 'INSUFFICIENT_CAPACITY',
    title: 'Room for the rent in your cash flow',
    applicantText:
      'The cash left after expenses and debt does not cover the rent requested with a margin of safety.',
    guidance:
      'A lower rent, lower debt payments or higher monthly deposits would change this. Connect any other account that receives your sales so all of your revenue is counted.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CAPACITY',
    producedBy: 'engine.ts: capacityCents and the counter offer floor',
    relatedFactor: 'CASH_FLOW_COVERAGE',
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'EXPOSURE_LIMIT_REACHED',
    title: 'Rent already with us',
    applicantText:
      'Your business already has as much rent with us as we can front for one business right now.',
    guidance:
      'The amount we can front rises as you complete rent periods on time. Apply again after more on time periods.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CAPACITY',
    producedBy: 'exposure.ts: ladder and business aggregate',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'EXPOSURE_LIMIT',
    title: 'Amount for a new customer',
    applicantText:
      'The rent requested is well above what we can front for a business at this stage.',
    guidance:
      'The amount we can front rises with on time rent periods. A lease with a lower rent could be approved now.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CAPACITY',
    producedBy: 'exposure.ts: ladder cap binding below half the request',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'RENT_BELOW_MINIMUM',
    title: 'Rent too small to serve',
    applicantText:
      'The rent is too small for our fee to cover the fixed cost of running a plan without going above the most we charge.',
    guidance:
      'This is about the size of the rent, not about your business. A lease with a higher monthly rent can be served.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CAPACITY',
    producedBy: 'pricing.ts: minimum fee above the fee cap',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'FEE_ABOVE_MAXIMUM',
    title: 'Cost of the plan',
    applicantText:
      'The fee needed to cover the risk and cost of this plan would be above the most we charge.',
    guidance:
      'Improving the measures marked as hurting would lower the fee needed. Apply again when they improve.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CAPACITY',
    producedBy: 'pricing.ts: required fee above the fee cap',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'RENT_NOT_VERIFIED',
    title: 'Rent not shown in your account',
    applicantText:
      'The rent requested is well above the rent payments we can see in your bank account.',
    guidance:
      'Connect the account you pay rent from, or contact support so a reviewer can verify your lease.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'CAPACITY',
    producedBy: 'exposure.ts: observed rent cap binding below half the request',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },

  // ---- Integrity checks ----
  {
    code: 'UNVERIFIED_DEPOSITS',
    title: 'Deposits we could not verify',
    applicantText:
      'Several large deposits were followed within days by transfers out of the same amount, so we could not count them as revenue.',
    guidance:
      'Contact support if these deposits have an explanation. Apply again with an account that shows your revenue as it comes in.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'INTEGRITY',
    producedBy: 'integrity.ts: ROUND_TRIP_DEPOSITS',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'LANDLORD_ACCOUNT_MATCH',
    title: 'Landlord account',
    applicantText:
      'The landlord payout account on your lease matches a bank account linked to your business.',
    guidance:
      "Rent has to be paid to the landlord. Update the lease with the landlord's own payout account and apply again.",
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'INTEGRITY',
    producedBy: 'integrity.ts: LANDLORD_IS_APPLICANT_ACCOUNT',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'INTEGRITY_CHECK_FAILED',
    title: 'Information we could not verify',
    applicantText: 'We could not verify information in this application.',
    guidance:
      'Contact support and we will tell you what we could not verify and how to put it right.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'INTEGRITY',
    producedBy: 'integrity.ts: any other knockout flag',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },

  // ---- Identity ----
  {
    code: 'IDENTITY_NOT_VERIFIED',
    title: 'Business identity',
    applicantText: 'We could not verify the business details you gave us.',
    guidance:
      'Check the legal name, address, tax id and owners on your profile, or contact support and we will help you finish verification.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'IDENTITY',
    producedBy: 'integrity.ts: IDENTITY_VERIFICATION_FAILED, from the identity provider',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },

  // ---- Data veracity ----
  {
    code: 'ACCOUNT_OWNERSHIP_NOT_CONFIRMED',
    title: 'Account ownership',
    applicantText:
      "We could not confirm that the connected accounts are held in your business's name.",
    guidance: "Connect accounts held in your business's name, or contact support and we will help.",
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'VERACITY',
    producedBy: 'veracity/rules.ts: BOTH_SOURCES_OTHER_BUSINESS',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'ACCOUNT_HISTORY_NOT_VERIFIED',
    title: 'Account history',
    applicantText: 'We could not verify the account history we received.',
    guidance: 'Contact support and we will help you finish your application.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'VERACITY',
    producedBy: 'veracity/rules.ts: HISTORY_REWRITTEN',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },

  // ---- Reviewer declines ----
  {
    code: 'REVENUE_NOT_VERIFIED',
    title: 'Revenue we could not verify',
    applicantText:
      'We could not verify the revenue on your application from the accounts and records we reviewed.',
    guidance: 'Connect every account that receives your sales and apply again, or contact support.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'REVIEWER',
    producedBy: 'reviews.ts: reviewer pick',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'LEASE_NOT_VERIFIED',
    title: 'Lease we could not verify',
    applicantText: 'We could not verify the lease or the rent on it.',
    guidance:
      'Send a signed copy of the lease to support, or ask your landlord to confirm it, and apply again.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'REVIEWER',
    producedBy: 'reviews.ts: reviewer pick',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'APPLICATION_INCOMPLETE',
    title: 'Application incomplete',
    applicantText:
      'We did not receive the information we asked for, so we could not finish the application.',
    guidance: 'Provide the information listed and apply again.',
    adverseActionEligible: true,
    kind: 'DECLINE',
    source: 'INFORMATION',
    producedBy: 'adverse-action notices job, or reviews.ts: reviewer pick',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },

  // ---- Counter offer ----
  {
    code: 'LIMIT_BELOW_REQUEST',
    title: 'Approved for less than requested',
    applicantText: 'We can front less than the rent requested.',
    guidance:
      'A lease at or below the approved amount can start now. The amount rises with on time rent periods and stronger cash flow.',
    adverseActionEligible: true,
    kind: 'COUNTER_OFFER',
    source: 'CAPACITY',
    producedBy: 'engine.ts and exposure.ts: limit between half the request and the request',
    relatedFactor: null,
    reviewerActions: NONE,
  },

  // ---- Scorecard factors ----
  {
    code: 'RENT_TO_REVENUE',
    title: 'Rent affordability',
    measures: 'How large the rent is compared with your verified monthly revenue.',
    applicantText: 'The rent is a large share of verified monthly revenue.',
    guidance:
      'A lower rent, or counting all of your revenue by connecting every account that receives sales, would help.',
    adverseActionEligible: true,
    kind: 'FACTOR',
    source: 'SCORECARD',
    producedBy: 'scorecard.ts: rent affordability',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'CASH_FLOW_COVERAGE',
    title: 'Cash flow coverage',
    measures: 'How many times the cash left over each month covers the rent.',
    applicantText: 'The cash left over each month covers the rent by only a small margin.',
    guidance: 'Lower spending or debt payments, or higher deposits, would raise the margin.',
    adverseActionEligible: true,
    kind: 'FACTOR',
    source: 'SCORECARD',
    producedBy: 'scorecard.ts: cash flow coverage',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'CASH_BUFFER',
    title: 'Cash buffer',
    measures:
      'How many days of expenses the account holds, and how low it has fallen in the last 90 days.',
    applicantText: 'The account holds few days of expenses, or has run low in the last 90 days.',
    guidance: 'Keeping a larger balance, and not letting it run low, would help.',
    adverseActionEligible: true,
    kind: 'FACTOR',
    source: 'SCORECARD',
    producedBy: 'scorecard.ts: cash buffer',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'ACCOUNT_CONDUCT',
    title: 'Account conduct',
    measures: 'Overdraft fees and days overdrawn.',
    applicantText: 'The account has had overdraft fees or days overdrawn.',
    guidance: 'Three months without overdraft fees or days below zero would help.',
    adverseActionEligible: true,
    kind: 'FACTOR',
    source: 'SCORECARD',
    producedBy: 'scorecard.ts: account conduct',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'REVENUE_STABILITY',
    title: 'Revenue stability',
    measures: 'How much revenue varies from month to month.',
    applicantText: 'Monthly revenue varies widely from month to month.',
    guidance:
      'Steadier monthly revenue would help. Connecting your point of sale can show the pattern behind seasonal swings.',
    adverseActionEligible: true,
    kind: 'FACTOR',
    source: 'SCORECARD',
    producedBy: 'scorecard.ts: revenue stability',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'REVENUE_TREND',
    title: 'Revenue trend',
    measures:
      'Whether revenue is rising or falling, compared with the same weeks a year earlier when the history allows.',
    applicantText: 'Revenue has been falling.',
    guidance: 'Revenue that holds steady or grows over the next few months would help.',
    adverseActionEligible: true,
    kind: 'FACTOR',
    source: 'SCORECARD',
    producedBy: 'scorecard.ts: revenue trend',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'DEBT_LOAD',
    title: 'Existing debt',
    measures: 'Loan and merchant cash advance payments compared with revenue.',
    applicantText: 'Existing loan or cash advance payments take a large share of revenue.',
    guidance: 'Paying down loans or cash advances would help.',
    adverseActionEligible: true,
    kind: 'FACTOR',
    source: 'SCORECARD',
    producedBy: 'scorecard.ts: existing debt',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'DATA_DEPTH',
    title: 'Data history',
    measures:
      'How much account history we could review, and whether a second source confirms your sales.',
    applicantText:
      'We could review only a short account history, or could not confirm sales from a second source.',
    guidance: 'Connecting an account with a longer history, and your point of sale, would help.',
    adverseActionEligible: true,
    kind: 'FACTOR',
    source: 'SCORECARD',
    producedBy: 'scorecard.ts: data depth',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },
  {
    code: 'PAYMENT_HISTORY',
    title: 'Payment history',
    measures: 'How rent paid through CashFlow has gone.',
    applicantText: 'Some rent paid through CashFlow was late or missed.',
    guidance: 'Paying every month on time from here on would help.',
    adverseActionEligible: true,
    kind: 'FACTOR',
    source: 'SCORECARD',
    producedBy: 'payment-history.ts: payment history factor',
    relatedFactor: null,
    reviewerActions: DECLINE_PICK,
  },

  // ---- Information we need ----
  {
    code: 'BANK_LINK_REQUIRED',
    title: 'Bank account needed',
    applicantText: 'Connect your business bank account so we can verify revenue and cash flow.',
    guidance: 'Connect the account your sales are paid into, then run the decision again.',
    adverseActionEligible: true,
    kind: 'NEEDS_INFO',
    source: 'INFORMATION',
    producedBy: 'engine.ts: no bank data',
    relatedFactor: null,
    reviewerActions: INFO_PICK,
  },
  {
    code: 'INSUFFICIENT_HISTORY',
    title: 'More account history needed',
    applicantText: 'The connected account does not have enough months of transactions.',
    guidance: 'Connect the account that has received your revenue the longest.',
    adverseActionEligible: true,
    kind: 'NEEDS_INFO',
    source: 'INFORMATION',
    producedBy: 'engine.ts: minimum months of history',
    relatedFactor: null,
    reviewerActions: INFO_PICK,
  },
  {
    code: 'REVENUE_MISMATCH',
    title: 'Revenue does not match',
    applicantText:
      'The revenue on your application is well above what the connected accounts show.',
    guidance:
      'Connect any other accounts that receive revenue, or correct the revenue on your application.',
    adverseActionEligible: true,
    kind: 'NEEDS_INFO',
    source: 'INTEGRITY',
    producedBy: 'engine.ts: stated revenue far above verified',
    relatedFactor: null,
    reviewerActions: INFO_PICK,
  },
  {
    code: 'PAYOUT_ACCOUNT_NOT_CONNECTED',
    title: 'Payout account needed',
    applicantText: 'Your sales are paid into a bank account that is not connected.',
    guidance: 'Connect the account your point of sale pays into.',
    adverseActionEligible: true,
    kind: 'NEEDS_INFO',
    source: 'VERACITY',
    producedBy: 'veracity/rules.ts: payout destination findings',
    relatedFactor: null,
    reviewerActions: INFO_PICK,
  },
  {
    code: 'RECONNECT_REQUIRED',
    title: 'Reconnect your account',
    applicantText: 'We could not refresh the data from a connected account.',
    guidance: 'Reconnect the account, then run the decision again.',
    adverseActionEligible: true,
    kind: 'NEEDS_INFO',
    source: 'VERACITY',
    producedBy: 'veracity/rules.ts: BANK_DATA_UNAVAILABLE',
    relatedFactor: null,
    reviewerActions: INFO_PICK,
  },
  {
    code: 'CONNECTION_ACTION_NEEDED',
    title: 'Account action needed',
    applicantText: 'We need more information about the accounts you connected.',
    guidance: 'Follow the steps on the connections screen, or contact support.',
    adverseActionEligible: true,
    kind: 'NEEDS_INFO',
    source: 'VERACITY',
    producedBy: 'veracity/rules.ts: other findings that ask the owner',
    relatedFactor: null,
    reviewerActions: INFO_PICK,
  },
  {
    code: 'LEASE_DETAILS_NEEDED',
    title: 'Lease details',
    applicantText:
      'We need a copy of your lease, or a confirmation of the rent from your landlord.',
    guidance: 'Send the lease to support, or ask your landlord to confirm the rent.',
    adverseActionEligible: true,
    kind: 'NEEDS_INFO',
    source: 'REVIEWER',
    producedBy: 'reviews.ts: reviewer pick',
    relatedFactor: null,
    reviewerActions: INFO_PICK,
  },
  {
    code: 'BUSINESS_DETAILS_NEEDED',
    title: 'Business details',
    applicantText: 'We need you to confirm or correct the business details on your profile.',
    guidance: 'Check the legal name, address, tax id and owners on your profile.',
    adverseActionEligible: true,
    kind: 'NEEDS_INFO',
    source: 'REVIEWER',
    producedBy: 'reviews.ts: reviewer pick',
    relatedFactor: null,
    reviewerActions: INFO_PICK,
  },
  {
    code: 'INFO_REQUESTED',
    title: 'Information requested',
    applicantText: 'Our team needs more information to finish reviewing your application.',
    guidance: 'Provide what the reviewer asked for.',
    adverseActionEligible: false,
    kind: 'STATUS',
    source: 'REVIEWER',
    producedBy: 'reviews.ts: request information headline',
    relatedFactor: null,
    reviewerActions: NONE,
  },

  // ---- Headlines and status lines: never principal reasons ----
  {
    code: 'APPROVED',
    title: 'Approved',
    applicantText: 'Approved for the rent requested.',
    guidance: 'Link your lease to start the plan.',
    adverseActionEligible: false,
    kind: 'STATUS',
    source: 'STATUS',
    producedBy: 'engine.ts: approval headline',
    relatedFactor: null,
    reviewerActions: NONE,
  },
  {
    code: 'APPROVED_AFTER_REVIEW',
    title: 'Approved after review',
    applicantText: 'Approved after a review by our team.',
    guidance: 'Link your lease to start the plan.',
    adverseActionEligible: false,
    kind: 'STATUS',
    source: 'REVIEWER',
    producedBy: 'reviews.ts: approval headline',
    relatedFactor: null,
    reviewerActions: NONE,
  },
  {
    code: 'DECLINED_AFTER_REVIEW',
    title: 'Declined after review',
    applicantText: 'After a review by our team we could not approve this application.',
    guidance: 'The reasons listed are what would need to change.',
    adverseActionEligible: false,
    kind: 'STATUS',
    source: 'REVIEWER',
    producedBy: 'reviews.ts: decline headline',
    relatedFactor: null,
    reviewerActions: NONE,
  },
  {
    code: 'IN_REVIEW',
    title: 'In review',
    applicantText: 'Your application needs a look from our team before we can confirm terms.',
    guidance: 'Nothing to do now. We will ask if we need anything.',
    adverseActionEligible: false,
    kind: 'STATUS',
    source: 'STATUS',
    producedBy: 'engine.ts: referral headline',
    relatedFactor: null,
    reviewerActions: NONE,
  },
  {
    code: 'FUNDING_QUEUE',
    title: 'Start may wait',
    applicantText: 'The start of your plan may wait until we have room to fund it.',
    guidance: 'Nothing to do. We will start the plan as soon as there is room.',
    adverseActionEligible: false,
    kind: 'STATUS',
    source: 'CAPACITY',
    producedBy: 'exposure.ts: funding rules',
    relatedFactor: null,
    reviewerActions: NONE,
  },
  {
    code: 'DEPOSIT_MISMATCH',
    title: 'Deposits compared with sales',
    applicantText:
      'Your bank deposits cover less of your point of sale sales than expected, so we verified revenue from the bank.',
    guidance: 'Connect any other account that receives your sales.',
    adverseActionEligible: false,
    kind: 'STATUS',
    source: 'INTEGRITY',
    producedBy: 'engine.ts: coarse deposit match',
    relatedFactor: null,
    reviewerActions: NONE,
  },
] as const satisfies readonly ReasonCatalogEntry[];

export type ReasonCode = (typeof REASON_CATALOG)[number]['code'];
export const ReasonCode = z.enum(
  REASON_CATALOG.map((e) => e.code) as [ReasonCode, ...ReasonCode[]],
);

const BY_CODE: ReadonlyMap<string, ReasonCatalogEntry> = new Map(
  REASON_CATALOG.map((e) => [e.code, e as ReasonCatalogEntry]),
);

/** The catalog entry for a code, or undefined for a code the catalog does not know. */
export function catalogEntry(code: string): ReasonCatalogEntry | undefined {
  return BY_CODE.get(code);
}

/** Codes a reviewer may pick for a review action. */
export function reviewerReasonCodes(action: ReviewerReasonAction): ReasonCode[] {
  return REASON_CATALOG.filter((e) =>
    (e.reviewerActions as readonly ReviewerReasonAction[]).includes(action),
  ).map((e) => e.code);
}

/** The order factors appear in the catalog: the tie breaker when two lost the same points. */
export const FACTOR_CODES: readonly string[] = REASON_CATALOG.filter(
  (e) => e.kind === 'FACTOR',
).map((e) => e.code);

/**
 * Words and shapes that must never reach an applicant: rule and model terms, units of the
 * internal arithmetic, and identifiers. The catalog test and the engine test check every
 * applicant text against it.
 */
export const INTERNAL_JARGON: readonly RegExp[] = [
  /\bcut\s?off\b/i,
  /\bknock(?:ed)?[\s-]?out/i,
  /\bpolicy\b/i,
  /\bbps\b/i,
  /basis points?/i,
  /\bthreshold/i,
  /\bscorecard\b/i,
  /\bintegrity\b/i,
  /\bveracity\b/i,
  /\bheuristic/i,
  /\binternal standards?\b/i,
  /\bscore below\b/i,
  /\binsufficient score\b/i,
  /\bprobability of default\b/i,
  /\bexpected loss\b/i,
  /\bflag(?:ged)?\b/i,
  // camelCase identifiers and SNAKE_CASE codes
  /\b[a-z]+[A-Z][A-Za-z]*\b/,
  /\b[A-Z]{2,}_[A-Z_]+\b/,
];

/** The first jargon pattern a text matches, or null when it is plain. */
export function findJargon(text: string): RegExp | null {
  return INTERNAL_JARGON.find((re) => re.test(text)) ?? null;
}

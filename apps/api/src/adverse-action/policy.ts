/**
 * Adverse action notices: the deadlines, the windows, and the creditor details printed on
 * every notice. Regulation B (12 CFR 1002.9) is the model; see `apps/api/UNDERWRITING.md`,
 * "Reasons and adverse action notices", for the reading behind each number and the
 * questions for counsel.
 */
export const NOTICE_POLICY = {
  /**
   * 1002.9(a)(1)(i): notice of action taken within 30 days after receiving a completed
   * application. Counted from submission.
   */
  noticeDays: 30,
  /**
   * How long a counter offer stays open. Not accepted (no plan opened on it) by then, it has
   * expired and the applicant is sent an adverse action notice. Nothing else changes: a plan
   * can still be opened on it later, as before.
   */
  counterOfferValidDays: 30,
  /**
   * 1002.9(a)(1)(iv): when a counter offer is not accepted, notice of adverse action within
   * 90 days after notifying the applicant of the counter offer.
   */
  counterOfferNoticeDays: 90,
  /**
   * An application waiting on information is sent a notice of incompleteness after this many
   * days without it, well inside the 30 days of 1002.9(a)(1)(ii) and (c)(1).
   */
  incompleteNoticeAfterDays: 10,
  /** The reasonable period, 1002.9(c)(2), the notice of incompleteness gives to respond. */
  incompleteResponseDays: 30,
  /**
   * Notice of adverse action within 30 days after taking it on an incomplete application,
   * 1002.9(a)(1)(ii). Regulation B does not require this notice once a notice of
   * incompleteness went unanswered (1002.9(c)(2)); it is sent anyway, as the conservative
   * choice.
   */
  incompleteDeclinedNoticeDays: 30,
} as const;

/**
 * Bumped whenever the notice template or a statement in it changes. Stored on every notice,
 * so what an applicant was sent can always be matched to the wording in force.
 */
export const NOTICE_STATEMENT_VERSION = 'cashflow-notice-v1';

/**
 * The creditor named on every notice (1002.9(a)(2)). PLACEHOLDERS: there is no company
 * behind this repository. A real deployment must replace every value here, and counsel must
 * confirm the federal agency.
 */
export const CREDITOR = {
  name: '[PLACEHOLDER] CashFlow Rent Financing, Inc.',
  address: '[PLACEHOLDER] 100 Example Street, Suite 000, Portland, OR 97200',
  contact: '[PLACEHOLDER] support@example.com',
  /**
   * The agency for a nonbank creditor of this shape is the Federal Trade Commission, under
   * appendix A to Regulation B. A question for counsel: a bank or capital partner could
   * change it.
   */
  agency: 'Federal Trade Commission, Equal Credit Opportunity, Washington, DC 20580',
  isPlaceholder: true,
} as const;

/**
 * The ECOA notice, in the words of 12 CFR 1002.9(b)(1), with the agency filled in.
 */
export const ECOA_STATEMENT =
  "The Federal Equal Credit Opportunity Act prohibits creditors from discriminating against credit applicants on the basis of race, color, religion, national origin, sex, marital status, age (provided the applicant has the capacity to enter into a binding contract); because all or part of the applicant's income derives from any public assistance program; or because the applicant has in good faith exercised any right under the Consumer Credit Protection Act. The Federal agency that administers compliance with this law concerning this creditor is the " +
  CREDITOR.agency +
  '.';

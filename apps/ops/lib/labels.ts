import {
  catalogEntry,
  type AdverseActionNoticeKind,
  type AlertSeverity,
  type FactorStatus,
  type ReviewReasonCode,
} from '@cashflow/shared';

import { words, type Tone } from './format';

/**
 * Plain words for the codes the API speaks in. A reviewer should not have to know that
 * `INTEGRITY:DUPLICATE_BANK_ACCOUNT` means the same bank account is linked under another
 * user. Anything not listed falls back to the code with its underscores removed.
 */

export const SEVERITY: Record<AlertSeverity, { label: string; tone: Tone; level: number }> = {
  CRITICAL: { label: 'Critical', tone: 'bad', level: 4 },
  HIGH: { label: 'High', tone: 'bad', level: 3 },
  WARNING: { label: 'Warning', tone: 'warn', level: 2 },
  INFO: { label: 'Info', tone: 'info', level: 1 },
};

const INTEGRITY: Record<string, string> = {
  STATED_REVENUE_FAR_ABOVE_VERIFIED: 'Stated revenue is far above what the bank account shows',
  STATED_REVENUE_ABOVE_VERIFIED: 'Stated revenue is above what the bank account shows',
  STATED_REVENUE_BELOW_VERIFIED: 'Stated revenue is well below what the bank account shows',
  POS_DEPOSIT_SHORTFALL: 'Bank deposits fall short of the sales the point of sale reports',
  POS_DEPOSIT_EXCESS: 'Bank deposits are well above the sales the point of sale reports',
  ROUND_TRIP_DEPOSITS: 'Deposits repeatedly leave again as transfers of the same size',
  ROUND_TRIP_SUSPECTED: 'A deposit left again as a transfer of the same size',
  NON_SALES_CREDIT_SHARE: 'Much of the money coming in is transfers or loans, not sales',
  OWNER_TOP_UPS_BEFORE_APPLYING: 'The owner moved money in shortly before applying',
  REVENUE_SPIKE: 'Revenue jumped in the last six weeks',
  SHORT_ACCOUNT_HISTORY: 'The bank account is much younger than the business says it is',
  RENT_ABOVE_OBSERVED: 'Requested rent is above the rent seen in the bank account',
  NO_RENT_OBSERVED: 'No rent payment was found in the bank account',
  LANDLORD_IS_APPLICANT_ACCOUNT: "The landlord's payout account is the applicant's own account",
  DUPLICATE_LANDLORD_ACCOUNT: 'Another user pays the same landlord account',
  DUPLICATE_BANK_ACCOUNT: 'The same bank account is linked under another user',
  DUPLICATE_BUSINESS_IDENTITY: 'The same business name and address exist under another user',
  IDENTITY_VERIFICATION_FAILED: 'Identity verification failed',
  IDENTITY_NOT_VERIFIED: 'Identity is not verified yet',
  SCREENING_POSSIBLE_MATCH: 'Possible sanctions or watchlist match',
  SCREENING_MATCH: 'Sanctions or watchlist match',
};

export function integrityLabel(code: string): string {
  return INTEGRITY[code] ?? words(code);
}

const TRIGGERS: Record<string, string> = {
  SCORE_NEAR_CUTOFF: 'The score passes, but only just above the cutoff',
  AMOUNT_ABOVE_THRESHOLD: 'The limit is above the amount the engine may approve alone',
  COUNTER_OFFER_FIRST_PLAN: 'A first plan would be approved for much less than requested',
  CIRCUIT_BREAKER: 'Automatic approvals are paused by the circuit breaker',
};

/** Why the engine sent an application to a person. */
export function triggerLabel(trigger: string): string {
  if (trigger.startsWith('INTEGRITY:')) {
    return `Integrity flag: ${integrityLabel(trigger.slice('INTEGRITY:'.length))}`;
  }
  return TRIGGERS[trigger] ?? words(trigger);
}

const INTEGRITY_ACTIONS: Record<string, string> = {
  KNOCKOUT: 'Declines automatically',
  REFER: 'Sends to review',
  CAP: 'Caps the limit',
  NEEDS_INFO: 'Asks the applicant for more',
  INFORM: 'For information',
};

export function integrityAction(action: string): string {
  return INTEGRITY_ACTIONS[action] ?? words(action);
}

export const REVIEW_REASONS: Record<ReviewReasonCode, string> = {
  LEASE_VERIFIED: 'Lease verified another way',
  REVENUE_VERIFIED_OTHER_SOURCE: 'Revenue verified from another source',
  IDENTITY_VERIFIED: 'Identity verified by the reviewer',
  INTEGRITY_FLAG_CLEARED: 'Integrity flag checked and cleared',
  INTEGRITY_FLAG_CONFIRMED: 'Integrity flag confirmed',
  FRAUD_SUSPECTED: 'Fraud suspected',
  DOCUMENTS_NOT_PROVIDED: 'Documents not provided',
  COMPENSATING_FACTORS: 'Compensating factors',
  EXPOSURE_ADJUSTED: 'Limit adjusted for exposure',
  PRICING_ADJUSTED: 'Fee adjusted',
  OTHER: 'Other (explain in the notes)',
};

const HOLDS: Record<string, string> = {
  PAST_DUE: 'An earlier installment is past the grace period',
  ADVANCE_FROZEN: 'The plan is frozen',
  PLAN_PAUSED: 'The owner paused the plan',
  PLAN_CLOSED: 'The plan was closed before the payout fell due',
  NOT_PAID_IN_TIME: 'It could not be paid inside the release window',
  LEASE_CHANGE_PENDING: 'A change to the landlord details is in its waiting period',
  RENT_INCREASE_PENDING: 'The rent went up past the approved amount',
};

export function holdReason(reason: string | null | undefined): string {
  return reason ? (HOLDS[reason] ?? words(reason)) : '';
}

const FREEZES: Record<string, string> = {
  PERIODIC_REVIEW: 'The monthly review scored the business below the watch level',
  UNAUTHORIZED_RETURN: 'A debit came back as unauthorized',
  PAYOUT_RETURNED: "A payout came back from the landlord's bank",
  SCREENING_REVIEW: 'A screening hit is open',
  BUSINESS_CHARGED_OFF: 'Another plan of this business was written off',
};

export function freezeReason(reason: string | null | undefined): string {
  return reason ? (FREEZES[reason] ?? words(reason)) : 'Frozen';
}

const DISPOSITIONS: Record<string, string> = {
  CONFIRMED: 'Confirmed: the alert was right and has been dealt with',
  FALSE_POSITIVE: 'False positive: the alert was wrong',
  NO_ACTION: 'No action needed',
  DUPLICATE: 'Duplicate of another alert',
  CONDITION_CLEARED: 'The condition cleared on its own',
};

export function dispositionLabel(disposition: string | null | undefined): string {
  return disposition ? (DISPOSITIONS[disposition] ?? words(disposition)) : '';
}

const LIMIT_CAPS: Record<string, string> = {
  REQUEST: 'The rent requested',
  CAPACITY: 'What the cash flow supports',
  OBSERVED_RENT: 'Rent seen in the bank account',
  LADDER: 'The limit ladder for this payment record',
  BUSINESS_AGGREGATE: 'The cap on one business across all plans',
  SINGLE_NAME: 'The single business share of pool capital',
};

export function limitCap(cap: string): string {
  return LIMIT_CAPS[cap] ?? words(cap);
}

const FEE_DRIVERS: Record<string, string> = {
  GRADE_FLOOR: 'the fee floor for the grade',
  EXPECTED_LOSS: 'expected loss plus costs and margin',
  MINIMUM_FEE: 'the minimum fee in dollars',
};

export function feeDriver(driver: string): string {
  return FEE_DRIVERS[driver] ?? words(driver).toLowerCase();
}

const STATUS_TONES: Record<string, Tone> = {
  // Good
  PAID: 'good',
  SUCCEEDED: 'good',
  APPROVED: 'good',
  ACTIVE: 'good',
  LINKED: 'good',
  VERIFIED: 'good',
  CLEAR: 'good',
  CURRENT: 'good',
  APPLIED: 'good',
  RESOLVED: 'good',
  // Needs attention soon
  HELD: 'warn',
  PENDING: 'warn',
  SUBMITTED: 'warn',
  IN_REVIEW: 'warn',
  REFER: 'warn',
  NEEDS_INFO: 'warn',
  REVIEW: 'warn',
  GRACE: 'warn',
  PAUSED: 'warn',
  POSSIBLE_MATCH: 'warn',
  ACKNOWLEDGED: 'warn',
  ONBOARDING: 'warn',
  UNVERIFIED: 'warn',
  // Bad
  LATE: 'bad',
  FAILED: 'bad',
  DECLINED: 'bad',
  ERROR: 'bad',
  RETURNED: 'bad',
  CHARGED_OFF: 'bad',
  DELINQUENT: 'bad',
  DEFAULT: 'bad',
  MATCH: 'bad',
  SUSPENDED: 'bad',
  REJECTED: 'bad',
  OPEN: 'bad',
  // In flight
  SCHEDULED: 'info',
  // Pass-through months, payment history, and graduation offers
  ON_TIME: 'good',
  ACCEPTED: 'good',
  COMPLETED: 'good',
  COLLECTING: 'info',
  SETTLED: 'info',
  OFFERED: 'info',
  MISSED: 'bad',
  REFUNDED: 'bad',
  RETURNED_AFTER_PAYOUT: 'bad',
};

const STATUS_LABELS: Record<string, string> = {
  HELD: 'On hold',
  CHARGED_OFF: 'Written off',
  VOIDED: 'Not owed',
  REFER: 'Referred',
  REVIEW: 'Under review',
  DEFAULT: 'In default',
  CLEAR: 'Clear',
  RETURNED_AFTER_PAYOUT: 'Returned after payout',
};

/** A status code as a tag: the words to show and the tone to show them in. */
export function status(code: string | null | undefined): { label: string; tone: Tone } {
  if (!code) return { label: 'None', tone: 'neutral' };
  return { label: STATUS_LABELS[code] ?? words(code), tone: STATUS_TONES[code] ?? 'neutral' };
}

interface Refusal {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * What to tell the operator when the API refuses an action: what happened and what to do
 * next. Codes that are not listed show the API's own message, which is written for people.
 */
export function refusal(error: Refusal): {
  title: string;
  body: string;
  href?: string;
  link?: string;
} {
  switch (error.code) {
    case 'SCREENING_HIT_OPEN':
      return {
        title: 'An open screening hit blocks this',
        body: 'This business has a screening hit that nobody has cleared. Clear it in the screening queue first, then come back and record the decision.',
        href: '/screening',
        link: 'Open the screening queue',
      };
    case 'IDENTITY_NOT_VERIFIED':
      return {
        title: 'The business is not verified',
        body: 'The identity provider has not verified this business. If you verified it another way, tick "Identity verified by the reviewer" under reason codes and submit again. That records the verification under your name.',
      };
    case 'REASON_CODES_REQUIRED':
      return {
        title: 'Reason codes are needed',
        body: 'This decision differs from what the engine recommended, which makes it an override. Pick at least one reason code and submit again.',
      };
    case 'TERMS_REQUIRED':
      return {
        title: 'A limit and a fee are needed',
        body: 'The engine did not recommend terms for this application, so approving it needs both a monthly limit and a fee.',
      };
    case 'LIMIT_OUT_OF_RANGE':
      return {
        title: 'The limit is out of range',
        body: 'The approved limit must be above zero and no more than the rent the applicant asked for.',
      };
    case 'FEE_OUT_OF_RANGE':
      return {
        title: 'The fee is out of range',
        body: 'The fee must be above zero and within the maximum fee in the credit policy. See the policy page for the cap.',
        href: '/policy',
        link: 'Open the policy',
      };
    case 'APPLICANT_MESSAGE_REQUIRED':
      return {
        title: 'Tell the applicant what to provide',
        body: 'Requesting information needs a message for the applicant. They see it exactly as you write it.',
      };
    case 'NOT_REVIEWABLE':
      return {
        title: 'This application cannot be reviewed now',
        body: `${error.message}. Someone may have recorded a decision since you opened it. Reload to see where it stands.`,
      };
    case 'FORBIDDEN':
      return {
        title: 'This needs the admin role',
        body: 'You are signed in as a reviewer. Ask an admin to do this, or sign in with the admin token.',
      };
    case 'ALERT_RESOLVED':
    case 'ALERT_NOT_OPEN':
      return {
        title: 'The alert has moved on',
        body: `${error.message}. Reload to see its current state.`,
      };
    case 'SCREENING_ALREADY_CLEARED':
    case 'SCREENING_SUPERSEDED':
    case 'SCREENING_NOT_A_HIT':
      return { title: 'Nothing to clear', body: `${error.message}. Reload the queue.` };
    case 'LEASE_CHANGE_NOT_PENDING':
      return {
        title: 'This change is no longer pending',
        body: 'It was applied, cancelled, or decided since you opened the queue. Reload to see it.',
      };
    case 'LEASE_CHANGE_PENDING':
      return {
        title: 'A landlord change is still waiting',
        body: 'The corrected landlord details are inside their cooling-off period. Approve the change in the lease changes queue, or wait for it to apply, then send the payout again.',
        href: '/lease-changes',
        link: 'Open lease changes',
      };
    case 'LANDLORD_DETAILS_NOT_CORRECTED':
      return {
        title: 'The landlord details have not changed',
        body: 'This payout came back from the bank. Sending it to the same account would fail again. Have the owner correct the payout details on the lease first.',
      };
    case 'PAYOUT_NOT_RETURNED':
      return { title: 'This payout cannot be sent again', body: error.message };
    case 'PLAN_NOT_FROZEN':
      return { title: 'The plan is not frozen', body: 'Reload to see its current state.' };
    case 'PLAN_CLOSED':
      return { title: 'The plan is closed', body: 'A closed plan fronts no more rent.' };
    case 'BREAKER_NOT_TRIPPED':
      return {
        title: 'The breaker is not tripped',
        body: 'Automatic approvals are already running. Reload to see the current state.',
      };
    case 'VALIDATION_ERROR': {
      const fields = Array.isArray(error.details)
        ? (error.details as Array<{ path?: unknown; message?: unknown }>)
            .filter((d) => typeof d?.path === 'string' && typeof d?.message === 'string')
            .map((d) => `${words(String(d.path).replace(/^\//, ''))}: ${String(d.message)}`)
        : [];
      return {
        title: 'Something in the form is not valid',
        body:
          fields.length > 0
            ? `${fields.join('. ')}.`
            : 'Check the required fields: reasons and notes need at least three characters.',
      };
    }
    case 'API_UNREACHABLE':
      return { title: 'The API did not answer', body: error.message };
    case 'CSRF_REJECTED':
      return {
        title: 'The request was refused',
        body: 'The console could not confirm the request came from this page. Reload and try again.',
      };
    default:
      return { title: 'The API refused this', body: error.message };
  }
}

/** What each kind of notice an applicant was sent is, in a few words. */
export const NOTICE_KINDS: Record<AdverseActionNoticeKind, string> = {
  DECLINE: 'Decline',
  COUNTER_OFFER_NOT_ACCEPTED: 'Counter offer not taken up',
  INCOMPLETE: 'Notice of incompleteness',
  INCOMPLETE_DECLINED: 'Closed as incomplete',
};

/** How a scorecard factor is shown to the applicant: helping, neutral, or hurting. */
export const FACTOR_STATUS: Record<FactorStatus, { label: string; tone: Tone }> = {
  HELPING: { label: 'Helping', tone: 'good' },
  NEUTRAL: { label: 'Neutral', tone: 'neutral' },
  HURTING: { label: 'Hurting', tone: 'bad' },
};

/** The catalog title for a reason code, or the code in words for one the catalog lacks. */
export function reasonTitle(code: string): string {
  return catalogEntry(code)?.title ?? words(code);
}

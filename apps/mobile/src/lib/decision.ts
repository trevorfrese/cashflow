import type { AdverseActionNoticeKind, FactorStatus } from '@cashflow/shared';

import type { PillTone } from '@/components/Pill';

/**
 * Words and tones for the decision screen and the application form. Pure, so the copy can be
 * tested without rendering anything.
 */

/** Shown on the application form, before submit: what is used, and the right to reasons. */
export const APPLICATION_DISCLOSURE = {
  title: 'Before you submit',
  points: [
    'We decide from the bank account and point of sale you connect: deposits, spending, balances, overdraft fees and existing debt payments. We do not pull your personal credit score.',
    'We also check the business details on your profile with an identity service.',
    'If we cannot approve the full rent, we will tell you the specific reasons in writing, and what would change the outcome.',
  ],
} as const;

export const FACTOR_STATUS: Record<FactorStatus, { label: string; tone: PillTone }> = {
  HELPING: { label: 'Helping', tone: 'paid' },
  NEUTRAL: { label: 'Neutral', tone: 'neutral' },
  HURTING: { label: 'Hurting', tone: 'late' },
};

export const NOTICE_KIND_LABEL: Record<AdverseActionNoticeKind, string> = {
  DECLINE: 'Notice of action taken',
  COUNTER_OFFER_NOT_ACCEPTED: 'Notice about your counter offer',
  INCOMPLETE: 'Notice of incomplete application',
  INCOMPLETE_DECLINED: 'Notice: application closed as incomplete',
};

/** "November 12, 2026" from a timestamp or a calendar date. */
export function longDate(value: string): string {
  const date = new Date(value.length === 10 ? `${value}T12:00:00.000Z` : value);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Requests that only a newly connected bank account can answer. */
const NEEDS_A_BANK = ['BANK_LINK_REQUIRED', 'INSUFFICIENT_HISTORY', 'PAYOUT_ACCOUNT_NOT_CONNECTED'];
/** Requests answered on the connections screen: reconnect, or an action on a connection. */
const NEEDS_CONNECTIONS = ['RECONNECT_REQUIRED', 'CONNECTION_ACTION_NEEDED'];

/**
 * The one primary step for an application that needs information: connect a bank account,
 * fix a connection, or (once nothing is left to connect) run the decision again. Running it
 * again before the missing account is connected would only ask for the same thing.
 */
export function needsInfoStep(
  requestedCodes: readonly string[],
  hasLinkedBank: boolean,
): 'CONNECT_BANK' | 'CONNECTIONS' | 'RUN_AGAIN' {
  if (!hasLinkedBank || requestedCodes.some((c) => NEEDS_A_BANK.includes(c))) return 'CONNECT_BANK';
  if (requestedCodes.some((c) => NEEDS_CONNECTIONS.includes(c))) return 'CONNECTIONS';
  return 'RUN_AGAIN';
}

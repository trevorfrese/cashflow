import type { LandlordPayout, RentPlan } from '@cashflow/shared';

import { formatDate, formatMoney, formatPeriod } from './forms';

/**
 * Banners the home screen shows above a running plan, built only from fields the API
 * already returns. Pure, so the wording can be tested without rendering anything.
 */
export interface PlanNotice {
  tone: 'warning' | 'danger';
  title: string;
  message: string;
}

type Standing = Pick<
  RentPlan,
  'delinquencyStatus' | 'daysPastDue' | 'pastDueCents' | 'needsPayment'
>;

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/**
 * The past due banner, or null when nothing is overdue. Inside the grace period it is a
 * warning; past it, or once automatic debits have stopped, it is an error.
 */
export function pastDueNotice(plan: Standing): PlanNotice | null {
  if (plan.delinquencyStatus === 'CHARGED_OFF') {
    return {
      tone: 'danger',
      title: 'This plan was closed with a balance unpaid',
      message: `We stopped paying rent on this plan because payments were missed for too long. ${
        plan.pastDueCents > 0
          ? `The unpaid balance of ${formatMoney(plan.pastDueCents)} is still owed`
          : 'The unpaid balance is still owed'
      }, and you can pay it below.`,
    };
  }
  if (plan.delinquencyStatus === 'CURRENT' && !plan.needsPayment) return null;
  if (plan.daysPastDue === 0 && plan.pastDueCents === 0 && !plan.needsPayment) return null;

  const amount = plan.pastDueCents > 0 ? formatMoney(plan.pastDueCents) : 'A payment';
  const age = plan.daysPastDue > 0 ? ` ${days(plan.daysPastDue)} past due` : ' past due';
  const owed = `${amount} is${age}.`;
  const action = plan.needsPayment
    ? 'Automatic payments from your bank have stopped. Pay now below, or update your bank account in Settings.'
    : 'We will try your bank account again, or you can pay now below.';
  const inGrace = plan.delinquencyStatus === 'GRACE' || plan.delinquencyStatus === 'CURRENT';
  const hold = inGrace
    ? 'If it stays unpaid, your next rent payment to the landlord will be held.'
    : 'Rent payments to your landlord are on hold until it is paid.';
  return {
    tone: inGrace && !plan.needsPayment ? 'warning' : 'danger',
    title: plan.needsPayment ? 'Payment needed' : 'Payment past due',
    message: `${owed} ${action} ${hold}`,
  };
}

type Held = Pick<LandlordPayout, 'heldMessage' | 'releaseBy' | 'periodMonth'>;

/**
 * The held payout notice, or null when no payout is held. The reason is the API's own plain
 * words (`heldMessage`); this adds the last day it can still go out and what happens after.
 */
export function heldPayoutNotice(payout: Held | null | undefined): PlanNotice | null {
  if (!payout) return null;
  const reason = payout.heldMessage ?? 'This rent payment is on hold.';
  const deadline = payout.releaseBy
    ? ` It can still be sent through ${formatDate(payout.releaseBy)}. After that it is cancelled and you pay your landlord directly for ${formatPeriod(payout.periodMonth)}.`
    : '';
  return {
    tone: 'warning',
    title: `${formatPeriod(payout.periodMonth)} rent payment on hold`,
    message: `${reason}${deadline}`,
  };
}

/** What the applicant is told while a referred application waits for a reviewer. */
export const IN_REVIEW_COPY = {
  title: 'We are taking a closer look',
  message:
    'A person on our team is reviewing your application before we confirm terms. Most reviews finish within a couple of business days, and you will always have an answer within 30 days. You do not need to do anything unless we ask.',
} as const;

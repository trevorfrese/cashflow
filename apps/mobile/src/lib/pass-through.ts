import type {
  GraduationOffer,
  Lease,
  PassThroughPeriod,
  PassThroughPeriodStatus,
  PaymentHistory,
} from '@cashflow/shared';

/**
 * Pure helpers for the free pass-through plan: which month to show, how to label it, and
 * which graduation offer is current. Kept out of the screens so they can be tested.
 */

/** Months that are over: the landlord was paid, or CashFlow did not pay this month. */
const FINISHED: readonly PassThroughPeriodStatus[] = [
  'PAID',
  'MISSED',
  'REFUNDED',
  'RETURNED_AFTER_PAYOUT',
];

/** Months in which CashFlow did not end up paying the landlord, or the money came back. */
const MISSED: readonly PassThroughPeriodStatus[] = ['MISSED', 'REFUNDED', 'RETURNED_AFTER_PAYOUT'];

export function isMissedPeriod(p: Pick<PassThroughPeriod, 'status'>): boolean {
  return MISSED.includes(p.status);
}

/** The newest month that is over, so the owner knows whether the landlord was paid. */
export function latestFinishedPeriod(periods: PassThroughPeriod[]): PassThroughPeriod | null {
  return (
    [...periods]
      .filter((p) => FINISHED.includes(p.status))
      .sort((a, b) => (a.periodMonth < b.periodMonth ? 1 : -1))[0] ?? null
  );
}

/** Short label and tone for a month's status. */
export function periodStatusLabel(status: PassThroughPeriodStatus): {
  label: string;
  tone: 'paid' | 'due' | 'late' | 'info' | 'neutral';
} {
  switch (status) {
    case 'SCHEDULED':
      return { label: 'Scheduled', tone: 'info' };
    case 'COLLECTING':
      return { label: 'Collecting', tone: 'due' };
    case 'SETTLED':
      return { label: 'Ready to pay', tone: 'info' };
    case 'PAID':
      return { label: 'Landlord paid', tone: 'paid' };
    case 'MISSED':
      return { label: 'Missed', tone: 'late' };
    case 'REFUNDED':
      return { label: 'Refunded', tone: 'late' };
    case 'RETURNED_AFTER_PAYOUT':
      return { label: 'Payment returned', tone: 'late' };
    case 'CANCELLED':
      return { label: 'Cancelled', tone: 'neutral' };
  }
}

/**
 * The graduation offer to show: the plan's own if it has one, else the one on the payment
 * history. Expired and withdrawn offers are not shown.
 */
export function currentGraduationOffer(
  ...candidates: Array<GraduationOffer | null | undefined>
): GraduationOffer | null {
  const offer = candidates.find((o): o is GraduationOffer => Boolean(o));
  if (!offer) return null;
  return offer.status === 'EXPIRED' || offer.status === 'WITHDRAWN' ? null : offer;
}

/** The lease a pass-through plan starts on: the newest active one. Leases come newest first. */
export function leaseForPassThrough(leases: Lease[] | undefined): Lease | null {
  return leases?.find((l) => l.status === 'ACTIVE') ?? null;
}

/** "On-time months: 2. 1 more before we look at a split rent plan again." */
export function onTimeLine(history: Pick<PaymentHistory, 'summary' | 'monthsUntilReview'>): string {
  const streak = history.summary.currentOnTimeStreak;
  const base = `On-time months in a row: ${streak}.`;
  const left = history.monthsUntilReview;
  if (left === null) return base;
  if (left === 0) return `${base} We are looking at a split rent plan for you.`;
  return `${base} ${left} more before we look at a split rent plan again.`;
}

import type { GraduationOffer, Lease, PassThroughPeriod } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import {
  currentGraduationOffer,
  isMissedPeriod,
  latestFinishedPeriod,
  leaseForPassThrough,
  onTimeLine,
  periodStatusLabel,
} from './pass-through';

const period = (periodMonth: string, status: PassThroughPeriod['status']) =>
  ({ id: periodMonth, periodMonth, status }) as unknown as PassThroughPeriod;
const offer = (status: GraduationOffer['status'], id = status) =>
  ({ id, status }) as unknown as GraduationOffer;

describe('latestFinishedPeriod', () => {
  it('picks the newest month that is over', () => {
    const p = latestFinishedPeriod([
      period('2026-09', 'PAID'),
      period('2026-11', 'SCHEDULED'),
      period('2026-10', 'MISSED'),
    ]);
    expect(p?.periodMonth).toBe('2026-10');
    expect(p && isMissedPeriod(p)).toBe(true);
  });

  it('is null before any month is over', () => {
    expect(latestFinishedPeriod([period('2026-11', 'COLLECTING')])).toBeNull();
  });
});

describe('periodStatusLabel', () => {
  it('says the landlord was paid and flags a missed month', () => {
    expect(periodStatusLabel('PAID')).toEqual({ label: 'Landlord paid', tone: 'paid' });
    expect(periodStatusLabel('MISSED').tone).toBe('late');
    expect(isMissedPeriod({ status: 'PAID' })).toBe(false);
  });
});

describe('currentGraduationOffer', () => {
  it('prefers the first offer given and hides expired ones', () => {
    expect(currentGraduationOffer(null, offer('OFFERED'))?.id).toBe('OFFERED');
    expect(currentGraduationOffer(offer('ACCEPTED'), offer('OFFERED'))?.id).toBe('ACCEPTED');
    expect(currentGraduationOffer(offer('EXPIRED'))).toBeNull();
    expect(currentGraduationOffer(undefined, null)).toBeNull();
  });
});

describe('leaseForPassThrough', () => {
  it('uses an active lease only', () => {
    const leases = [
      { id: 'a', status: 'ENDED' },
      { id: 'b', status: 'ACTIVE' },
    ] as unknown as Lease[];
    expect(leaseForPassThrough(leases)?.id).toBe('b');
    expect(leaseForPassThrough([])).toBeNull();
  });
});

describe('onTimeLine', () => {
  const summary = { currentOnTimeStreak: 2 } as never;
  it('counts down to the review', () => {
    expect(onTimeLine({ summary, monthsUntilReview: 1 })).toBe(
      '2 months on time in a row. After 1 more on-time month, we look at a split rent plan for you.',
    );
    expect(onTimeLine({ summary, monthsUntilReview: 3 })).toBe(
      '2 months on time in a row. After 3 more on-time months, we look at a split rent plan for you.',
    );
    expect(onTimeLine({ summary, monthsUntilReview: null })).toBe('2 months on time in a row.');
  });
  it('says one month and no months plainly', () => {
    const one = { currentOnTimeStreak: 1 } as never;
    const none = { currentOnTimeStreak: 0 } as never;
    expect(onTimeLine({ summary: one, monthsUntilReview: null })).toBe('1 month on time in a row.');
    expect(onTimeLine({ summary: none, monthsUntilReview: 0 })).toBe(
      'No on-time months in a row yet. We are looking at a split rent plan for you.',
    );
  });
});

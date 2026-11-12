import { describe, expect, it } from 'vitest';

import {
  classifyFinancedPeriod,
  classifyPassThroughPeriod,
  paymentHistoryFactor,
  summarizePaymentHistory,
  type InstallmentFacts,
  type PaymentHistoryMonth,
} from './payment-history.ts';
import { PAYMENT_HISTORY_POLICY_V4 as POLICY } from './policy.ts';

const inst = (overrides: Partial<InstallmentFacts> = {}): InstallmentFacts => ({
  status: 'PAID',
  dueDate: '2026-06-01',
  paidOn: '2026-06-01',
  chargedOff: false,
  returned: false,
  ...overrides,
});

describe('classifyFinancedPeriod', () => {
  const asOf = '2026-08-01';
  it('is on time when every installment was paid inside grace and nothing came back', () => {
    expect(
      classifyFinancedPeriod(
        [inst(), inst({ dueDate: '2026-06-15', paidOn: '2026-06-17' })],
        asOf,
        3,
        30,
      ),
    ).toBe('ON_TIME');
  });

  it('is late when paid after grace, or when a payment was returned', () => {
    expect(classifyFinancedPeriod([inst({ paidOn: '2026-06-05' })], asOf, 3, 30)).toBe('LATE');
    expect(classifyFinancedPeriod([inst({ returned: true })], asOf, 3, 30)).toBe('LATE');
  });

  it('is missed when written off or 30 days past due', () => {
    expect(classifyFinancedPeriod([inst({ chargedOff: true })], asOf, 3, 30)).toBe('MISSED');
    expect(
      classifyFinancedPeriod([inst({ status: 'LATE', paidOn: null })], '2026-07-01', 3, 30),
    ).toBe('MISSED');
  });

  it('has no outcome while still open, or when nothing was owed', () => {
    expect(
      classifyFinancedPeriod(
        [inst({ status: 'SCHEDULED', paidOn: null, dueDate: '2026-07-30' })],
        asOf,
        3,
        30,
      ),
    ).toBeNull();
    expect(classifyFinancedPeriod([inst({ status: 'VOIDED' })], asOf, 3, 30)).toBeNull();
  });
});

describe('classifyPassThroughPeriod', () => {
  it('counts paid months as on time and missed or returned months as missed', () => {
    expect(classifyPassThroughPeriod('PAID')).toBe('ON_TIME');
    expect(classifyPassThroughPeriod('MISSED')).toBe('MISSED');
    expect(classifyPassThroughPeriod('RETURNED_AFTER_PAYOUT')).toBe('MISSED');
    for (const s of ['SCHEDULED', 'COLLECTING', 'SETTLED', 'REFUNDED', 'CANCELLED'] as const) {
      expect(classifyPassThroughPeriod(s)).toBeNull();
    }
  });
});

const month = (dueDate: string, outcome: PaymentHistoryMonth['outcome']): PaymentHistoryMonth => ({
  rentPlanId: 'p1',
  kind: 'PASS_THROUGH',
  periodMonth: dueDate.slice(0, 7),
  dueDate,
  outcome,
});

describe('summarizePaymentHistory', () => {
  it('reads the streak back from the most recent month', () => {
    const s = summarizePaymentHistory(
      [
        month('2026-03-01', 'ON_TIME'),
        month('2026-04-01', 'MISSED'),
        month('2026-05-01', 'ON_TIME'),
        month('2026-06-01', 'ON_TIME'),
      ],
      '2026-06-10',
      12,
    );
    expect(s).toEqual({
      months: 4,
      onTimeMonths: 3,
      lateMonths: 0,
      missedMonths: 1,
      currentOnTimeStreak: 2,
      lastMissedPeriod: '2026-04',
    });
  });

  it('forgets months outside the lookback', () => {
    const s = summarizePaymentHistory(
      [month('2025-01-01', 'MISSED'), month('2026-05-01', 'ON_TIME')],
      '2026-06-10',
      12,
    );
    expect(s.missedMonths).toBe(0);
    expect(s.months).toBe(1);
  });
});

describe('paymentHistoryFactor', () => {
  it('is absent with no history, so a first time applicant is scored as before', () => {
    expect(paymentHistoryFactor(null, POLICY)).toBeNull();
    expect(paymentHistoryFactor(summarizePaymentHistory([], '2026-06-10', 12), POLICY)).toBeNull();
  });

  it('rewards a run of on time months up to the cap', () => {
    const two = summarizePaymentHistory(
      [month('2026-05-01', 'ON_TIME'), month('2026-06-01', 'ON_TIME')],
      '2026-06-10',
      12,
    );
    expect(paymentHistoryFactor(two, POLICY)).toMatchObject({ points: 4, impact: 'POSITIVE' });
    const many = summarizePaymentHistory(
      ['01', '02', '03', '04', '05', '06'].map((m) => month(`2026-${m}-01`, 'ON_TIME')),
      '2026-06-10',
      12,
    );
    expect(paymentHistoryFactor(many, POLICY)!.points).toBe(POLICY.maxBonusPoints);
  });

  it('takes points for misses, capped', () => {
    const missed = summarizePaymentHistory(
      [month('2026-05-01', 'ON_TIME'), month('2026-06-01', 'MISSED')],
      '2026-06-10',
      12,
    );
    expect(paymentHistoryFactor(missed, POLICY)).toMatchObject({
      points: -POLICY.missPenaltyPoints,
      impact: 'NEGATIVE',
    });
    const worst = summarizePaymentHistory(
      ['02', '03', '04', '05', '06'].map((m) => month(`2026-${m}-01`, 'MISSED')),
      '2026-06-10',
      12,
    );
    expect(paymentHistoryFactor(worst, POLICY)!.points).toBe(-POLICY.maxPenaltyPoints);
  });
});

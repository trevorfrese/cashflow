import { describe, expect, it } from 'vitest';

import { MOCK_RETURN_DAYS } from '../providers/payments/mock.ts';
import {
  addBusinessDays,
  collectionAction,
  isBusinessDay,
  passThroughBalanceCovers,
  passThroughPayoutAction,
  passThroughSchedule,
  settlesOn,
  STANDARD_PASS_THROUGH_POLICY as POLICY,
} from './pass-through.ts';

describe('business days', () => {
  it('skips weekends in both directions', () => {
    // 2026-12-04 is a Friday.
    expect(isBusinessDay('2026-12-04')).toBe(true);
    expect(isBusinessDay('2026-12-05')).toBe(false);
    expect(addBusinessDays('2026-12-04', 1)).toBe('2026-12-07');
    expect(addBusinessDays('2026-12-07', -1)).toBe('2026-12-04');
    expect(addBusinessDays('2026-12-01', -5)).toBe('2026-11-24');
    expect(addBusinessDays('2026-12-01', 0)).toBe('2026-12-01');
  });
});

describe('pass-through schedule', () => {
  it('collects five business days before the due date and stops in time to settle', () => {
    // Due Tuesday 2026-12-01.
    expect(passThroughSchedule(POLICY, '2026-12-01')).toEqual({
      collectOn: '2026-11-24',
      lastCollectOn: '2026-11-26',
    });
  });

  it('settles a debit made on the last collection day by the due date', () => {
    for (const due of ['2026-12-01', '2027-01-01', '2027-02-15', '2027-03-06']) {
      const { lastCollectOn } = passThroughSchedule(POLICY, due);
      expect(settlesOn(POLICY, lastCollectOn) <= due).toBe(true);
    }
  });

  it('settles only after the return window the mock bank models', () => {
    // Three business days are at least three calendar days, longer than a two day return.
    for (const day of ['2026-11-23', '2026-11-26', '2026-11-27', '2026-11-28']) {
      const settled = settlesOn(POLICY, day);
      const days = (Date.parse(settled) - Date.parse(day)) / 86_400_000;
      expect(days).toBeGreaterThan(MOCK_RETURN_DAYS);
    }
  });
});

describe('collectionAction', () => {
  const state = {
    collectOn: '2026-11-24',
    lastCollectOn: '2026-11-26',
    attempts: 0,
    lastAttemptOn: null,
  };

  it('waits before the window, attempts inside it, and misses after it', () => {
    expect(collectionAction(POLICY, state, '2026-11-23')).toBe('wait');
    expect(collectionAction(POLICY, state, '2026-11-24')).toBe('attempt');
    expect(collectionAction(POLICY, state, '2026-11-26')).toBe('attempt');
    expect(collectionAction(POLICY, state, '2026-11-27')).toBe('miss');
  });

  it('debits at most once a day and misses once out of attempts', () => {
    expect(
      collectionAction(
        POLICY,
        { ...state, attempts: 1, lastAttemptOn: '2026-11-24' },
        '2026-11-24',
      ),
    ).toBe('wait');
    expect(
      collectionAction(
        POLICY,
        { ...state, attempts: 1, lastAttemptOn: '2026-11-24' },
        '2026-11-25',
      ),
    ).toBe('attempt');
    expect(collectionAction(POLICY, { ...state, attempts: 2 }, '2026-11-25')).toBe('miss');
  });

  it('puts a debit off when the balance cannot cover the rent', () => {
    expect(passThroughBalanceCovers(POLICY, 99_999, 100_000)).toBe(false);
    expect(passThroughBalanceCovers(POLICY, 100_000, 100_000)).toBe(true);
    // No reading is not a reason to hold the debit back.
    expect(passThroughBalanceCovers(POLICY, null, 100_000)).toBe(true);
  });
});

describe('passThroughPayoutAction', () => {
  const due = '2026-12-01';
  it('pays only settled money, and never before the due date', () => {
    expect(
      passThroughPayoutAction(POLICY, { dueDate: due, settled: false, held: false }, due),
    ).toBe('wait');
    expect(
      passThroughPayoutAction(POLICY, { dueDate: due, settled: true, held: false }, '2026-11-30'),
    ).toBe('wait');
    expect(passThroughPayoutAction(POLICY, { dueDate: due, settled: true, held: false }, due)).toBe(
      'pay',
    );
  });

  it('holds inside the release window and refunds after it', () => {
    expect(
      passThroughPayoutAction(POLICY, { dueDate: due, settled: true, held: true }, '2026-12-06'),
    ).toBe('hold');
    expect(
      passThroughPayoutAction(POLICY, { dueDate: due, settled: true, held: true }, '2026-12-07'),
    ).toBe('refund');
  });
});

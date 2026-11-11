import { describe, expect, it } from 'vitest';

import { LATE_GRACE_DAYS } from '../services/collections.ts';
import {
  BASELINE_SERVICING_POLICY,
  daysPastDue,
  expectedRecoveryCents,
  isLate,
  shouldAttemptCollection,
  shouldChargeOff,
  shouldHoldPayout,
  type ServicingPolicy,
} from './policy.ts';

const baseline = BASELINE_SERVICING_POLICY;
const strict: ServicingPolicy = {
  name: 'strict',
  lateGraceDays: 3,
  retry: { intervalDays: 3, maxAttempts: 3 },
  holdPayoutPastDueDays: 3,
  chargeOffAfterDays: 90,
  recoveryRateBps: 1000,
};

describe('servicing policy', () => {
  it('baseline matches what the services do today', () => {
    expect(baseline.lateGraceDays).toBe(LATE_GRACE_DAYS);
    expect(baseline.retry).toEqual({ intervalDays: 1, maxAttempts: null });
    expect(baseline.holdPayoutPastDueDays).toBeNull();
    expect(baseline.chargeOffAfterDays).toBeNull();
  });

  it('counts days past due and applies the grace period like the collection service', () => {
    expect(daysPastDue('2026-03-01', '2026-02-27')).toBe(0);
    expect(daysPastDue('2026-03-01', '2026-03-05')).toBe(4);
    expect(isLate(baseline, '2026-03-01', '2026-03-04')).toBe(false);
    expect(isLate(baseline, '2026-03-01', '2026-03-05')).toBe(true);
  });

  it('baseline retries every day without limit', () => {
    const state = { dueDate: '2026-03-01', attempts: 400, lastAttemptDate: '2027-04-04' };
    expect(shouldAttemptCollection(baseline, state, '2027-04-05')).toBe(true);
    expect(
      shouldAttemptCollection(
        baseline,
        { dueDate: '2026-03-01', attempts: 0, lastAttemptDate: null },
        '2026-02-28',
      ),
    ).toBe(false);
  });

  it('honors a retry interval and an attempt cap', () => {
    const first = { dueDate: '2026-03-01', attempts: 1, lastAttemptDate: '2026-03-01' };
    expect(shouldAttemptCollection(strict, first, '2026-03-02')).toBe(false);
    expect(shouldAttemptCollection(strict, first, '2026-03-04')).toBe(true);
    expect(
      shouldAttemptCollection(
        strict,
        { dueDate: '2026-03-01', attempts: 3, lastAttemptDate: '2026-03-07' },
        '2026-03-20',
      ),
    ).toBe(false);
  });

  it('holds the next payout only when the policy says so', () => {
    expect(shouldHoldPayout(baseline, '2026-01-01', '2026-06-01')).toBe(false);
    expect(shouldHoldPayout(strict, null, '2026-06-01')).toBe(false);
    expect(shouldHoldPayout(strict, '2026-05-29', '2026-06-01')).toBe(false);
    expect(shouldHoldPayout(strict, '2026-05-15', '2026-06-01')).toBe(true);
  });

  it('writes off at the configured age, never under baseline', () => {
    expect(shouldChargeOff(baseline, '2020-01-01', '2026-01-01')).toBe(false);
    expect(shouldChargeOff(strict, '2026-01-01', '2026-03-31')).toBe(false);
    expect(shouldChargeOff(strict, '2026-01-01', '2026-04-01')).toBe(true);
    expect(expectedRecoveryCents(strict, 123_456)).toBe(12_346);
  });
});

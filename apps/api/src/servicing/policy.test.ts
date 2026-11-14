import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_SERVICING_POLICY,
  attemptsExhausted,
  balanceCoversDebit,
  BASELINE_SERVICING_POLICY,
  classifyReturnCode,
  daysPastDue,
  delinquencyBucket,
  expectedRecoveryCents,
  isLate,
  OPEN_BUCKETS,
  payoutAction,
  requiredAllowanceCents,
  reserveCents,
  RESERVE_MARGIN_BPS,
  reserveRateFor,
  RETURN_CODES,
  returnCodeReason,
  shouldAttemptCollection,
  shouldChargeOff,
  shouldHoldPayout,
  STANDARD_SERVICING_POLICY,
  type ServicingPolicy,
} from './policy.ts';

const baseline = BASELINE_SERVICING_POLICY;
const standard = STANDARD_SERVICING_POLICY;
const strict: ServicingPolicy = {
  ...STANDARD_SERVICING_POLICY,
  name: 'strict',
  provisionRatesBps: { CURRENT: 100, GRACE: 1000, DELINQUENT: 5000, DEFAULT: 9000 },
};

describe('servicing policy', () => {
  it('the services run the standard policy', () => {
    expect(ACTIVE_SERVICING_POLICY).toBe(STANDARD_SERVICING_POLICY);
  });

  it('baseline describes the services before Phase R3', () => {
    expect(baseline.lateGraceDays).toBe(3);
    expect(baseline.retry).toEqual({ intervalDays: 1, maxAttempts: null, balancePreCheck: false });
    expect(baseline.holdPayoutPastDueDays).toBeNull();
    expect(baseline.chargeOffAfterDays).toBeNull();
  });

  it('counts days past due and applies the grace period', () => {
    expect(daysPastDue('2026-03-01', '2026-02-27')).toBe(0);
    expect(daysPastDue('2026-03-01', '2026-03-05')).toBe(4);
    expect(isLate(baseline, '2026-03-01', '2026-03-04')).toBe(false);
    expect(isLate(baseline, '2026-03-01', '2026-03-05')).toBe(true);
  });

  it('buckets a plan by the age of its oldest unpaid installment', () => {
    const bucket = (days: number) => delinquencyBucket(standard, days);
    expect(bucket(0)).toBe('CURRENT');
    expect(bucket(-2)).toBe('CURRENT');
    expect(bucket(1)).toBe('GRACE');
    expect(bucket(3)).toBe('GRACE');
    expect(bucket(4)).toBe('DELINQUENT');
    expect(bucket(29)).toBe('DELINQUENT');
    expect(bucket(30)).toBe('DEFAULT');
    expect(bucket(89)).toBe('DEFAULT');
    // Reaching the charge-off age does not change the bucket by itself: the write off does.
    expect(bucket(400)).toBe('DEFAULT');
    // Once written off, always written off, whatever is paid later.
    expect(delinquencyBucket(standard, 0, true)).toBe('CHARGED_OFF');
    expect(delinquencyBucket(standard, 120, true)).toBe('CHARGED_OFF');
    // The boundaries come from the policy.
    const loose = { ...standard, lateGraceDays: 5, defaultAfterDays: 60 };
    expect(delinquencyBucket(loose, 5)).toBe('GRACE');
    expect(delinquencyBucket(loose, 6)).toBe('DELINQUENT');
    expect(delinquencyBucket(loose, 59)).toBe('DELINQUENT');
    expect(delinquencyBucket(loose, 60)).toBe('DEFAULT');
  });

  it('baseline retries every day without limit', () => {
    const state = { dueDate: '2026-03-01', attempts: 400, lastAttemptDate: '2027-04-04' };
    expect(shouldAttemptCollection(baseline, state, '2027-04-05')).toBe(true);
    expect(attemptsExhausted(baseline, 400)).toBe(false);
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
    expect(shouldAttemptCollection(strict, first, '2026-03-01')).toBe(false);
    expect(shouldAttemptCollection(strict, first, '2026-03-02')).toBe(false);
    expect(shouldAttemptCollection(strict, first, '2026-03-04')).toBe(true);
    expect(
      shouldAttemptCollection(
        strict,
        { dueDate: '2026-03-01', attempts: 3, lastAttemptDate: '2026-03-07' },
        '2026-03-20',
      ),
    ).toBe(false);
    expect(attemptsExhausted(strict, 2)).toBe(false);
    expect(attemptsExhausted(strict, 3)).toBe(true);
  });

  it('puts a debit off only when the balance is known to be short', () => {
    expect(balanceCoversDebit(standard, 99_999, 100_000)).toBe(false);
    expect(balanceCoversDebit(standard, 100_000, 100_000)).toBe(true);
    expect(balanceCoversDebit(standard, -500, 100_000)).toBe(false);
    // No reading is not a reason to hold a debit back.
    expect(balanceCoversDebit(standard, null, 100_000)).toBe(true);
    // A policy without the check never holds one back.
    expect(balanceCoversDebit(baseline, 0, 100_000)).toBe(true);
  });

  it('holds the next payout only when the policy says so', () => {
    expect(shouldHoldPayout(baseline, '2026-01-01', '2026-06-01')).toBe(false);
    expect(shouldHoldPayout(strict, null, '2026-06-01')).toBe(false);
    expect(shouldHoldPayout(strict, '2026-05-29', '2026-06-01')).toBe(false);
    expect(shouldHoldPayout(strict, '2026-05-15', '2026-06-01')).toBe(true);
  });

  it('pays, holds, or cancels an unpaid payout by the release window', () => {
    const due = '2026-06-01';
    expect(standard.payoutReleaseWindowDays).toBe(5);
    // Not due yet: nothing to decide, held or not.
    expect(payoutAction(standard, due, false, '2026-05-31')).toBe('wait');
    expect(payoutAction(standard, due, true, '2026-05-31')).toBe('wait');
    // Inside the window: held while something holds it, paid as soon as nothing does.
    expect(payoutAction(standard, due, false, '2026-06-01')).toBe('pay');
    expect(payoutAction(standard, due, true, '2026-06-01')).toBe('hold');
    expect(payoutAction(standard, due, true, '2026-06-06')).toBe('hold');
    expect(payoutAction(standard, due, false, '2026-06-06')).toBe('pay');
    // Past the window: cancelled, never paid late, even if the hold has cleared.
    expect(payoutAction(standard, due, true, '2026-06-07')).toBe('cancel');
    expect(payoutAction(standard, due, false, '2026-06-07')).toBe('cancel');
    expect(
      payoutAction({ ...standard, payoutReleaseWindowDays: 0 }, due, false, '2026-06-02'),
    ).toBe('cancel');
    // Baseline never cancels: an unpaid payout waits, and nothing ever holds one.
    expect(baseline.payoutReleaseWindowDays).toBeNull();
    expect(payoutAction(baseline, due, false, '2027-01-01')).toBe('pay');
  });

  it('writes off at the configured age, never under baseline', () => {
    expect(shouldChargeOff(baseline, '2020-01-01', '2026-01-01')).toBe(false);
    expect(shouldChargeOff(strict, '2026-01-01', '2026-03-31')).toBe(false);
    expect(shouldChargeOff(strict, '2026-01-01', '2026-04-01')).toBe(true);
    expect(expectedRecoveryCents(strict, 123_456)).toBe(12_346);
  });

  it('reserves by bucket at the policy rates', () => {
    expect(reserveCents(strict, 'CURRENT', 1_000_000)).toBe(10_000);
    expect(reserveCents(strict, 'GRACE', 1_000_000)).toBe(100_000);
    expect(reserveCents(strict, 'DELINQUENT', 310_000)).toBe(155_000);
    expect(reserveCents(strict, 'DEFAULT', 310_000)).toBe(279_000);
    // Rounded to the cent, and a credit balance reserves nothing.
    expect(reserveCents(strict, 'CURRENT', 149)).toBe(1);
    expect(reserveCents(strict, 'DEFAULT', -5_000)).toBe(0);
    expect(
      requiredAllowanceCents(strict, { CURRENT: 1_000_000, DELINQUENT: 310_000, DEFAULT: 310_000 }),
    ).toBe(10_000 + 155_000 + 279_000);
    expect(requiredAllowanceCents(strict, {})).toBe(0);
  });

  it('standard reserve rates rise with the bucket and never exceed the balance', () => {
    const rates = OPEN_BUCKETS.map((b) => standard.provisionRatesBps[b]);
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
    expect(rates[0]).toBeGreaterThan(0);
    expect(rates[rates.length - 1]).toBeLessThanOrEqual(10_000);
  });

  it('classifies return codes', () => {
    for (const code of ['R01', 'R09']) expect(classifyReturnCode(code)).toBe('RETRYABLE');
    for (const code of ['R02', 'R03', 'R04', 'R08', 'R13', 'R16', 'R20']) {
      expect(classifyReturnCode(code)).toBe('HARD');
    }
    for (const code of ['R05', 'R07', 'R10', 'R29']) {
      expect(classifyReturnCode(code)).toBe('UNAUTHORIZED');
    }
    // Case does not matter, and a code the table does not know stops debits.
    expect(classifyReturnCode('r10')).toBe('UNAUTHORIZED');
    expect(classifyReturnCode('R99')).toBe('HARD');
    expect(classifyReturnCode('')).toBe('HARD');
    expect(returnCodeReason('R01')).toBe('Insufficient funds');
    expect(returnCodeReason('R99')).toBe('Returned by the bank');
    // Every code in the table has a class and a reason.
    for (const [code, entry] of Object.entries(RETURN_CODES)) {
      expect(code).toMatch(/^R\d{2}$/);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it('standard holds payouts past grace, caps retries at three, and writes off at 90 days', () => {
    expect(standard).toMatchObject({
      name: 'standard',
      lateGraceDays: 3,
      defaultAfterDays: 30,
      retry: { intervalDays: 3, maxAttempts: 3, balancePreCheck: true },
      holdPayoutPastDueDays: 3,
      payoutReleaseWindowDays: 5,
      chargeOffAfterDays: 90,
      recoveryRateBps: baseline.recoveryRateBps,
    });
    // Attempts on the due date, then days 3 and 6, and no more after that.
    const state = { dueDate: '2026-03-01', attempts: 0, lastAttemptDate: null as string | null };
    const attempted: string[] = [];
    for (let day = 1; day <= 31; day++) {
      const date = `2026-03-${String(day).padStart(2, '0')}`;
      if (shouldAttemptCollection(standard, state, date)) {
        attempted.push(date);
        state.attempts += 1;
        state.lastAttemptDate = date;
      }
    }
    expect(attempted).toEqual(['2026-03-01', '2026-03-04', '2026-03-07']);
    // Three days past due is still grace. The fourth day holds the next payout.
    expect(shouldHoldPayout(standard, '2026-03-01', '2026-03-04')).toBe(false);
    expect(shouldHoldPayout(standard, '2026-03-01', '2026-03-05')).toBe(true);
    expect(shouldHoldPayout(standard, null, '2026-04-01')).toBe(false);
    expect(shouldChargeOff(standard, '2026-03-01', '2026-05-29')).toBe(false);
    expect(shouldChargeOff(standard, '2026-03-01', '2026-05-30')).toBe(true);
  });
});

describe('reserve rates against the measured roll rates', () => {
  it('applies the stated margin: a quarter of the rate, rounded up to 5 bps, at most 100%', () => {
    expect(RESERVE_MARGIN_BPS).toBe(2500);
    expect(reserveRateFor(44)).toBe(55);
    expect(reserveRateFor(40)).toBe(50);
    expect(reserveRateFor(7947)).toBe(9935);
    expect(reserveRateFor(9259)).toBe(10_000);
    expect(reserveRateFor(0)).toBe(0);
  });

  it('never reserves below the roll rate the checked in evaluation measured', () => {
    const baseline = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../evals/baseline.json', import.meta.url)), 'utf8'),
    ) as {
      run: { gated: string };
      configurations: Record<
        string,
        {
          headline: {
            base: {
              rollRateBpsByBucket: Record<string, number>;
              entryRollRateBpsByBucket: Record<string, number>;
            };
          };
        }
      >;
    };
    const measured = baseline.configurations[baseline.run.gated]!.headline.base;
    for (const bucket of OPEN_BUCKETS) {
      const roll = Math.max(
        measured.rollRateBpsByBucket[bucket] ?? 0,
        measured.entryRollRateBpsByBucket[bucket] ?? 0,
      );
      expect(STANDARD_SERVICING_POLICY.provisionRatesBps[bucket], bucket).toBeGreaterThanOrEqual(
        roll,
      );
    }
  });
});

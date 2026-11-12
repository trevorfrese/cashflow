import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { AS_OF, expectDedupes, inputs, run } from '../test-support.ts';
import type { BooksFact, JobFact } from '../types.ts';
import {
  allowanceNegative,
  appendOnlyTriggersMissing,
  cashNotSwept,
  jobStale,
  landlordPayableMismatch,
  passThroughPaidBeforeSettlement,
  poolNegative,
  receivableMismatch,
  trialBalanceUnbalanced,
} from './books.ts';

const books = (over: Partial<BooksFact>) => inputs({ books: { ...inputs().books, ...over } });

describe('books.trial_balance_unbalanced', () => {
  it('is critical when debits and credits differ', () => {
    const data = books({ totalDebitsCents: 1000, totalCreditsCents: 900 });
    expect(run(trialBalanceUnbalanced, data)).toMatchObject([
      { severity: 'CRITICAL', detail: { differenceCents: 100 } },
    ]);
    expectDedupes(trialBalanceUnbalanced, data);
  });

  it('does not fire on a balanced ledger, and is never resolved by the monitor', () => {
    expect(run(trialBalanceUnbalanced, inputs())).toEqual([]);
    expect(trialBalanceUnbalanced.autoResolves).toBe(false);
  });
});

describe('books.cash_not_swept', () => {
  const posted = '2026-11-10T08:00:00.000Z';

  it('fires when cash is left after a collection run that finished later', () => {
    const data = books({
      cashCents: 312_000,
      lastCashPostingAt: posted,
      lastSweepAt: '2026-11-10T09:00:00.000Z',
    });
    expect(run(cashNotSwept, data)).toMatchObject([
      { severity: 'HIGH', detail: { cashCents: 312_000 } },
    ]);
    expectDedupes(cashNotSwept, data);
  });

  it('does not fire when cash is zero, or is waiting for the next run', () => {
    expect(run(cashNotSwept, inputs())).toEqual([]);
    // A manual payment after the last run: the next run sweeps it.
    expect(
      run(
        cashNotSwept,
        books({
          cashCents: 312_000,
          lastCashPostingAt: posted,
          lastSweepAt: '2026-11-10T07:00:00.000Z',
        }),
      ),
    ).toEqual([]);
    expect(
      run(
        cashNotSwept,
        books({ cashCents: 312_000, lastCashPostingAt: posted, lastSweepAt: null }),
      ),
    ).toEqual([]);
  });
});

describe('books.receivable_mismatch', () => {
  const row = (ledgerCents: number, expectedCents: number) => ({
    businessId: 'biz1',
    businessName: 'Blue Door Bakery',
    ledgerCents,
    expectedCents,
  });

  it('is critical when the ledger and the installments disagree, in either direction', () => {
    for (const [ledger, expected] of [
      [500_000, 310_000],
      [310_000, 500_000],
    ] as const) {
      const data = books({ receivables: [row(ledger, expected)] });
      expect(run(receivableMismatch, data)).toMatchObject([
        {
          severity: 'CRITICAL',
          subjectType: 'business',
          subjectId: 'biz1',
          detail: { differenceCents: ledger - expected },
        },
      ]);
      expectDedupes(receivableMismatch, data);
    }
  });

  it('does not fire when they agree, including on a credit left by a returned payout', () => {
    expect(run(receivableMismatch, books({ receivables: [row(310_000, 310_000)] }))).toEqual([]);
    expect(run(receivableMismatch, books({ receivables: [row(-310_000, -310_000)] }))).toEqual([]);
  });
});

describe('books.allowance_negative and books.pool_negative', () => {
  it('fire on a negative balance', () => {
    const allowance = books({ allowanceCents: -1 });
    expect(run(allowanceNegative, allowance)).toMatchObject([{ severity: 'CRITICAL' }]);
    expectDedupes(allowanceNegative, allowance);
    const pool = books({ poolCents: -50_000 });
    expect(run(poolNegative, pool)).toMatchObject([{ severity: 'CRITICAL' }]);
    expectDedupes(poolNegative, pool);
  });

  it('do not fire at zero or above', () => {
    expect(run(allowanceNegative, books({ allowanceCents: 0 }))).toEqual([]);
    expect(run(poolNegative, books({ poolCents: 0 }))).toEqual([]);
  });
});

describe('books.job_stale', () => {
  const job = (over: Partial<JobFact> = {}): JobFact => ({
    name: 'process-payouts',
    lastRun: { asOf: AS_OF, ok: true, error: null },
    lastOkAsOf: AS_OF,
    ...over,
  });

  it('fires when the last run failed', () => {
    const data = inputs({
      jobs: [
        job({
          lastRun: { asOf: AS_OF, ok: false, error: 'connection refused' },
          lastOkAsOf: addDays(AS_OF, -1),
        }),
      ],
    });
    expect(run(jobStale, data)).toMatchObject([
      {
        severity: 'HIGH',
        subjectType: 'job',
        subjectId: 'process-payouts',
        detail: { error: 'connection refused' },
      },
    ]);
    expectDedupes(jobStale, data);
  });

  it('fires when the last good run is more than a day behind', () => {
    const two = addDays(AS_OF, -2);
    expect(
      run(
        jobStale,
        inputs({ jobs: [job({ lastRun: { asOf: two, ok: true, error: null }, lastOkAsOf: two })] }),
      ),
    ).toMatchObject([{ detail: { gapDays: 2 } }]);
  });

  it('fires for a job that has never run while others have', () => {
    expect(
      run(
        jobStale,
        inputs({ jobs: [job(), job({ name: 'provision', lastRun: null, lastOkAsOf: null })] }),
      ),
    ).toMatchObject([{ subjectId: 'provision' }]);
  });

  it('does not fire for jobs that ran today or yesterday, or on a fresh install', () => {
    const yesterday = addDays(AS_OF, -1);
    expect(
      run(
        jobStale,
        inputs({
          jobs: [
            job(),
            job({ lastRun: { asOf: yesterday, ok: true, error: null }, lastOkAsOf: yesterday }),
          ],
        }),
      ),
    ).toEqual([]);
    expect(run(jobStale, inputs({ jobs: [job({ lastRun: null, lastOkAsOf: null })] }))).toEqual([]);
  });
});

describe('books.append_only_triggers_missing', () => {
  it('is critical when a guard is missing or disabled', () => {
    const data = books({
      appendOnlyTriggers: ['LedgerEntry', 'LedgerTransaction', 'AdverseActionNotice'],
    });
    expect(run(appendOnlyTriggersMissing, data)).toMatchObject([
      { severity: 'CRITICAL', detail: { missing: ['AuditEvent'] } },
    ]);
    expectDedupes(appendOnlyTriggersMissing, data);
  });

  it('does not fire when every guard is in place', () => {
    expect(run(appendOnlyTriggersMissing, inputs())).toEqual([]);
  });
});

describe('books.pass_through_payout_before_settlement', () => {
  const unsettled = {
    periodId: 'ptp1',
    rentPlanId: 'plan1',
    businessId: 'biz1',
    periodMonth: '2026-12',
    status: 'PAID',
    collectedOn: '2026-11-24',
    settlesOn: '2026-11-27',
    paidOn: '2026-11-25',
    dueDate: '2026-12-01',
    reason: 'PAID_BEFORE_SETTLEMENT',
  };

  it('is critical for a landlord paid without a settled collection, one alert per month', () => {
    const data = books({ passThroughUnsettledPayouts: [unsettled] });
    expect(run(passThroughPaidBeforeSettlement, data)).toMatchObject([
      {
        severity: 'CRITICAL',
        subjectType: 'rent_plan',
        subjectId: 'plan1',
        dedupeKey: 'pass_through_unsettled_payout:ptp1',
        detail: { reason: 'PAID_BEFORE_SETTLEMENT' },
      },
    ]);
    expectDedupes(passThroughPaidBeforeSettlement, data);
    // Money that went out cannot be unsent: a person closes it.
    expect(passThroughPaidBeforeSettlement.autoResolves).toBe(false);
  });

  it('does not fire when every pass-through payment had settled money behind it', () => {
    expect(run(passThroughPaidBeforeSettlement, inputs())).toEqual([]);
  });
});

describe('books.landlord_payable_mismatch', () => {
  it('is critical when the liability is not the collected and unpaid months', () => {
    const data = books({
      landlordPayableCents: 500_000,
      passThroughCashCents: 500_000,
      passThroughHeldCents: 300_000,
    });
    expect(run(landlordPayableMismatch, data)).toMatchObject([
      { severity: 'CRITICAL', detail: { differenceCents: 200_000 } },
    ]);
    expectDedupes(landlordPayableMismatch, data);
  });

  it('is critical when the cash behind it is short', () => {
    const data = books({
      landlordPayableCents: 300_000,
      passThroughCashCents: 100_000,
      passThroughHeldCents: 300_000,
    });
    expect(run(landlordPayableMismatch, data)).toHaveLength(1);
  });

  it('does not fire when all three agree', () => {
    expect(
      run(
        landlordPayableMismatch,
        books({
          landlordPayableCents: 300_000,
          passThroughCashCents: 300_000,
          passThroughHeldCents: 300_000,
        }),
      ),
    ).toEqual([]);
    expect(run(landlordPayableMismatch, inputs())).toEqual([]);
  });
});

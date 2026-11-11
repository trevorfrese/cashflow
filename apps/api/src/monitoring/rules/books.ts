import { daysBetween } from '@cashflow/shared';

import type { AlertCandidate, Rule } from '../types.ts';

/**
 * Books and operations rules: the ledger agrees with itself and with the records it was
 * posted from, the jobs are running, and the guards on history are in place.
 */

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Tables whose rows are history. A row trigger on each rejects UPDATE and DELETE. */
export const APPEND_ONLY_TABLES = ['AuditEvent', 'LedgerEntry', 'LedgerTransaction'] as const;

export const trialBalanceUnbalanced: Rule = {
  type: 'books.trial_balance_unbalanced',
  category: 'BOOKS',
  description:
    'Total debits do not equal total credits. The ledger service refuses unbalanced postings, so this means rows were written around it.',
  // Appended rows cannot fix themselves. Whatever balanced it again needs explaining.
  autoResolves: false,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) => {
    const { totalDebitsCents, totalCreditsCents } = inputs.books;
    if (totalDebitsCents === totalCreditsCents) return [];
    return [
      {
        type: 'books.trial_balance_unbalanced',
        category: 'BOOKS',
        severity: 'CRITICAL',
        subjectType: 'ledger',
        subjectId: 'trial_balance',
        title: `Trial balance is out by ${usd(Math.abs(totalDebitsCents - totalCreditsCents))}`,
        detail: {
          totalDebitsCents,
          totalCreditsCents,
          differenceCents: totalDebitsCents - totalCreditsCents,
        },
        dedupeKey: 'books.trial_balance_unbalanced',
      },
    ];
  },
};

export const cashNotSwept: Rule = {
  type: 'books.cash_not_swept',
  category: 'BOOKS',
  description:
    'Operating cash is not zero although a collection run, which ends by settling cash with the pool, has finished since the last posting to it.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) => {
    const { cashCents, lastCashPostingAt, lastSweepAt } = inputs.books;
    if (cashCents === 0) return [];
    // Cash collected since the last run is waiting for the next one. That is not a fault.
    if (lastSweepAt === null || lastCashPostingAt === null || lastSweepAt <= lastCashPostingAt) {
      return [];
    }
    return [
      {
        type: 'books.cash_not_swept',
        category: 'BOOKS',
        severity: 'HIGH',
        subjectType: 'ledger',
        subjectId: 'cash',
        title: `Operating cash is ${usd(cashCents)} after a full run, expected zero`,
        detail: { cashCents, lastCashPostingAt, lastSweepAt },
        dedupeKey: 'books.cash_not_swept',
      },
    ];
  },
};

export const receivableMismatch: Rule = {
  type: 'books.receivable_mismatch',
  category: 'BOOKS',
  description:
    'A business receivable account does not equal its unpaid principal on paid payouts, less the credit left by principal collected on a payout that was later returned.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) =>
    inputs.books.receivables
      .filter(
        (r) =>
          Math.abs(r.ledgerCents - r.expectedCents) > policy.operations.receivableToleranceCents,
      )
      .map((r): AlertCandidate => ({
        type: 'books.receivable_mismatch',
        category: 'BOOKS',
        severity: 'CRITICAL',
        subjectType: 'business',
        subjectId: r.businessId,
        title: `Receivable for ${r.businessName} is ${usd(r.ledgerCents)} in the ledger, ${usd(r.expectedCents)} by installments`,
        detail: {
          businessId: r.businessId,
          ledgerCents: r.ledgerCents,
          expectedCents: r.expectedCents,
          differenceCents: r.ledgerCents - r.expectedCents,
        },
        dedupeKey: `receivable_mismatch:${r.businessId}`,
      })),
};

export const allowanceNegative: Rule = {
  type: 'books.allowance_negative',
  category: 'BOOKS',
  description:
    'The allowance for credit losses has a debit balance: more was written off against it than was ever provided.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) =>
    inputs.books.allowanceCents >= 0
      ? []
      : [
          {
            type: 'books.allowance_negative',
            category: 'BOOKS',
            severity: 'CRITICAL',
            subjectType: 'ledger',
            subjectId: 'allowance:credit_losses',
            title: `Allowance for credit losses is negative: ${usd(inputs.books.allowanceCents)}`,
            detail: { allowanceCents: inputs.books.allowanceCents },
            dedupeKey: 'books.allowance_negative',
          },
        ],
};

export const poolNegative: Rule = {
  type: 'books.pool_negative',
  category: 'BOOKS',
  description: 'The capital pool has a negative balance: more was paid out than it held.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) =>
    inputs.books.poolCents >= 0
      ? []
      : [
          {
            type: 'books.pool_negative',
            category: 'BOOKS',
            severity: 'CRITICAL',
            subjectType: 'ledger',
            subjectId: 'capital_pool',
            title: `Capital pool is negative: ${usd(inputs.books.poolCents)}`,
            detail: { poolCents: inputs.books.poolCents },
            dedupeKey: 'books.pool_negative',
          },
        ],
};

export const jobStale: Rule = {
  type: 'books.job_stale',
  category: 'BOOKS',
  description:
    'A scheduled job failed on its last run, or has not completed a run for longer than its expected interval. Measured in as-of dates against the monitor run, so it reads the same on replayed history.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    // A fresh install has run nothing. That is not an outage.
    if (!inputs.jobs.some((j) => j.lastRun !== null)) return [];
    const out: AlertCandidate[] = [];
    for (const job of inputs.jobs) {
      const failed = job.lastRun !== null && job.lastRun.ok === false;
      const gap = job.lastOkAsOf === null ? null : daysBetween(job.lastOkAsOf, inputs.asOf);
      const missed = gap === null || gap > policy.operations.maxJobGapDays;
      if (!failed && !missed) continue;
      out.push({
        type: 'books.job_stale',
        category: 'BOOKS',
        severity: 'HIGH',
        subjectType: 'job',
        subjectId: job.name,
        title: failed
          ? `Job ${job.name} failed on its last run`
          : job.lastOkAsOf === null
            ? `Job ${job.name} has never completed a run`
            : `Job ${job.name} last completed for ${job.lastOkAsOf}, ${gap} days ago`,
        detail: {
          job: job.name,
          lastRunAsOf: job.lastRun?.asOf ?? null,
          lastRunOk: job.lastRun?.ok ?? null,
          error: job.lastRun?.error ?? null,
          lastOkAsOf: job.lastOkAsOf,
          gapDays: gap,
          maxGapDays: policy.operations.maxJobGapDays,
        },
        dedupeKey: `job_stale:${job.name}`,
      });
    }
    return out;
  },
};

export const appendOnlyTriggersMissing: Rule = {
  type: 'books.append_only_triggers_missing',
  category: 'BOOKS',
  description:
    'A database trigger that rejects UPDATE and DELETE on the ledger or the audit log is missing or disabled, so history could be rewritten.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) => {
    const present = new Set(inputs.books.appendOnlyTriggers);
    const missing = APPEND_ONLY_TABLES.filter((t) => !present.has(t));
    if (missing.length === 0) return [];
    return [
      {
        type: 'books.append_only_triggers_missing',
        category: 'BOOKS',
        severity: 'CRITICAL',
        subjectType: 'ledger',
        subjectId: 'append_only_triggers',
        title: `Append-only guard missing on ${missing.join(', ')}`,
        detail: { missing, present: [...present] },
        dedupeKey: 'books.append_only_triggers_missing',
      },
    ];
  },
};

export const BOOKS_RULES: Rule[] = [
  trialBalanceUnbalanced,
  cashNotSwept,
  receivableMismatch,
  allowanceNegative,
  poolNegative,
  jobStale,
  appendOnlyTriggersMissing,
];

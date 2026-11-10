import type { LedgerDirection } from '@cashflow/shared';

export interface EntryInput {
  accountCode: string;
  direction: LedgerDirection;
  amountCents: number;
}

export class UnbalancedTransactionError extends Error {
  constructor(
    readonly debitsCents: number,
    readonly creditsCents: number,
  ) {
    super(`Ledger transaction is unbalanced: debits ${debitsCents} != credits ${creditsCents}`);
    this.name = 'UnbalancedTransactionError';
  }
}

/**
 * Pure validation for a set of ledger entries. Throws unless there are at least two entries,
 * every amount is a positive integer, and total debits equal total credits.
 */
export function validateEntries(entries: EntryInput[]): {
  debitsCents: number;
  creditsCents: number;
} {
  if (entries.length < 2) {
    throw new Error('A ledger transaction needs at least two entries');
  }
  let debitsCents = 0;
  let creditsCents = 0;
  for (const e of entries) {
    if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) {
      throw new Error(`Ledger entry amount must be a positive integer, got ${e.amountCents}`);
    }
    if (e.direction === 'DEBIT') debitsCents += e.amountCents;
    else creditsCents += e.amountCents;
  }
  if (debitsCents !== creditsCents) {
    throw new UnbalancedTransactionError(debitsCents, creditsCents);
  }
  return { debitsCents, creditsCents };
}

/** Signed natural balance for an account type. Debit-normal accounts are positive when debits exceed credits. */
export function naturalBalance(
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE',
  debitsCents: number,
  creditsCents: number,
): number {
  const debitNormal = type === 'ASSET' || type === 'EXPENSE';
  return debitNormal ? debitsCents - creditsCents : creditsCents - debitsCents;
}

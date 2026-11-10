import { describe, expect, it } from 'vitest';

import { naturalBalance, UnbalancedTransactionError, validateEntries } from './validate';

describe('validateEntries', () => {
  it('accepts a balanced transaction', () => {
    expect(
      validateEntries([
        { accountCode: 'a', direction: 'DEBIT', amountCents: 500 },
        { accountCode: 'b', direction: 'CREDIT', amountCents: 300 },
        { accountCode: 'c', direction: 'CREDIT', amountCents: 200 },
      ]),
    ).toEqual({ debitsCents: 500, creditsCents: 500 });
  });

  it('rejects an unbalanced transaction', () => {
    expect(() =>
      validateEntries([
        { accountCode: 'a', direction: 'DEBIT', amountCents: 500 },
        { accountCode: 'b', direction: 'CREDIT', amountCents: 499 },
      ]),
    ).toThrow(UnbalancedTransactionError);
  });

  it('rejects single entries, zero, negative, and fractional amounts', () => {
    expect(() =>
      validateEntries([{ accountCode: 'a', direction: 'DEBIT', amountCents: 5 }]),
    ).toThrow();
    expect(() =>
      validateEntries([
        { accountCode: 'a', direction: 'DEBIT', amountCents: 0 },
        { accountCode: 'b', direction: 'CREDIT', amountCents: 0 },
      ]),
    ).toThrow();
    expect(() =>
      validateEntries([
        { accountCode: 'a', direction: 'DEBIT', amountCents: -5 },
        { accountCode: 'b', direction: 'CREDIT', amountCents: -5 },
      ]),
    ).toThrow();
    expect(() =>
      validateEntries([
        { accountCode: 'a', direction: 'DEBIT', amountCents: 1.5 },
        { accountCode: 'b', direction: 'CREDIT', amountCents: 1.5 },
      ]),
    ).toThrow();
  });
});

describe('naturalBalance', () => {
  it('is debit-normal for assets and expenses', () => {
    expect(naturalBalance('ASSET', 1000, 400)).toBe(600);
    expect(naturalBalance('EXPENSE', 100, 0)).toBe(100);
  });
  it('is credit-normal for liabilities, equity, and revenue', () => {
    expect(naturalBalance('REVENUE', 0, 250)).toBe(250);
    expect(naturalBalance('EQUITY', 0, 25_000_000)).toBe(25_000_000);
    expect(naturalBalance('LIABILITY', 50, 100)).toBe(50);
  });
});

import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { healthyParams } from '../../evals/fixtures.ts';
import { generateSalesFromPath } from '../commerce/synthetic.ts';
import { NSF_FEE_CENTS, simulateBusiness } from './business-sim.ts';

const START = '2025-03-01';

describe('forward business simulator', () => {
  it('produces a history that is an exact prefix of a longer run', () => {
    const params = healthyParams({
      events: [
        { kind: 'revenue_shock', start: '2025-09-01', days: 60, depth: 0.4 },
        { kind: 'expense', date: '2025-06-10', shareOfMonthly: 0.2 },
      ],
    });
    const short = simulateBusiness(params, 'abcdef12', START, 300);
    const long = simulateBusiness(params, 'abcdef12', START, 700);

    expect(short.transactions.length).toBeGreaterThan(500);
    expect(long.transactions.slice(0, short.transactions.length)).toEqual(short.transactions);
    expect(long.dailyBalancesCents.slice(0, 300)).toEqual(short.dailyBalancesCents);
    expect(long.dailyBalancesCents[299]).toBe(short.endingBalanceCents);
    expect(long.dailySales.slice(0, short.dailySales.length)).toEqual(short.dailySales);
    // Every later transaction is dated after the short run ends.
    const lastShortDay = addDays(START, 299);
    for (const t of long.transactions.slice(short.transactions.length)) {
      expect(t.date > lastShortDay).toBe(true);
    }
  });

  it('gives the point of sale the same prefix property, on the same sales path', () => {
    const short = simulateBusiness(healthyParams(), 'abcdef12', START, 200);
    const long = simulateBusiness(healthyParams(), 'abcdef12', START, 400);
    const posShort = generateSalesFromPath(short.dailySales, 'abcdef12');
    const posLong = generateSalesFromPath(long.dailySales, 'abcdef12');
    expect(posLong.dailySales.slice(0, posShort.dailySales.length)).toEqual(posShort.dailySales);
    expect(posShort.connectedSince).toBe(short.dailySales[0]!.date);

    // Card settlements in the bank are 85% of the sales the point of sale reports.
    const day = long.dailySales[10]!;
    const settlement = long.transactions.find(
      (t) => t.date === day.date && t.category === 'CARD_SETTLEMENT',
    );
    expect(settlement?.amountCents).toBeGreaterThan(day.grossCents * 0.84);
    expect(settlement?.amountCents).toBeLessThan(day.grossCents * 0.86);
    expect(posLong.dailySales[10]!.grossCents).toBe(day.grossCents);
  });

  it('is deterministic for a seed and different across seeds', () => {
    const a = simulateBusiness(healthyParams(), 'abcdef12', START, 200);
    const b = simulateBusiness(healthyParams(), 'abcdef12', START, 200);
    const c = simulateBusiness(healthyParams(), '12abcdef', START, 200);
    expect(b).toEqual(a);
    expect(c.endingBalanceCents).not.toBe(a.endingBalanceCents);
    expect(c.transactions.map((t) => t.amountCents)).not.toEqual(
      a.transactions.map((t) => t.amountCents),
    );
  });

  it('an external debit that clears reduces the balance by its amount', () => {
    const debitDay = addDays(START, 100);
    const results: boolean[] = [];
    const without = simulateBusiness(healthyParams(), 'abcdef12', START, 101);
    const withDebit = simulateBusiness(healthyParams(), 'abcdef12', START, 101, {
      externalDebits: (date) =>
        date === debitDay ? [{ amountCents: 150_000, description: 'INSTALLMENT' }] : [],
      onDebitResult: (_date, _debit, ok) => results.push(ok),
    });
    expect(results).toEqual([true]);
    expect(withDebit.endingBalanceCents).toBe(without.endingBalanceCents - 150_000);
    expect(withDebit.transactions.some((t) => t.description === 'INSTALLMENT')).toBe(true);
  });

  it('an external debit fails when the balance cannot cover it, and moves no principal', () => {
    const debitDay = addDays(START, 100);
    const params = healthyParams({ ownerReserveCents: 0 });
    const results: boolean[] = [];
    const without = simulateBusiness(params, 'abcdef12', START, 101);
    const tooMuch = without.endingBalanceCents + 5_000_000;
    const withDebit = simulateBusiness(params, 'abcdef12', START, 101, {
      externalDebits: (date) =>
        date === debitDay ? [{ amountCents: tooMuch, description: 'INSTALLMENT' }] : [],
      onDebitResult: (_date, _debit, ok) => results.push(ok),
    });
    expect(results).toEqual([false]);
    // The only cost of the failed attempt is the bank's returned item fee.
    expect(withDebit.endingBalanceCents).toBe(without.endingBalanceCents - NSF_FEE_CENTS);
    expect(withDebit.transactions.some((t) => t.description === 'INSTALLMENT')).toBe(false);
  });

  it('stops the landlord rent debit once rent is paid externally', () => {
    const from = addDays(START, 200);
    const run = simulateBusiness(healthyParams(), 'abcdef12', START, 400, {
      rentExternalFrom: from,
    });
    const rents = run.transactions.filter((t) => t.category === 'RENT');
    expect(rents.length).toBeGreaterThan(5);
    expect(rents.every((t) => t.date < from)).toBe(true);
  });

  it('a closure empties the account and every later debit fails', () => {
    const params = healthyParams({ events: [{ kind: 'closure', date: '2025-08-15' }] });
    const results: { date: string; ok: boolean }[] = [];
    const run = simulateBusiness(params, 'abcdef12', START, 300, {
      externalDebits: (date) =>
        date.endsWith('-01') ? [{ amountCents: 100_000, description: 'INSTALLMENT' }] : [],
      onDebitResult: (date, _debit, ok) => results.push({ date, ok }),
    });
    expect(run.closedOn).toBe('2025-08-15');
    expect(run.endingBalanceCents).toBe(0);
    expect(results.filter((r) => r.date < '2025-08-15').every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.date > '2025-08-15').length).toBeGreaterThan(2);
    expect(results.filter((r) => r.date > '2025-08-15').some((r) => r.ok)).toBe(false);
    expect(run.transactions.every((t) => t.date <= '2025-08-15')).toBe(true);
  });

  it('a revenue shock lowers deposits while it lasts and costs fall by less', () => {
    const calm = simulateBusiness(healthyParams(), 'abcdef12', START, 300);
    const shocked = simulateBusiness(
      healthyParams({
        events: [{ kind: 'revenue_shock', start: '2025-07-01', days: 90, depth: 0.5 }],
      }),
      'abcdef12',
      START,
      300,
    );
    const sum = (run: typeof calm, category: string) =>
      run.transactions
        .filter((t) => t.category === category && t.date >= '2025-07-01' && t.date < '2025-09-29')
        .reduce((a, t) => a + t.amountCents, 0);
    expect(sum(shocked, 'CARD_SETTLEMENT') / sum(calm, 'CARD_SETTLEMENT')).toBeCloseTo(0.5, 2);
    // costFlex 0.5: payroll falls a quarter when revenue falls a half.
    expect(sum(shocked, 'PAYROLL') / sum(calm, 'PAYROLL')).toBeCloseTo(0.75, 2);
    expect(shocked.endingBalanceCents).toBeLessThan(calm.endingBalanceCents);
  });
});

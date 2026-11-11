import type { BankTransaction, PlatformPayout } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { tx } from '../underwriting/test-support.ts';
import { reconcileSettlements } from './reconcile.ts';
import { AS_OF, POLICY, payoutsFor, salesFor, variedAccount as account } from './test-support.ts';

const R = POLICY.reconciliation;
const run = (payouts: PlatformPayout[], deposits: BankTransaction[], masks = ['4821']) =>
  reconcileSettlements(
    {
      asOf: AS_OF,
      platform: 'SQUARE',
      connectionId: 'pos_1',
      payouts,
      deposits,
      linkedMasks: new Set(masks),
      dailySales: salesFor(deposits),
    },
    R,
  );

describe('settlement reconciliation', () => {
  it('matches every payout to its deposit', () => {
    const txs = account();
    const r = run(payoutsFor(txs), txs);
    expect(r.payoutsConsidered).toBeGreaterThan(70);
    expect(r.matchedShareByCountBps).toBe(10_000);
    expect(r.matchedShareByAmountBps).toBe(10_000);
    expect(r.claimedUnmatchedDeposits).toBe(0);
  });

  it('tolerates holds, small adjustments, split deposits, and batching', () => {
    const txs = account();
    const payouts = payoutsFor(txs).map((p, i) => ({
      ...p,
      // A hold: the platform dates it three days before the bank posts it.
      date: i % 7 === 0 ? addDays(p.date, -3) : p.date,
      // A few dollars of rounding on some.
      amountCents: i % 5 === 0 ? p.amountCents + 40 : p.amountCents,
    }));
    // The bank splits one deposit in two; and two payouts arrive as one deposit.
    const deposits = [...txs];
    const k = deposits.findIndex(
      (t) => t.category === 'CARD_SETTLEMENT' && t.date > addDays(AS_OF, -60),
    );
    const split = deposits[k]!;
    deposits.splice(
      k,
      1,
      { ...split, id: 'a', amountCents: 40_000 },
      { ...split, id: 'b', amountCents: split.amountCents - 40_000 },
    );
    const r = run(payouts, deposits);
    expect(r.matchedShareByAmountBps).toBe(10_000);

    const batched = payoutsFor(txs).flatMap((p) => [
      { ...p, id: `${p.id}a`, amountCents: Math.floor(p.amountCents / 2), locationId: 'L1' },
      { ...p, id: `${p.id}b`, amountCents: Math.ceil(p.amountCents / 2), locationId: 'L2' },
    ]);
    expect(run(batched, txs).matchedShareByAmountBps).toBe(10_000);
  });

  it('reports payouts that never arrived and deposits that claim the platform without one', () => {
    const txs = account();
    const payouts = payoutsFor(txs).map((p, i) =>
      i % 2 === 0 ? { ...p, amountCents: p.amountCents * 3 } : p,
    );
    const r = run(payouts, txs);
    expect(r.matchedShareByAmountBps!).toBeLessThan(5000);
    const claiming = txs.map((t) =>
      t.category === 'CARD_SETTLEMENT' ? { ...t, description: 'SQUARE INC SETTLEMENT' } : t,
    );
    const fewer = payoutsFor(txs).filter((_, i) => i % 3 !== 0);
    expect(run(fewer, claiming).claimedUnmatchedDeposits).toBeGreaterThan(10);
  });

  it('counts payouts to an account that is not connected apart', () => {
    const txs = account();
    const r = run(payoutsFor(txs, '0731'), txs);
    expect(r.payoutsConsidered).toBe(0);
    expect(r.unlinkedPayouts).toBeGreaterThan(70);
    expect(r.matchedShareByAmountBps).toBeNull();
  });

  it('measures payouts against card sales', () => {
    const txs = account();
    const r = run(payoutsFor(txs), txs);
    expect(r.payoutToCardSalesBps!).toBeGreaterThan(9500);
    expect(r.payoutToCardSalesBps!).toBeLessThan(10_500);
    const ignored = run(payoutsFor([tx(AS_OF, 100, 'CARD_SETTLEMENT')]), txs);
    expect(ignored.payoutToCardSalesBps).toBeNull();
  });
});

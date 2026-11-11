import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { account, tx } from '../underwriting/test-support.ts';
import { diffBankHistory, diffSalesHistory } from './consistency.ts';
import { AS_OF, POLICY, bankPull, salesFor } from './test-support.ts';

const C = POLICY.consistency;
const EARLIER = addDays(AS_OF, -20);

describe('history consistency', () => {
  const base = account({ asOf: EARLIER });
  const later = [...base, ...account({ asOf: AS_OF, days: 20 })];

  it('finds nothing when a later pull only adds new days', () => {
    const diff = diffBankHistory(bankPull(later), bankPull(base, EARLIER), C)!;
    expect(diff.changedItems).toBe(0);
    expect(diff.material).toBe(false);
  });

  it('forgives changes in the last days of the earlier pull and new ids', () => {
    const tail = later.map((t) =>
      t.date > addDays(EARLIER, -C.pendingToleranceDays) && t.amountCents > 0
        ? { ...t, amountCents: t.amountCents + 500 }
        : { ...t, id: `re-${t.id}`, description: 'RECATEGORIZED' },
    );
    expect(diffBankHistory(bankPull(tail), bankPull(base, EARLIER), C)!.changedItems).toBe(0);
  });

  it('flags removed debits in final days as material and flattering', () => {
    const removed = later.filter(
      (t) =>
        !(
          t.category === 'SUPPLIER' &&
          t.date < addDays(EARLIER, -30) &&
          t.date > addDays(EARLIER, -40)
        ),
    );
    const diff = diffBankHistory(bankPull(removed), bankPull(base, EARLIER), C)!;
    expect(diff.material).toBe(true);
    expect(diff.removed).toBeGreaterThanOrEqual(3);
    expect(diff.flatteringCents).toBeGreaterThan(0);
  });

  it('counts an altered amount once, and a single change is not material', () => {
    const k = later.findIndex((t) => t.date === addDays(EARLIER, -50) && t.amountCents > 0);
    const one = later.map((t, i) => (i === k ? { ...t, amountCents: t.amountCents + 1_000 } : t));
    const diff = diffBankHistory(bankPull(one), bankPull(base, EARLIER), C)!;
    expect(diff.altered).toBe(1);
    expect(diff.changedItems).toBe(1);
    expect(diff.material).toBe(false);
    const extra = [...later, tx(addDays(EARLIER, -60), 250_000, 'CARD_SETTLEMENT')];
    expect(diffBankHistory(bankPull(extra), bankPull(base, EARLIER), C)!.added).toBe(1);
  });

  it('compares daily sales by date', () => {
    const before = salesFor(base);
    const after = salesFor(later).map((d) =>
      d.date < addDays(EARLIER, -30) ? { ...d, grossCents: Math.round(d.grossCents * 1.2) } : d,
    );
    const window = { windowFrom: addDays(EARLIER, -399), windowTo: EARLIER };
    const diff = diffSalesHistory(
      { windowFrom: addDays(AS_OF, -399), windowTo: AS_OF, dailySales: after },
      { ...window, dailySales: before },
      C,
    )!;
    expect(diff.material).toBe(true);
    expect(diff.flatteringItems).toBe(diff.changedItems);
    const same = diffSalesHistory(
      { windowFrom: addDays(AS_OF, -399), windowTo: AS_OF, dailySales: salesFor(later) },
      { ...window, dailySales: before },
      C,
    )!;
    expect(same.changedItems).toBe(0);
  });
});

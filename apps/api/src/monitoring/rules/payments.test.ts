import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { MONITORING_POLICY } from '../policy.ts';
import { AS_OF, expectDedupes, inputs, run } from '../test-support.ts';
import type { DebitFact } from '../types.ts';
import {
  administrativeReturnRate,
  attemptsExhausted,
  overallReturnRate,
  repeatedFailures,
  unauthorizedReturnRate,
} from './payments.ts';

let n = 0;
const debit = (over: Partial<DebitFact> = {}): DebitFact => {
  n += 1;
  return {
    id: `d${n}`,
    bankLinkId: `link${n}`,
    rentPlanId: `plan${n}`,
    businessId: `biz${n}`,
    on: addDays(AS_OF, -(n % 50)),
    status: 'SUCCEEDED',
    returnCode: null,
    ...over,
  };
};

/** `total` debits of which `returned` came back with `code`. */
const book = (total: number, returned: number, code: string): DebitFact[] => [
  ...Array.from({ length: returned }, () => debit({ status: 'RETURNED', returnCode: code })),
  ...Array.from({ length: total - returned }, () => debit()),
];

describe('payments.return_rate_unauthorized', () => {
  it('is critical at 0.5% of debits', () => {
    const data = inputs({ debits: book(400, 2, 'R10') });
    expect(run(unauthorizedReturnRate, data)).toMatchObject([
      {
        severity: 'CRITICAL',
        detail: { debits: 400, returns: 2, rateBps: 50, thresholdBps: 50, byCode: { R10: 2 } },
      },
    ]);
    expectDedupes(unauthorizedReturnRate, data);
  });

  it('warns at 80% of the threshold', () => {
    const [alert] = run(unauthorizedReturnRate, inputs({ debits: book(500, 2, 'R07') }));
    expect(alert).toMatchObject({ severity: 'WARNING', detail: { rateBps: 40 } });
  });

  it('does not fire below that, or for returns that are not unauthorized', () => {
    expect(run(unauthorizedReturnRate, inputs({ debits: book(1000, 2, 'R10') }))).toEqual([]);
    expect(run(unauthorizedReturnRate, inputs({ debits: book(400, 10, 'R01') }))).toEqual([]);
  });

  it('respects the minimum sample: one return on a small book is not a rate', () => {
    // 1 of 40 is 2.5%, five times the threshold, and still no alert.
    expect(run(unauthorizedReturnRate, inputs({ debits: book(40, 1, 'R10') }))).toEqual([]);
    // Enough debits, a single return.
    expect(run(unauthorizedReturnRate, inputs({ debits: book(200, 1, 'R10') }))).toEqual([]);
    // Two returns, too few debits.
    expect(run(unauthorizedReturnRate, inputs({ debits: book(199, 2, 'R10') }))).toEqual([]);
    expect(MONITORING_POLICY.payments.unauthorized).toMatchObject({ minSample: 200, minEvents: 2 });
  });

  it('measures the trailing window only', () => {
    const old = book(400, 4, 'R10').map((d) => ({ ...d, on: addDays(AS_OF, -61) }));
    expect(run(unauthorizedReturnRate, inputs({ debits: old }))).toEqual([]);
  });
});

describe('payments.return_rate_administrative', () => {
  it('is high at 3% of debits, counting R02, R03 and R04', () => {
    const debits = [...book(100, 1, 'R02'), ...book(100, 2, 'R03'), ...book(100, 6, 'R04')];
    const data = inputs({ debits });
    expect(run(administrativeReturnRate, data)).toMatchObject([
      { severity: 'HIGH', detail: { debits: 300, returns: 9, rateBps: 300 } },
    ]);
    expectDedupes(administrativeReturnRate, data);
  });

  it('does not fire below the warning level, or under the minimum sample', () => {
    expect(run(administrativeReturnRate, inputs({ debits: book(300, 3, 'R03') }))).toEqual([]);
    expect(run(administrativeReturnRate, inputs({ debits: book(50, 5, 'R03') }))).toEqual([]);
    expect(run(administrativeReturnRate, inputs({ debits: book(100, 2, 'R03') }))).toEqual([]);
  });
});

describe('payments.return_rate_overall', () => {
  it('is high at 15% of debits, whatever the code', () => {
    const debits = [...book(50, 8, 'R01'), ...book(50, 7, 'R10')];
    const data = inputs({ debits });
    expect(run(overallReturnRate, data)).toMatchObject([
      { severity: 'HIGH', detail: { rateBps: 1500 } },
    ]);
    expectDedupes(overallReturnRate, data);
  });

  it('counts a debit rejected on the spot with a code, and not one that failed without', () => {
    const rejected = Array.from({ length: 15 }, () =>
      debit({ status: 'FAILED', returnCode: 'R01' }),
    );
    const failed = Array.from({ length: 15 }, () => debit({ status: 'FAILED' }));
    const good = Array.from({ length: 85 }, () => debit());
    expect(run(overallReturnRate, inputs({ debits: [...rejected, ...good] }))).toHaveLength(1);
    expect(run(overallReturnRate, inputs({ debits: [...failed, ...good] }))).toEqual([]);
  });

  it('respects the minimum sample', () => {
    // 4 of 10 is 40%.
    expect(run(overallReturnRate, inputs({ debits: book(10, 4, 'R01') }))).toEqual([]);
    expect(run(overallReturnRate, inputs({ debits: book(50, 4, 'R01') }))).toEqual([]);
  });
});

describe('payments.repeated_failures', () => {
  const failures = (count: number, over: Partial<DebitFact> = {}) =>
    Array.from({ length: count }, () =>
      debit({
        bankLinkId: 'linkA',
        rentPlanId: 'planA',
        status: 'FAILED',
        on: addDays(AS_OF, -3),
        ...over,
      }),
    );

  it('fires at three failed or returned debits on one account', () => {
    const data = inputs({
      debits: [...failures(2), ...failures(1, { status: 'RETURNED', returnCode: 'R01' })],
    });
    expect(run(repeatedFailures, data)).toMatchObject([
      {
        severity: 'WARNING',
        subjectId: 'planA',
        dedupeKey: 'repeated_failures:linkA',
        detail: { failures: 3, returned: 1 },
      },
    ]);
    expectDedupes(repeatedFailures, data);
  });

  it('does not fire on two, across accounts, on successes, or outside the window', () => {
    expect(run(repeatedFailures, inputs({ debits: failures(2) }))).toEqual([]);
    const spread = failures(3).map((d, i) => ({ ...d, bankLinkId: `l${i}` }));
    expect(run(repeatedFailures, inputs({ debits: spread }))).toEqual([]);
    expect(run(repeatedFailures, inputs({ debits: failures(3, { status: 'SUCCEEDED' }) }))).toEqual(
      [],
    );
    expect(
      run(repeatedFailures, inputs({ debits: failures(3, { on: addDays(AS_OF, -31) }) })),
    ).toEqual([]);
  });
});

describe('payments.collection_attempts_exhausted', () => {
  const exhausted = {
    rentPlanId: 'planA',
    businessId: 'bizA',
    businessName: 'Cedar Street Cycles',
    installments: 2,
    owedCents: 490_000,
    oldestDueDate: addDays(AS_OF, -20),
  };

  it('fires once per plan with installments out of attempts', () => {
    const data = inputs({ exhausted: [exhausted] });
    expect(run(attemptsExhausted, data)).toMatchObject([
      { severity: 'WARNING', subjectType: 'rent_plan', subjectId: 'planA' },
    ]);
    expectDedupes(attemptsExhausted, data);
  });

  it('does not fire when nothing is exhausted, and clears on its own when paid', () => {
    expect(run(attemptsExhausted, inputs())).toEqual([]);
    expect(attemptsExhausted.autoResolves).toBe(true);
  });
});

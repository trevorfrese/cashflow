import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { MONITORING_POLICY } from '../policy.ts';
import { AS_OF, expectDedupes, inputs, installment, plan, plans, run } from '../test-support.ts';
import type { PlanFact } from '../types.ts';
import {
  delinquencyRoll,
  delinquentShare,
  firstPaymentDefault,
  industryConcentration,
  lossVersusExpected,
  poolUtilization,
  singleNameConcentration,
  standingOn,
} from './portfolio.ts';

const P = MONITORING_POLICY.portfolio;
const MIN = P.minPlans;

/** A plan fronted `daysAgo` whose single installment is unpaid and was due the same day. */
const unpaidSince = (daysAgo: number): Partial<PlanFact> => ({
  originatedOn: addDays(AS_OF, -daysAgo),
  installments: [
    installment({
      first: true,
      status: 'LATE',
      dueDate: addDays(AS_OF, -daysAgo),
      frontedOn: addDays(AS_OF, -daysAgo),
      paidOn: null,
    }),
  ],
});

/** A plan fronted `daysAgo` whose single installment is not due yet. */
const current = (daysAgo = 5): Partial<PlanFact> => ({
  originatedOn: addDays(AS_OF, -daysAgo),
  installments: [
    installment({
      first: true,
      status: 'SCHEDULED',
      dueDate: addDays(AS_OF, 10),
      frontedOn: addDays(AS_OF, -daysAgo),
      paidOn: null,
    }),
  ],
});

/** A plan whose first installment was paid on its due date `daysAgo`. */
const paidOnTime = (daysAgo: number): Partial<PlanFact> => ({
  originatedOn: addDays(AS_OF, -daysAgo),
  installments: [
    installment({
      first: true,
      dueDate: addDays(AS_OF, -daysAgo),
      frontedOn: addDays(AS_OF, -daysAgo),
      paidOn: addDays(AS_OF, -daysAgo),
    }),
  ],
});

describe('standingOn', () => {
  const p = plan(unpaidSince(40));

  it('rebuilds the balance and bucket on any date from the installments', () => {
    expect(standingOn(p, AS_OF)).toEqual({ outstandingCents: 100_000, bucket: 'DEFAULT' });
    expect(standingOn(p, addDays(AS_OF, -35))).toEqual({
      outstandingCents: 100_000,
      bucket: 'DELINQUENT',
    });
    expect(standingOn(p, addDays(AS_OF, -39))).toEqual({
      outstandingCents: 100_000,
      bucket: 'GRACE',
    });
    expect(standingOn(p, addDays(AS_OF, -41))).toEqual({ outstandingCents: 0, bucket: 'CURRENT' });
  });

  it('takes a paid or written off installment out from the day it happened', () => {
    const paid = plan({
      installments: [
        installment({
          dueDate: addDays(AS_OF, -20),
          frontedOn: addDays(AS_OF, -20),
          paidOn: addDays(AS_OF, -10),
        }),
      ],
    });
    expect(standingOn(paid, addDays(AS_OF, -12)).bucket).toBe('DELINQUENT');
    expect(standingOn(paid, AS_OF)).toEqual({ outstandingCents: 0, bucket: 'CURRENT' });
    const writtenOff = plan({
      installments: [
        installment({
          status: 'CHARGED_OFF',
          dueDate: addDays(AS_OF, -100),
          frontedOn: addDays(AS_OF, -100),
          paidOn: null,
          chargedOffOn: addDays(AS_OF, -10),
        }),
      ],
    });
    expect(standingOn(writtenOff, AS_OF)).toEqual({ outstandingCents: 0, bucket: 'CHARGED_OFF' });
    expect(standingOn(writtenOff, addDays(AS_OF, -11)).bucket).toBe('DEFAULT');
  });
});

describe('portfolio.first_payment_default', () => {
  const cohort = (total: number, defaults: number, daysAgo = 45) => [
    ...plans(defaults, () => unpaidSince(daysAgo)),
    ...plans(total - defaults, () => paidOnTime(daysAgo)),
  ];

  it('is critical at 3% of a cohort and trips the breaker', () => {
    const data = inputs({ plans: cohort(100, 3) });
    const [alert] = run(firstPaymentDefault, data);
    expect(alert).toMatchObject({
      severity: 'CRITICAL',
      tripsBreaker: true,
      subjectId: `cohort:${addDays(AS_OF, -45).slice(0, 7)}`,
      detail: { plans: 100, defaults: 3, rateBps: 300 },
    });
    expectDedupes(firstPaymentDefault, data);
  });

  it('warns at 1.5% without tripping the breaker', () => {
    const [alert] = run(firstPaymentDefault, inputs({ plans: cohort(200, 3) }));
    expect(alert).toMatchObject({ severity: 'WARNING', tripsBreaker: false });
  });

  it('does not fire on a healthy cohort', () => {
    expect(run(firstPaymentDefault, inputs({ plans: cohort(200, 2) }))).toEqual([]);
  });

  it('respects the minimum sample: one default among nineteen plans is not a rate', () => {
    expect(run(firstPaymentDefault, inputs({ plans: cohort(MIN - 1, 5) }))).toEqual([]);
    expect(run(firstPaymentDefault, inputs({ plans: cohort(MIN, 5) }))).toHaveLength(1);
  });

  it('counts a first installment written off or paid a month late, not a later one', () => {
    const writtenOff = plan({
      originatedOn: addDays(AS_OF, -100),
      installments: [
        installment({
          first: true,
          status: 'CHARGED_OFF',
          dueDate: addDays(AS_OF, -100),
          paidOn: null,
          chargedOffOn: addDays(AS_OF, -10),
        }),
      ],
    });
    const paidLate = plan({
      originatedOn: addDays(AS_OF, -100),
      installments: [
        installment({ first: true, dueDate: addDays(AS_OF, -100), paidOn: addDays(AS_OF, -60) }),
      ],
    });
    const laterMiss = plan({
      originatedOn: addDays(AS_OF, -100),
      installments: [
        installment({ first: true, dueDate: addDays(AS_OF, -100), paidOn: addDays(AS_OF, -100) }),
        installment({ status: 'LATE', dueDate: addDays(AS_OF, -60), paidOn: null }),
      ],
    });
    const rest = plans(MIN - 3, () => paidOnTime(100));
    const [alert] = run(
      firstPaymentDefault,
      inputs({ plans: [writtenOff, paidLate, laterMiss, ...rest] }),
    );
    expect(alert!.detail).toMatchObject({ plans: MIN, defaults: 2 });
  });

  it('leaves out plans whose first installment is not 30 days old yet', () => {
    expect(run(firstPaymentDefault, inputs({ plans: cohort(100, 50, 10) }))).toEqual([]);
  });
});

describe('portfolio.delinquent_share', () => {
  const book = (total: number, delinquent: number) => [
    ...plans(delinquent, () => unpaidSince(10)),
    ...plans(total - delinquent, () => current()),
  ];

  it('is critical at 10% of outstanding principal and trips the breaker', () => {
    const data = inputs({ plans: book(40, 4) });
    expect(run(delinquentShare, data)).toMatchObject([
      {
        severity: 'CRITICAL',
        tripsBreaker: true,
        detail: {
          rateBps: 1000,
          plansWithBalance: 40,
          buckets: { DELINQUENT: { plans: 4 }, CURRENT: { plans: 36 } },
        },
      },
    ]);
    expectDedupes(delinquentShare, data);
  });

  it('warns at 5%, and reports the share in every bucket', () => {
    const [alert] = run(delinquentShare, inputs({ plans: book(40, 2) }));
    expect(alert).toMatchObject({ severity: 'WARNING', tripsBreaker: false });
    expect(alert!.detail.buckets).toMatchObject({
      CURRENT: { shareBps: 9500 },
      DELINQUENT: { shareBps: 500 },
    });
  });

  it('does not fire on a healthy book, and grace does not count as delinquent', () => {
    expect(run(delinquentShare, inputs({ plans: book(40, 1) }))).toEqual([]);
    const grace = [...plans(10, () => unpaidSince(2)), ...plans(30, () => current())];
    expect(run(delinquentShare, inputs({ plans: grace }))).toEqual([]);
  });

  it('respects the minimum sample: a small book with one late plan does not page', () => {
    expect(run(delinquentShare, inputs({ plans: book(MIN - 1, 5) }))).toEqual([]);
  });
});

describe('portfolio.delinquency_roll', () => {
  // Fronted 40 days ago and not due until 10 days ago: current a month ago, delinquent now.
  const rolled = (): Partial<PlanFact> => ({
    installments: [
      installment({
        status: 'LATE',
        dueDate: addDays(AS_OF, -10),
        frontedOn: addDays(AS_OF, -40),
        paidOn: null,
      }),
    ],
  });
  const stayed = (): Partial<PlanFact> => ({
    installments: [
      installment({
        status: 'SCHEDULED',
        dueDate: addDays(AS_OF, 5),
        frontedOn: addDays(AS_OF, -40),
        paidOn: null,
      }),
    ],
  });
  const book = (total: number, bad: number) => [
    ...plans(bad, rolled),
    ...plans(total - bad, stayed),
  ];

  it('is critical at 8% of last month current balance and trips the breaker', () => {
    const data = inputs({ plans: book(50, 4) });
    expect(run(delinquencyRoll, data)).toMatchObject([
      {
        severity: 'CRITICAL',
        tripsBreaker: true,
        detail: { rateBps: 800, plansCurrentThen: 50, rolledPlans: 4 },
      },
    ]);
    expectDedupes(delinquencyRoll, data);
  });

  it('warns at 3%', () => {
    expect(run(delinquencyRoll, inputs({ plans: book(100, 3) }))[0]).toMatchObject({
      severity: 'WARNING',
      tripsBreaker: false,
    });
  });

  it('does not fire when little rolled, or for balance that was already delinquent', () => {
    expect(run(delinquencyRoll, inputs({ plans: book(100, 2) }))).toEqual([]);
    const alreadyBad = [...plans(10, () => unpaidSince(60)), ...plans(30, stayed)];
    expect(run(delinquencyRoll, inputs({ plans: alreadyBad }))).toEqual([]);
  });

  it('respects the minimum sample', () => {
    expect(run(delinquencyRoll, inputs({ plans: book(MIN - 1, 10) }))).toEqual([]);
  });
});

describe('portfolio concentration', () => {
  const exposure = (committedCents: number) => ({
    capitalCents: 10_000_000,
    committedCents,
    byIndustry: [{ industry: 'RESTAURANT', committedCents }],
    byBusiness: [{ businessId: 'biz1', businessName: 'Blue Door Bakery', committedCents }],
  });

  it('single name: informational near the 5% cap, a warning over it, high well over', () => {
    const at = (cents: number) =>
      run(singleNameConcentration, inputs({ exposure: exposure(cents) }));
    expect(at(370_000)).toEqual([]);
    expect(at(400_000)).toMatchObject([
      { severity: 'INFO', detail: { shareBps: 400, capBps: 500 } },
    ]);
    expect(at(500_000)).toMatchObject([{ severity: 'INFO' }]);
    expect(at(510_000)).toMatchObject([{ severity: 'WARNING' }]);
    expect(at(750_000)).toMatchObject([{ severity: 'HIGH' }]);
    expectDedupes(singleNameConcentration, inputs({ exposure: exposure(510_000) }));
  });

  it('industry: the same against the 40% cap', () => {
    const at = (cents: number) => run(industryConcentration, inputs({ exposure: exposure(cents) }));
    expect(at(2_900_000)).toEqual([]);
    expect(at(3_000_000)).toMatchObject([{ severity: 'INFO', subjectId: 'RESTAURANT' }]);
    expect(at(4_100_000)).toMatchObject([{ severity: 'WARNING' }]);
    expect(at(6_000_000)).toMatchObject([{ severity: 'HIGH' }]);
    expectDedupes(industryConcentration, inputs({ exposure: exposure(4_100_000) }));
  });

  it('reads its caps from the credit policy and never trips the breaker', () => {
    expect(P.maxSingleNameShareBps).toBe(500);
    expect(P.maxIndustryShareBps).toBe(4000);
    expect(singleNameConcentration.tripsCircuitBreaker).toBe(false);
    expect(industryConcentration.tripsCircuitBreaker).toBe(false);
  });

  it('says nothing about an empty pool: utilization covers that', () => {
    const empty = { ...exposure(500_000), capitalCents: 0 };
    expect(run(singleNameConcentration, inputs({ exposure: empty }))).toEqual([]);
    expect(run(industryConcentration, inputs({ exposure: empty }))).toEqual([]);
  });
});

describe('portfolio.pool_utilization', () => {
  const at = (committedCents: number, capitalCents = 10_000_000) =>
    run(
      poolUtilization,
      inputs({ exposure: { capitalCents, committedCents, byIndustry: [], byBusiness: [] } }),
    );

  it('warns near the 85% ceiling, is high at it, and critical when commitments exceed capital', () => {
    expect(at(7_600_000)).toEqual([]);
    expect(at(7_650_000)).toMatchObject([{ severity: 'WARNING', tripsBreaker: false }]);
    expect(at(8_500_000)).toMatchObject([{ severity: 'HIGH', tripsBreaker: false }]);
    expect(at(10_000_000)).toMatchObject([{ severity: 'CRITICAL', tripsBreaker: true }]);
    expectDedupes(
      poolUtilization,
      inputs({
        exposure: {
          capitalCents: 10_000_000,
          committedCents: 9_000_000,
          byIndustry: [],
          byBusiness: [],
        },
      }),
    );
  });

  it('is critical for commitments against an empty pool, and silent with no commitments', () => {
    expect(at(100_000, 0)).toMatchObject([{ severity: 'CRITICAL' }]);
    expect(at(0, 0)).toEqual([]);
  });
});

describe('portfolio.loss_vs_expected', () => {
  // 20 bps expected on $2,000 fronted is $4 a plan.
  const good = (): Partial<PlanFact> => ({
    ...paidOnTime(150),
    originatedOn: addDays(AS_OF, -150),
  });
  const lost = (principalCents: number): Partial<PlanFact> => ({
    originatedOn: addDays(AS_OF, -150),
    installments: [
      installment({
        status: 'CHARGED_OFF',
        principalCents,
        dueDate: addDays(AS_OF, -150),
        paidOn: null,
        chargedOffOn: addDays(AS_OF, -60),
      }),
    ],
  });
  const cohort = (total: number, lossCents: number) => [
    plan(lost(lossCents)),
    ...plans(total - 1, good),
  ];

  it('is critical at 2.5 times expected loss and trips the breaker', () => {
    // 100 plans expect $400. $1,000 lost is 2.5 times.
    const data = inputs({ plans: cohort(100, 100_000) });
    expect(run(lossVersusExpected, data)).toMatchObject([
      {
        severity: 'CRITICAL',
        tripsBreaker: true,
        detail: {
          plans: 100,
          expectedLossCents: 40_000,
          realizedLossCents: 100_000,
          ratioBps: 25_000,
        },
      },
    ]);
    expectDedupes(lossVersusExpected, data);
  });

  it('warns at 1.5 times, and is quiet at expectation', () => {
    expect(run(lossVersusExpected, inputs({ plans: cohort(100, 60_000) }))[0]).toMatchObject({
      severity: 'WARNING',
      tripsBreaker: false,
    });
    expect(run(lossVersusExpected, inputs({ plans: cohort(100, 40_000) }))).toEqual([]);
  });

  it('nets a recovery off the loss', () => {
    const recovered = plan({
      originatedOn: addDays(AS_OF, -150),
      installments: [
        installment({
          principalCents: 100_000,
          chargedOffOn: addDays(AS_OF, -60),
          paidOn: addDays(AS_OF, -20),
        }),
      ],
    });
    expect(run(lossVersusExpected, inputs({ plans: [recovered, ...plans(99, good)] }))).toEqual([]);
  });

  it('respects the minimum sample and the minimum age of a cohort', () => {
    expect(run(lossVersusExpected, inputs({ plans: cohort(MIN - 1, 500_000) }))).toEqual([]);
    const young = cohort(100, 500_000).map((p) => ({ ...p, originatedOn: addDays(AS_OF, -100) }));
    expect(run(lossVersusExpected, inputs({ plans: young }))).toEqual([]);
  });

  it('leaves out plans whose decision carried no expected loss', () => {
    const unpriced = cohort(100, 500_000).map((p) => ({ ...p, expectedLossBps: null }));
    expect(run(lossVersusExpected, inputs({ plans: unpriced }))).toEqual([]);
  });
});

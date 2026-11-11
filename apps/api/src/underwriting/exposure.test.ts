import { describe, expect, it } from 'vitest';

import {
  approvedLimit,
  checkFunding,
  checkNewPlan,
  ladderCapCents,
  NO_EXPOSURE_CONTEXT,
  type ExposureContext,
} from './exposure.ts';
import { POLICY_V2 } from './policy.ts';

const policy = POLICY_V2.exposure!;
const pool = (capitalCents: number, committedCents = 0): ExposureContext['pool'] => ({
  cashCents: capitalCents,
  receivableCents: 0,
  committedCents,
});
const limit = (
  overrides: Partial<Omit<Parameters<typeof approvedLimit>[1], 'context'>> & {
    context?: Partial<ExposureContext>;
  } = {},
) => {
  const { context, ...rest } = overrides;
  return approvedLimit(policy, {
    requestedCents: 500_000,
    capacityCents: 2_000_000,
    observedRentCents: 500_000,
    incrementCents: 10_000,
    ...rest,
    context: { ...NO_EXPOSURE_CONTEXT, ...context },
  });
};

describe('approved limit', () => {
  it('is never above the request, to the cent', () => {
    expect(limit({ requestedCents: 512_345 })).toMatchObject({
      limitCents: 512_345,
      binding: 'REQUEST',
    });
  });

  it('is never above what cash flow supports', () => {
    expect(limit({ capacityCents: 430_000 })).toMatchObject({
      limitCents: 430_000,
      binding: 'CAPACITY',
    });
  });

  it('is at most 1.2 times the rent seen in the account, rounded down', () => {
    const r = limit({ requestedCents: 900_000, observedRentCents: 300_000 });
    expect(r).toMatchObject({ limitCents: 360_000, binding: 'OBSERVED_RENT' });
    // A request 2.5 times observed rent, the low end of the bust out pattern, is offered
    // under half of what it asked, which the engine declines.
    const bustOut = limit({ requestedCents: 750_000, observedRentCents: 300_000 });
    expect(bustOut.limitCents / 750_000).toBeLessThan(POLICY_V2.minCounterOfferBps / 10_000);
  });

  it('does not apply the observed rent cap when none was observed or the lease is verified', () => {
    expect(limit({ requestedCents: 900_000, observedRentCents: null }).binding).toBe('REQUEST');
    expect(
      limit({ requestedCents: 900_000, observedRentCents: 300_000, leaseVerified: true }).binding,
    ).toBe('REQUEST');
  });

  it('caps a first plan and raises the cap with on time periods', () => {
    const big = {
      requestedCents: 5_000_000,
      capacityCents: 9_000_000,
      observedRentCents: 5_000_000,
    };
    expect(limit(big)).toMatchObject({ limitCents: 1_000_000, binding: 'LADDER' });
    expect(limit({ ...big, context: { onTimePeriods: 2 } }).limitCents).toBe(1_000_000);
    expect(limit({ ...big, context: { onTimePeriods: 3 } }).limitCents).toBe(2_000_000);
    expect(limit({ ...big, context: { onTimePeriods: 6 } }).limitCents).toBe(4_000_000);
    expect(limit({ ...big, context: { onTimePeriods: 60 } }).limitCents).toBe(4_000_000);
  });

  it('counts what the business already has against the ladder and the aggregate cap', () => {
    const second = limit({
      requestedCents: 800_000,
      observedRentCents: 800_000,
      context: { businessCommittedCents: 600_000 },
    });
    // First rung is $10,000 in total: $6,000 is already out.
    expect(second).toMatchObject({ limitCents: 400_000, binding: 'LADDER' });
    const full = limit({ context: { businessCommittedCents: 4_000_000, onTimePeriods: 12 } });
    expect(full.limitCents).toBe(0);
    expect(['LADDER', 'BUSINESS_AGGREGATE']).toContain(full.binding);
  });

  it('does not depend on the pool: a small or empty pool is a funding matter, not a credit one', () => {
    for (const p of [null, pool(0), pool(100_000), pool(10_000_000_000)]) {
      expect(limit({ context: { pool: p } })).toMatchObject({
        limitCents: 500_000,
        binding: 'REQUEST',
      });
    }
  });
});

describe('ladder', () => {
  it('steps at the configured on time periods', () => {
    expect(ladderCapCents(policy, 0)).toBe(1_000_000);
    expect(ladderCapCents(policy, 3)).toBe(2_000_000);
    expect(ladderCapCents(policy, 5)).toBe(2_000_000);
    expect(ladderCapCents(policy, 6)).toBe(4_000_000);
  });
});

describe('funding', () => {
  const ctx = (overrides: Partial<ExposureContext>): ExposureContext => ({
    ...NO_EXPOSURE_CONTEXT,
    ...overrides,
  });

  it('passes when the pool is unknown', () => {
    expect(checkFunding(policy, 500_000, NO_EXPOSURE_CONTEXT)).toMatchObject({
      ok: true,
      blockers: [],
    });
  });

  it('passes with room under every ceiling', () => {
    const r = checkFunding(policy, 300_000, ctx({ pool: pool(100_000_000, 50_000_000) }));
    expect(r).toMatchObject({ ok: true, utilizationBps: 5030 });
  });

  it('blocks above the pool utilization ceiling', () => {
    // $84,900 committed of $100,000: one more $300 plan crosses 85%.
    const r = checkFunding(policy, 30_000, ctx({ pool: pool(10_000_000, 8_490_000) }));
    expect(r.ok).toBe(false);
    expect(r.blockers).toEqual(['POOL_UTILIZATION']);
    expect(checkFunding(policy, 10_000, ctx({ pool: pool(10_000_000, 8_490_000) })).ok).toBe(true);
  });

  it('blocks an empty pool', () => {
    expect(checkFunding(policy, 30_000, ctx({ pool: pool(0) })).blockers).toContain(
      'POOL_UTILIZATION',
    );
  });

  it('blocks above the industry share', () => {
    const r = checkFunding(
      policy,
      300_000,
      ctx({ pool: pool(100_000_000, 45_000_000), industryCommittedCents: 39_900_000 }),
    );
    expect(r.blockers).toEqual(['INDUSTRY_CONCENTRATION']);
  });

  it('blocks above the single name share', () => {
    const r = checkFunding(
      policy,
      300_000,
      ctx({ pool: pool(10_000_000, 1_000_000), businessCommittedCents: 300_000 }),
    );
    expect(r.blockers).toEqual(['SINGLE_NAME']);
  });
});

describe('opening a plan', () => {
  const base = {
    rentCents: 500_000,
    approvedLimitCents: 500_000,
    observedRentCents: 500_000,
    context: { ...NO_EXPOSURE_CONTEXT, pool: pool(100_000_000) },
  };

  it('allows a plan inside every rule', () => {
    expect(checkNewPlan(policy, base)).toBeNull();
  });

  it('refuses rent over the approved limit', () => {
    expect(checkNewPlan(policy, { ...base, rentCents: 500_001 })).toMatchObject({
      code: 'RENT_OVER_LIMIT',
    });
  });

  it('refuses a second plan that takes the business over its cap', () => {
    const refusal = checkNewPlan(policy, {
      ...base,
      context: { ...base.context, businessCommittedCents: 700_000 },
    });
    expect(refusal).toMatchObject({ code: 'EXPOSURE_CAP', cap: 'LADDER' });
    // The same second plan fits once the business has earned the next rung.
    expect(
      checkNewPlan(policy, {
        ...base,
        context: { ...base.context, businessCommittedCents: 700_000, onTimePeriods: 3 },
      }),
    ).toBeNull();
  });

  it('refuses when the pool is over its ceiling, and says the plan can wait', () => {
    const refusal = checkNewPlan(policy, {
      ...base,
      context: { ...base.context, pool: pool(100_000_000, 85_000_000) },
    });
    expect(refusal).toMatchObject({ code: 'FUNDING_UNAVAILABLE', blockers: ['POOL_UTILIZATION'] });
  });
});

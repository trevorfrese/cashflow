import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { decide, detectDecline, referTriggers } from './engine.ts';
import { computeCashFlowFeatures, coverageRatio, freeCashCents } from './features.ts';
import {
  CURRENT_POLICY,
  POLICIES,
  POLICY_V1,
  POLICY_V2,
  POLICY_V3,
  POLICY_VERSION,
  type CreditPolicy,
} from './policy.ts';
import { account, AS_OF, cleanSummary, engineInput, tx } from './test-support.ts';

const codes = (r: ReturnType<typeof decide>) => r.reasons.map((x) => x.code);
const flagCodes = (r: ReturnType<typeof decide>) => r.snapshot.integrityFlags.map((f) => f.code);

describe('policy versions', () => {
  it('names the current policy and keeps the launch policy available', () => {
    expect(CURRENT_POLICY).toBe(POLICY_V3);
    expect(POLICY_VERSION).toBe('cashflow-v3');
    expect(POLICIES['cashflow-v1']).toBe(POLICY_V1);
    expect(POLICIES['cashflow-v2']).toBe(POLICY_V2);
    expect(POLICIES['cashflow-v3']).toBe(POLICY_V3);
    // Version 3 is version 2 plus the veracity checks and nothing else.
    const { version: _v3, scorecard: _s3, veracity, ...rest3 } = POLICY_V3;
    const { version: _v2, scorecard: _s2, veracity: none, ...rest2 } = POLICY_V2;
    expect(rest3).toEqual(rest2);
    expect(none).toBeNull();
    expect(veracity).not.toBeNull();
  });

  it('stamps every outcome with the version that made it', () => {
    const approved = decide(engineInput(account()));
    const needsInfo = decide(engineInput(account(), { bankData: null }));
    const declined = decide(engineInput(account(), { timeInBusinessMonths: 2 }));
    expect(approved.outcome).toBe('APPROVED');
    expect(needsInfo.outcome).toBe('NEEDS_INFO');
    expect(declined.outcome).toBe('DECLINED');
    for (const r of [approved, needsInfo, declined]) {
      expect(r.policyVersion).toBe('cashflow-v3');
      expect(r.snapshot.policyVersion).toBe('cashflow-v3');
      expect(r.snapshot.thresholds.minScore).toBe(POLICY_V3.minScore);
    }
    expect(decide(engineInput(account()), POLICY_V1).policyVersion).toBe('cashflow-v1');
    expect(decide(engineInput(account()), POLICY_V2).policyVersion).toBe('cashflow-v2');
  });

  it('snapshots inputs, thresholds, flags, pricing, and exposure on an approval', () => {
    const r = decide(engineInput(account()));
    expect(r.snapshot.inputs).toMatchObject({
      statedMonthlyRevenueCents: 3_000_000,
      requestedMonthlyRentCents: 300_000,
      asOf: AS_OF,
      excludedRoundTripCredits: 0,
    });
    expect(r.snapshot.integrityFlags).toEqual([]);
    expect(r.snapshot.pricing).toMatchObject({ feeBps: r.feeBps, withinCap: true });
    expect(r.snapshot.pricing!.pdBps).toBeGreaterThan(0);
    expect(r.snapshot.exposure).toMatchObject({ limitCents: 300_000, binding: 'REQUEST' });
    expect(r.snapshot.recommendation).toEqual({
      outcome: 'APPROVED',
      approvedMonthlyLimitCents: 300_000,
      feeBps: r.feeBps,
    });
    expect(r.snapshot.referTriggers).toEqual([]);
  });
});

describe('coverage and the fee', () => {
  it('scores coverage without a fee, so the score cannot depend on the price', () => {
    const transactions = account();
    const base = {
      transactions,
      currentBalanceCents: 6_000_000,
      asOf: AS_OF,
      statedMonthlyRevenueCents: 3_000_000,
      requestedMonthlyRentCents: 300_000,
    };
    const scored = computeCashFlowFeatures({ ...base, provisionalFeeBps: 0 });
    const atLaunchFee = computeCashFlowFeatures({ ...base, provisionalFeeBps: 250 });
    expect(scored.rentCoverageRatio).toBe(
      Math.round((freeCashCents(scored) * 100) / base.requestedMonthlyRentCents),
    );
    expect(atLaunchFee.rentCoverageRatio).toBeLessThan(scored.rentCoverageRatio);
  });

  it('restates the stored coverage at the fee actually quoted', () => {
    const r = decide(engineInput(account()));
    expect(r.outcome).toBe('APPROVED');
    expect(r.cashFlow!.rentCoverageRatio).toBe(
      coverageRatio(freeCashCents(r.cashFlow!), 300_000, r.feeBps!),
    );
    // Version 1 stored coverage at a flat 2.5% whatever the quoted fee.
    const v1 = decide(engineInput(account()), POLICY_V1);
    expect(v1.feeBps).toBe(150);
    expect(v1.cashFlow!.rentCoverageRatio).toBe(
      coverageRatio(freeCashCents(v1.cashFlow!), 300_000, 250),
    );
  });

  it('gives the same score whatever fee the grade carries', () => {
    const cheap: CreditPolicy = { ...POLICY_V2, expectedLossPricing: null };
    const dear: CreditPolicy = {
      ...cheap,
      pricing: { ...cheap.pricing, A: { ...cheap.pricing.A, feeBps: 390 } },
    };
    const a = decide(engineInput(account()), cheap);
    const b = decide(engineInput(account()), dear);
    expect(a.score).toBe(b.score);
    expect(b.feeBps).toBe(390);
    expect(b.cashFlow!.rentCoverageRatio).toBeLessThan(a.cashFlow!.rentCoverageRatio);
  });
});

describe('pricing in the engine', () => {
  it('raises the fee on a small rent to cover the fixed cost of a plan', () => {
    // $1,000 a month of rent on a healthy account.
    const r = decide(
      engineInput(account({ rentCents: 100_000 }), { requestedMonthlyRentCents: 100_000 }),
    );
    expect(r.outcome).toBe('APPROVED');
    expect(r.feeBps!).toBeGreaterThan(POLICY_V2.pricing.A.feeBps);
    expect((100_000 * r.feeBps!) / 10_000).toBeGreaterThanOrEqual(
      POLICY_V2.expectedLossPricing!.minFeeCents,
    );
  });

  it('declines, with the reason, when the fee needed is above the cap', () => {
    const r = decide(
      engineInput(account({ rentCents: 40_000 }), { requestedMonthlyRentCents: 40_000 }),
    );
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons[0]!.code).toBe('RENT_BELOW_MINIMUM');
    expect(r.feeBps).toBeNull();
    expect(r.snapshot.pricing!.withinCap).toBe(false);
  });

  it('declines rather than underprice when expected loss alone is above the cap', () => {
    const p = POLICY_V2.expectedLossPricing!;
    const risky: CreditPolicy = {
      ...POLICY_V2,
      expectedLossPricing: {
        ...p,
        pdTable: {
          ...p.pdTable,
          bands: [{ minScore: 0, maxScore: 100, pdBps: 9000, plans: 1, bad: 1 }],
        },
      },
    };
    const r = decide(engineInput(account()), risky);
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons[0]!.code).toBe('FEE_ABOVE_MAXIMUM');
  });
});

describe('exposure in the engine', () => {
  it('never approves more than was asked', () => {
    const r = decide(engineInput(account(), { requestedMonthlyRentCents: 250_000 }));
    expect(r.outcome).toBe('APPROVED');
    expect(r.approvedMonthlyLimitCents).toBe(250_000);
  });

  it('declines a request several times the rent seen in the account', () => {
    // The account pays $3,000. The lease presented is $9,000.
    const big = account({ dailySalesCents: 300_000 });
    const r = decide(
      engineInput(big, {
        statedMonthlyRevenueCents: 9_000_000,
        requestedMonthlyRentCents: 900_000,
      }),
    );
    expect(flagCodes(r)).toContain('RENT_ABOVE_OBSERVED');
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons[0]!.code).toBe('RENT_NOT_VERIFIED');
    expect(r.snapshot.exposure).toMatchObject({ limitCents: 360_000, binding: 'OBSERVED_RENT' });
  });

  it('counter offers a modest step up in rent at 1.2 times observed', () => {
    const big = account({ dailySalesCents: 300_000 });
    const r = decide(
      engineInput(big, {
        statedMonthlyRevenueCents: 9_000_000,
        requestedMonthlyRentCents: 450_000,
      }),
    );
    expect(r.outcome).toBe('APPROVED');
    expect(r.approvedMonthlyLimitCents).toBe(360_000);
    expect(r.reasons[0]!.code).toBe('LIMIT_BELOW_REQUEST');
  });

  it('applies the first plan cap and lifts it with on time periods', () => {
    // A large business: $20,000 a day of sales, $14,000 of rent.
    const large = account({ dailySalesCents: 2_000_000, rentCents: 1_400_000 });
    const input = engineInput(large, {
      statedMonthlyRevenueCents: 60_000_000,
      requestedMonthlyRentCents: 1_400_000,
      bankData: { transactions: large, currentBalanceCents: 120_000_000, asOf: AS_OF },
    });
    const first = decide(input);
    expect(first.approvedMonthlyLimitCents).toBe(1_000_000);
    expect(first.snapshot.exposure!.binding).toBe('LADDER');
    const seasoned = decide({
      ...input,
      exposureContext: {
        businessCommittedCents: 0,
        onTimePeriods: 3,
        industryCommittedCents: 0,
        pool: null,
      },
    });
    expect(seasoned.snapshot.recommendation.approvedMonthlyLimitCents).toBe(1_400_000);
  });

  it('tells the applicant when the pool is close to full, without changing the decision', () => {
    const r = decide(
      engineInput(account(), {
        exposureContext: {
          businessCommittedCents: 0,
          onTimePeriods: 0,
          industryCommittedCents: 0,
          pool: { cashCents: 100_000_000, receivableCents: 0, committedCents: 90_000_000 },
        },
      }),
    );
    expect(r.outcome).toBe('APPROVED');
    expect(codes(r)).toContain('FUNDING_QUEUE');
    expect(r.snapshot.funding).toMatchObject({ ok: false, blockers: ['POOL_UTILIZATION'] });
  });
});

describe('integrity in the engine', () => {
  /** Weekly $7,000 credits for 16 weeks, each leaving two days later. */
  const padded = () => {
    const out = account();
    for (let i = 0; i < 16; i++) {
      const day = addDays(AS_OF, -(4 + i * 7));
      out.push(tx(day, 700_000, 'INVOICE_PAYMENT'), tx(addDays(day, 2), -700_000, 'TRANSFER_OUT'));
    }
    return out;
  };

  it('leaves round tripped credits out of revenue and declines on the pattern', () => {
    const clean = decide(engineInput(account()));
    const r = decide(engineInput(padded(), { statedMonthlyRevenueCents: 6_000_000 }));
    expect(r.snapshot.inputs.excludedRoundTripCredits).toBe(16);
    // Verified revenue is the real revenue, not the padded figure.
    expect(r.cashFlow!.verifiedMonthlyRevenueCents).toBe(
      clean.cashFlow!.verifiedMonthlyRevenueCents,
    );
    expect(flagCodes(r)).toContain('ROUND_TRIP_DEPOSITS');
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons[0]!.code).toBe('UNVERIFIED_DEPOSITS');
    // The launch policy counted the padding as revenue and approved.
    const v1 = decide(engineInput(padded(), { statedMonthlyRevenueCents: 6_000_000 }), POLICY_V1);
    expect(v1.cashFlow!.verifiedMonthlyRevenueCents).toBeGreaterThan(5_000_000);
    expect(v1.outcome).toBe('APPROVED');
  });

  it('declines when the landlord account is the applicant own account', () => {
    const r = decide(
      engineInput(account(), { integrityContext: { landlordAccountIsApplicantAccount: true } }),
    );
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons[0]!.code).toBe('LANDLORD_ACCOUNT_MATCH');
  });

  it('still asks for information when stated revenue is far above verified', () => {
    const r = decide(engineInput(account(), { statedMonthlyRevenueCents: 6_000_000 }));
    expect(r.outcome).toBe('NEEDS_INFO');
    expect(r.reasons[0]!.code).toBe('REVENUE_MISMATCH');
    expect(flagCodes(r)).toContain('STATED_REVENUE_FAR_ABOVE_VERIFIED');
  });

  it('scores a periodic review instead of asking about a figure stated months ago', () => {
    // Revenue has collapsed to a fraction of what was stated at application.
    const collapsed = account({ dailySalesCents: 20_000, rentCents: 300_000 });
    const input = engineInput(collapsed, { statedMonthlyRevenueCents: 3_000_000 });
    expect(decide(input).outcome).toBe('NEEDS_INFO');
    const review = decide({ ...input, periodicReview: true });
    expect(review.outcome).toBe('DECLINED');
    expect(review.score).not.toBeNull();
    expect(flagCodes(review)).not.toContain('STATED_REVENUE_FAR_ABOVE_VERIFIED');
  });

  it('records an informational flag without changing the outcome', () => {
    const r = decide(engineInput(account(), { statedMonthlyRevenueCents: 4_000_000 }));
    expect(flagCodes(r)).toEqual(['STATED_REVENUE_ABOVE_VERIFIED']);
    expect(r.outcome).toBe('APPROVED');
  });
});

describe('escalation', () => {
  const clean = {
    flags: [],
    score: 90,
    limitCents: 300_000,
    requestedCents: 300_000,
    firstPlan: true,
  };

  it('decides a clean application without a reviewer', () => {
    expect(referTriggers(POLICY_V2, clean)).toEqual([]);
    expect(decide(engineInput(account())).outcome).toBe('APPROVED');
  });

  it('refers a score in the band just above the cutoff', () => {
    const band = POLICY_V2.escalation!.scoreBandAboveCutoff;
    expect(referTriggers(POLICY_V2, { ...clean, score: POLICY_V2.minScore })).toEqual([
      'SCORE_NEAR_CUTOFF',
    ]);
    expect(referTriggers(POLICY_V2, { ...clean, score: POLICY_V2.minScore + band - 1 })).toEqual([
      'SCORE_NEAR_CUTOFF',
    ]);
    expect(referTriggers(POLICY_V2, { ...clean, score: POLICY_V2.minScore + band })).toEqual([]);
  });

  it('refers an amount above the threshold', () => {
    const threshold = POLICY_V2.escalation!.referAmountCents;
    expect(referTriggers(POLICY_V2, { ...clean, limitCents: threshold })).toEqual([]);
    expect(referTriggers(POLICY_V2, { ...clean, limitCents: threshold + 1 })).toEqual([
      'AMOUNT_ABOVE_THRESHOLD',
    ]);
  });

  it('refers on an integrity flag mapped to refer, and not on one that only informs', () => {
    const flag = (
      code: 'DUPLICATE_BANK_ACCOUNT' | 'STATED_REVENUE_ABOVE_VERIFIED',
      action: 'REFER' | 'INFORM',
    ) => ({ code, action, severity: 'HIGH', detail: '', metrics: {} }) as const;
    expect(
      referTriggers(POLICY_V2, { ...clean, flags: [flag('DUPLICATE_BANK_ACCOUNT', 'REFER')] }),
    ).toEqual(['INTEGRITY:DUPLICATE_BANK_ACCOUNT']);
    expect(
      referTriggers(POLICY_V2, {
        ...clean,
        flags: [flag('STATED_REVENUE_ABOVE_VERIFIED', 'INFORM')],
      }),
    ).toEqual([]);
  });

  it('does not refer counter offers by default, and can be told to', () => {
    const counter = { ...clean, limitCents: 180_000 };
    expect(referTriggers(POLICY_V2, counter)).toEqual([]);
    const strict: CreditPolicy = {
      ...POLICY_V2,
      escalation: { ...POLICY_V2.escalation!, referCounterOfferBelowBps: 7000 },
    };
    expect(referTriggers(strict, counter)).toEqual(['COUNTER_OFFER_FIRST_PLAN']);
    expect(referTriggers(strict, { ...counter, firstPlan: false })).toEqual([]);
  });

  it('returns REFER with the recommended terms and no triggers in the applicant reasons', () => {
    const r = decide(
      engineInput(account(), { integrityContext: { otherBusinessesWithSameBankAccount: 1 } }),
    );
    expect(r.outcome).toBe('REFER');
    expect(r.reasons[0]!.code).toBe('IN_REVIEW');
    expect(r.snapshot.referTriggers).toEqual(['INTEGRITY:DUPLICATE_BANK_ACCOUNT']);
    expect(r.snapshot.recommendation).toEqual({
      outcome: 'APPROVED',
      approvedMonthlyLimitCents: 300_000,
      feeBps: r.feeBps,
    });
    expect(JSON.stringify(r.reasons)).not.toContain('DUPLICATE');
  });

  it('does not refer an application the credit rules already decline', () => {
    const r = decide(
      engineInput(account(), {
        timeInBusinessMonths: 2,
        integrityContext: { otherBusinessesWithSameBankAccount: 1 },
      }),
    );
    expect(r.outcome).toBe('DECLINED');
    expect(r.snapshot.referTriggers).toEqual([]);
  });
});

describe('earlier decline detection', () => {
  const trend = (t: Partial<NonNullable<typeof cleanSummary.revenueTrend>>, extra = {}) => ({
    ...cleanSummary,
    ...extra,
    revenueTrend: { ...cleanSummary.revenueTrend!, ...t },
  });

  it('is off under the launch policy', () => {
    expect(
      detectDecline(trend({ yearOverYearBps: -5000, recent12VsPrior12WeeksBps: -5000 }), POLICY_V1),
    ).toBeNull();
  });

  it('declines when revenue is down on last year and the last twelve weeks confirm it', () => {
    const d = detectDecline(
      trend({ yearOverYearBps: -2200, recent12VsPrior12WeeksBps: -900 }),
      POLICY_V2,
    );
    expect(d?.code).toBe('REVENUE_DECLINING');
  });

  it('passes a seasonal trough: down on the prior weeks, level with last year', () => {
    expect(
      detectDecline(trend({ yearOverYearBps: -200, recent12VsPrior12WeeksBps: -3000 }), POLICY_V2),
    ).toBeNull();
  });

  it('passes one odd month a year apart when the recent weeks are fine', () => {
    expect(
      detectDecline(trend({ yearOverYearBps: -2500, recent12VsPrior12WeeksBps: 300 }), POLICY_V2),
    ).toBeNull();
  });

  it('widens the threshold for a business whose months are noisy', () => {
    const t = { yearOverYearBps: -2500, recent12VsPrior12WeeksBps: -900 };
    expect(detectDecline(trend(t, { revenueVolatilityBps: 1000 }), POLICY_V2)).not.toBeNull();
    expect(detectDecline(trend(t, { revenueVolatilityBps: 3000 }), POLICY_V2)).toBeNull();
  });

  it('needs a steeper fall when there is no year of history to rule out a season', () => {
    const young = (recent: number) =>
      detectDecline(trend({ yearOverYearBps: null, recent12VsPrior12WeeksBps: recent }), POLICY_V2);
    expect(young(-1500)).toBeNull();
    expect(young(-2100)?.code).toBe('REVENUE_DECLINING');
  });

  it('declines a smaller fall when the cash buffer is thin', () => {
    const t = { yearOverYearBps: -1200, recent12VsPrior12WeeksBps: -800 };
    expect(detectDecline(trend(t), POLICY_V2)).toBeNull();
    expect(detectDecline(trend(t, { daysOfCashOnHand: 9 }), POLICY_V2)?.code).toBe(
      'DECLINE_WITH_THIN_BUFFER',
    );
  });

  it('catches a slide the calendar quarter rule does not yet see', () => {
    // Revenue has been sliding for ten weeks and is now 30% down.
    const sliding = account({
      dailySalesCents: (ago) => 100_000 * (ago >= 70 ? 1 : 1 - 0.3 * ((70 - ago) / 70)),
    });
    const input = engineInput(sliding);
    const v1 = decide(input, POLICY_V1);
    const v2 = decide(input, POLICY_V2);
    expect(v1.cashFlow!.revenueGrowthBps).toBeGreaterThan(POLICY_V1.maxRevenueDeclineBps);
    expect(codes(v1)).not.toContain('REVENUE_DECLINING');
    expect(v2.outcome).toBe('DECLINED');
    expect(codes(v2)).toContain('REVENUE_DECLINING');
  });

  it('does not decline a seasonal business in its slow months', () => {
    // A summer peak and a winter trough, the same every year: +/- 35% around the mean.
    const start = addDays(AS_OF, -399);
    const dayOfYear = (date: string) => {
      const d = new Date(`${date}T00:00:00Z`);
      return (d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000;
    };
    const seasonal = account({
      dailySalesCents: (ago) => {
        const date = addDays(start, 399 - ago);
        return 100_000 * (1 + 0.35 * Math.sin(((dayOfYear(date) - 105) / 365) * 2 * Math.PI));
      },
    });
    const r = decide(engineInput(seasonal, { statedMonthlyRevenueCents: 2_400_000 }));
    // November is well into the slide from the July peak.
    expect(r.cashFlow!.revenueTrend!.recent12VsPrior12WeeksBps!).toBeLessThan(-1500);
    expect(Math.abs(r.cashFlow!.revenueTrend!.yearOverYearBps!)).toBeLessThan(500);
    expect(codes(r)).not.toContain('REVENUE_DECLINING');
    expect(codes(r)).not.toContain('DECLINE_WITH_THIN_BUFFER');
  });
});

describe('trend features', () => {
  const features = (transactions: ReturnType<typeof account>) =>
    computeCashFlowFeatures({
      transactions,
      currentBalanceCents: 6_000_000,
      asOf: AS_OF,
      statedMonthlyRevenueCents: 3_000_000,
      requestedMonthlyRentCents: 300_000,
    }).revenueTrend!;

  it('reads level revenue as flat on every measure', () => {
    expect(features(account())).toMatchObject({
      recent4VsPrior12WeeksBps: 0,
      recent12VsPrior12WeeksBps: 0,
      yearOverYearBps: 0,
      slope6Bps: 0,
      compositeBps: 0,
    });
  });

  it('measures a step down in the last four weeks against the prior weeks and last year', () => {
    const t = features(account({ dailySalesCents: (ago) => (ago < 28 ? 80_000 : 100_000) }));
    expect(t.recent4VsPrior12WeeksBps).toBe(-2000);
    expect(t.yearOverYearBps).toBe(-2000);
    expect(t.compositeBps).toBe(-2000);
  });

  it('has no year over year figure without about a year of history', () => {
    const t = features(
      account({ days: 300, dailySalesCents: (ago) => (ago < 84 ? 90_000 : 100_000) }),
    );
    expect(t.yearOverYearBps).toBeNull();
    expect(t.recent12VsPrior12WeeksBps).toBe(-1000);
    // The composite falls back to the twelve week comparison.
    expect(t.compositeBps).toBe(-1000);
  });

  it('uses the sandbox year of history: 48 weeks back is far enough', () => {
    expect(features(account({ days: 365 })).yearOverYearBps).toBe(0);
  });
});

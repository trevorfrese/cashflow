import { describe, expect, it } from 'vitest';

import {
  BASELINE_SERVICING_POLICY,
  STANDARD_SERVICING_POLICY,
  type ServicingPolicy,
} from '../servicing/policy.ts';
import { decide } from '../underwriting/engine.ts';
import { POLICY_V1, POLICY_V2, POLICY_V4 } from '../underwriting/policy.ts';
import { STRESS } from './assumptions.ts';
import { makeApplicant } from './fixtures.ts';
import { computeMetrics } from './metrics.ts';
import { drawPopulation } from './population.ts';
import {
  defaultPassThroughSim,
  runPortfolio,
  runThroughTheDoor,
  throughTheDoorCustomers,
  throughTheDoorFeeBps,
  UNCONSTRAINED_POOL_CENTS,
  underwrite,
  type PortfolioResult,
} from './portfolio.ts';

const HOLD: ServicingPolicy = {
  ...BASELINE_SERVICING_POLICY,
  name: 'hold',
  holdPayoutPastDueDays: 3,
  payoutReleaseWindowDays: 5,
};
const WRITE_OFF: ServicingPolicy = { ...HOLD, name: 'write_off', chargeOffAfterDays: 90 };

/**
 * The one plan tests below are about the simulator's mechanics (payouts, debits, aging, the
 * pool), not about credit policy. They run the launch policy, whose decisions do not depend
 * on the size of the pool, so a test can use a small pool without tripping an exposure rule.
 */
const MECHANICS = {
  decide: (input: Parameters<typeof decide>[0]) => decide(input, POLICY_V1),
  exposure: null,
};

function sum(result: PortfolioResult, pick: (c: PortfolioResult['customers'][number]) => number) {
  return result.customers.reduce((total, c) => total + pick(c), 0);
}

/** Starting pool plus fees, less net losses, equals ending pool plus what is still owed. */
function expectCashConserved(result: PortfolioResult) {
  const fees = sum(result, (c) => c.feesCollectedCents);
  const netLoss = sum(result, (c) => c.chargedOffCents - c.recoveredCents);
  const outstanding = sum(result, (c) => c.outstandingCents);
  expect(result.poolStartCents + fees - netLoss).toBe(result.poolEndCents + outstanding);
  for (const c of result.customers) {
    expect(c.payoutCents).toBe(c.principalCollectedCents + c.chargedOffCents + c.outstandingCents);
  }
}

describe('portfolio simulator: one plan', () => {
  it('a healthy business is approved and repays every installment with the fee', () => {
    const result = runPortfolio([makeApplicant()], { ...MECHANICS, poolSizeCents: 1_000_000 });
    const c = result.customers[0]!;
    expect(c.outcome).toBe('APPROVED');
    expect(c.planRentCents).toBe(400_000);
    expect(c.payoutCount).toBe(12);
    expect(c.payoutCents).toBe(12 * 400_000);
    expect(c.principalCollectedCents).toBe(c.payoutCents);
    expect(c.feesCollectedCents).toBe((12 * 400_000 * c.feeBps!) / 10_000);
    expect(c.chargedOffCents).toBe(0);
    expect(c.bad).toBe(false);
    expect(c.failedDebits).toBe(0);
    // Half the rent is repaid on the due date and half two weeks later.
    expect(c.outstandingCentDays).toBe(12 * 200_000 * 14);
    expect(result.poolEndCents).toBe(1_000_000 + c.feesCollectedCents);
    expectCashConserved(result);
  });

  it('the decision reads a history that is a prefix of the path the plan is played on', () => {
    const applicant = makeApplicant();
    const a = underwrite(applicant, { decide, stress: null, startDate: '2026-01-01' });
    const b = underwrite(applicant, { decide, stress: null, startDate: '2026-01-01' });
    expect(a.decision).toEqual(b.decision);
    expect(a.decision.cashFlow?.asOf).toBe(applicant.applicationDate);
    // The simulation handed back is positioned on the day after the application.
    expect(a.sim?.date).toBe('2026-01-11');
    expect(a.sim?.dayIndex).toBe(applicant.historyDays);
  });

  it('a closure produces unpaid installments, and today nothing stops the payouts', () => {
    const closing = makeApplicant({
      params: { events: [{ kind: 'closure', date: '2026-04-20' }] },
    });
    const result = runPortfolio([closing], { ...MECHANICS, poolSizeCents: 10_000_000 });
    const c = result.customers[0]!;
    expect(c.outcome).toBe('APPROVED');
    expect(c.closedOn).toBe('2026-04-20');
    // February, March, and April were repaid. May through January were paid out and lost.
    expect(c.payoutCount).toBe(12);
    expect(c.principalCollectedCents).toBe(3 * 400_000);
    expect(c.chargedOffCents).toBe(9 * 400_000);
    expect(c.recoveredCents).toBe(9 * 40_000);
    expect(c.outstandingCents).toBe(0);
    expect(c.bad).toBe(true);
    expect(c.firstPaymentDefault).toBe(false);
    expect(c.failedDebits).toBeGreaterThan(100);
    expect(c.lateInstallments).toBe(18);
    expectCashConserved(result);
  });

  it('holding payouts bounds the loss from the same closure to one period', () => {
    const closing = makeApplicant({
      params: { events: [{ kind: 'closure', date: '2026-04-20' }] },
    });
    const result = runPortfolio([closing], {
      ...MECHANICS,
      poolSizeCents: 10_000_000,
      servicing: HOLD,
    });
    const c = result.customers[0]!;
    expect(c.payoutCount).toBe(4);
    // Every later payout is held, never released, and cancelled when its window closes.
    expect(c.heldPayouts).toBe(8);
    expect(c.releasedPayouts).toBe(0);
    expect(c.cancelledPayouts).toBe(8);
    expect(c.chargedOffCents).toBe(400_000);
    expectCashConserved(result);

    // Writing off at 90 days during the run gives the same loss as measuring it at the end.
    const writtenOff = runPortfolio([closing], {
      ...MECHANICS,
      poolSizeCents: 10_000_000,
      servicing: WRITE_OFF,
    });
    expect(writtenOff.customers[0]!.chargedOffCents).toBe(400_000);
    expect(writtenOff.customers[0]!.recoveredCents).toBe(40_000);
    expectCashConserved(writtenOff);
  });

  it('writes the whole unpaid balance off at once and closes the plan', () => {
    // Closes two days after the first installment of the fifth period: half of that month's
    // rent is unpaid. The second half reaches 90 days two weeks after the first would.
    const closing = makeApplicant({
      params: { events: [{ kind: 'closure', date: '2026-06-03' }] },
    });
    const result = runPortfolio([closing], {
      ...MECHANICS,
      poolSizeCents: 10_000_000,
      servicing: STANDARD_SERVICING_POLICY,
      returnDelayDays: 2,
    });
    const c = result.customers[0]!;
    expect(c.payoutCount).toBe(5);
    expect(c.chargedOffCents).toBe(200_000);
    expect(c.recoveredCents).toBe(20_000);
    // Each of the three rent dates before the write off is held, never released, and
    // cancelled. Then the plan is closed and nothing more falls due.
    expect(c.heldPayouts).toBe(3);
    expect(c.releasedPayouts).toBe(0);
    expect(c.cancelledPayouts).toBe(3);
    expect(c.maxDaysPastDue).toBe(90);
    expectCashConserved(result);
  });

  it('the balance check puts debits off without using attempts', () => {
    const closing = makeApplicant({
      params: { events: [{ kind: 'closure', date: '2026-04-20' }] },
    });
    const run = (balancePreCheck: boolean) =>
      runPortfolio([closing], {
        ...MECHANICS,
        poolSizeCents: 10_000_000,
        servicing: {
          ...STANDARD_SERVICING_POLICY,
          retry: { ...STANDARD_SERVICING_POLICY.retry, balancePreCheck },
        },
        returnDelayDays: 2,
      }).customers[0]!;
    // Without the check, each of the two unpaid installments is presented three times and
    // returned three times. With it, the empty account is read every day and never debited.
    const blind = run(false);
    expect(blind.failedDebits).toBe(6);
    expect(blind.deferredDebits).toBe(0);
    const checked = run(true);
    expect(checked.failedDebits).toBe(0);
    expect(checked.deferredDebits).toBeGreaterThan(100);
    // The loss is the same either way: the business is gone.
    expect(checked.chargedOffCents).toBe(400_000);
    expect(blind.chargedOffCents).toBe(400_000);
  });

  it('a returned debit is booked as collected until the return arrives, and conserves cash', () => {
    const closing = makeApplicant({
      params: { events: [{ kind: 'closure', date: '2026-04-20' }] },
    });
    const noCheck = {
      ...STANDARD_SERVICING_POLICY,
      retry: { ...STANDARD_SERVICING_POLICY.retry, balancePreCheck: false },
    };
    const run = (returnDelayDays: number) =>
      runPortfolio([closing], {
        ...MECHANICS,
        poolSizeCents: 10_000_000,
        servicing: noCheck,
        returnDelayDays,
      });
    const immediate = run(0);
    const delayed = run(2);
    expectCashConserved(immediate);
    expectCashConserved(delayed);
    // Same debits, same loss. Only the books in between differ.
    expect(delayed.customers[0]).toEqual(immediate.customers[0]);
    expect(delayed.poolEndCents).toBe(immediate.poolEndCents);
  });

  // A business that takes a large one off bill in March and has no owner reserve: its
  // debits bounce for a while, it keeps trading, and its account recovers.
  const squeezed = makeApplicant({
    params: {
      ownerReserveCents: 0,
      overdraftLimitCents: 100_000_000,
      events: [{ kind: 'expense', date: '2026-03-13', shareOfMonthly: 3.5 }],
    },
  });
  const noCheck: ServicingPolicy = {
    ...STANDARD_SERVICING_POLICY,
    retry: { ...STANDARD_SERVICING_POLICY.retry, balancePreCheck: false },
  };

  it('releases a held payout when the business cures inside the window', () => {
    // The owner pays each overdue installment by hand 18 days past due: an installment due
    // on the 15th is paid on the 2nd, a day after the next payout was held.
    const result = runPortfolio([squeezed], {
      ...MECHANICS,
      poolSizeCents: 10_000_000,
      servicing: noCheck,
      manualPayment: { shareBps: 10_000, firstDay: 18, lastDay: 18 },
    });
    const c = result.customers[0]!;
    expect(c.heldPayouts).toBe(2);
    expect(c.releasedPayouts).toBe(2);
    expect(c.cancelledPayouts).toBe(0);
    // Every month was fronted in the end, and nothing was lost.
    expect(c.payoutCount).toBe(12);
    expect(c.chargedOffCents).toBe(0);
    expect(c.manualPayments).toBeGreaterThan(0);
    expectCashConserved(result);
  });

  it('cancels a held payout when the cure comes after the window', () => {
    // Paid by hand 25 days past due: the 9th, three days after the window closed.
    const result = runPortfolio([squeezed], {
      ...MECHANICS,
      poolSizeCents: 10_000_000,
      servicing: noCheck,
      manualPayment: { shareBps: 10_000, firstDay: 25, lastDay: 25 },
    });
    const c = result.customers[0]!;
    expect(c.heldPayouts).toBe(2);
    expect(c.releasedPayouts).toBe(0);
    expect(c.cancelledPayouts).toBe(2);
    // The two cancelled months were never fronted, and are not made up later.
    expect(c.payoutCount).toBe(10);
    expect(c.payoutCents).toBe(10 * 400_000);
    expect(c.chargedOffCents).toBe(0);
    expectCashConserved(result);
  });

  it('fronts a whole lease rent or nothing, as the product does', () => {
    // An approval for less than the rent requested.
    const counterOffer = (input: Parameters<typeof decide>[0]) => ({
      ...decide(input, POLICY_V1),
      approvedMonthlyLimitCents: 300_000,
    });
    const product = runPortfolio([makeApplicant()], {
      ...MECHANICS,
      decide: counterOffer,
      poolSizeCents: 10_000_000,
    });
    expect(product.customers[0]).toMatchObject({
      outcome: 'APPROVED',
      counterOffer: true,
      unusableCounterOffer: true,
      planRentCents: 0,
      payoutCount: 0,
    });
    const m = computeMetrics(product).overall;
    expect(m).toMatchObject({
      approved: 1,
      approvalRateBps: 10_000,
      counterOffers: 1,
      unusableCounterOffers: 1,
      usableApprovalRateBps: 0,
      plans: 0,
    });

    // The alternative the product does not offer: front the limit, the business pays the rest.
    const partial = runPortfolio([makeApplicant()], {
      ...MECHANICS,
      decide: counterOffer,
      poolSizeCents: 10_000_000,
      partialAdvance: true,
    });
    expect(partial.customers[0]).toMatchObject({
      counterOffer: true,
      unusableCounterOffer: false,
      planRentCents: 300_000,
      payoutCount: 12,
    });
    expect(computeMetrics(partial).overall.usableApprovalRateBps).toBe(10_000);
    expectCashConserved(partial);
  });

  it('a bust out defaults on the first payment', () => {
    const bustOut = makeApplicant({
      fraud: 'bust_out',
      segment: 'bust_out',
      params: { events: [{ kind: 'closure', date: '2026-01-15' }] },
    });
    const c = runPortfolio([bustOut], { ...MECHANICS, poolSizeCents: 10_000_000 }).customers[0]!;
    expect(c.outcome).toBe('APPROVED');
    expect(c.firstPaymentDefault).toBe(true);
    expect(c.principalCollectedCents).toBe(0);
    expect(c.feesCollectedCents).toBe(0);
  });

  it('a pool too small to fund a payout records the shortfall and never goes negative', () => {
    const result = runPortfolio([makeApplicant()], { ...MECHANICS, poolSizeCents: 300_000 });
    expect(result.unfundedPayouts).toBe(12);
    expect(result.poolMinCents).toBe(300_000);
    expect(result.customers[0]!.payoutCount).toBe(0);
    expectCashConserved(result);
  });

  it('does not open a plan without an approval', () => {
    const noBank = makeApplicant({ historyDays: 0 });
    const result = runPortfolio([noBank]);
    expect(result.customers[0]!.outcome).toBe('NEEDS_INFO');
    expect(result.customers[0]!.payoutCount).toBe(0);
    expect(result.pool.every((m) => m.payoutsCents === 0)).toBe(true);
  });

  it('accepts a challenger decision function', () => {
    const result = runPortfolio([makeApplicant()], {
      decide: (input) => ({
        ...decide(input),
        outcome: 'DECLINED',
        approvedMonthlyLimitCents: null,
      }),
    });
    expect(result.customers[0]!.outcome).toBe('DECLINED');
    expect(result.customers[0]!.payoutCount).toBe(0);
  });
});

describe('portfolio simulator: review and exposure', () => {
  const v2 = {
    decide: (input: Parameters<typeof decide>[0]) => decide(input, POLICY_V2),
    exposure: POLICY_V2.exposure,
  };
  const referEverything = {
    ...v2,
    decide: (input: Parameters<typeof decide>[0]) => {
      const r = decide(input, POLICY_V2);
      return r.outcome === 'APPROVED' ? { ...r, outcome: 'REFER' as const } : r;
    },
  };

  it('a clean applicant is decided by the engine alone under the current policy', () => {
    const c = runPortfolio([makeApplicant()], { ...v2, poolSizeCents: 100_000_000 }).customers[0]!;
    expect(c).toMatchObject({ outcome: 'APPROVED', engineOutcome: 'APPROVED', referred: false });
    expect(c.payoutCount).toBe(12);
    // The limit is the request and the fee build up is recorded.
    expect(c.approvedLimitCents).toBe(400_000);
    expect(c.pdBps).toBeGreaterThan(0);
    expect(c.expectedLossBps).toBeGreaterThan(0);
  });

  it('a referred honest applicant is approved at the terms the engine recommended', () => {
    const c = runPortfolio([makeApplicant()], {
      ...referEverything,
      poolSizeCents: 100_000_000,
    }).customers[0]!;
    expect(c).toMatchObject({ outcome: 'APPROVED', engineOutcome: 'REFER', referred: true });
    expect(c.planRentCents).toBe(400_000);
    expect(c.payoutCount).toBe(12);
  });

  it('a referred fraud applicant is declined when the reviewer catches it, funded when not', () => {
    const fraud = makeApplicant({ fraud: 'inflated_revenue', segment: 'inflated_revenue' });
    const caught = runPortfolio([fraud], {
      ...referEverything,
      poolSizeCents: 100_000_000,
      reviewFraudCatchRateBps: 10_000,
    }).customers[0]!;
    expect(caught).toMatchObject({ outcome: 'DECLINED', engineOutcome: 'REFER', referred: true });
    expect(caught.payoutCount).toBe(0);
    const missed = runPortfolio([fraud], {
      ...referEverything,
      poolSizeCents: 100_000_000,
      reviewFraudCatchRateBps: 0,
    }).customers[0]!;
    expect(missed).toMatchObject({ outcome: 'APPROVED', referred: true });
    expect(missed.payoutCount).toBe(12);
  });

  it('a plan waits when the pool is over its utilization ceiling, then gives up', () => {
    // $4,000 of rent against a $4,500 pool is 89% of capital: over the 85% ceiling. The
    // engine is told nothing about the pool here, so only the start of the plan is gated.
    const result = runPortfolio([makeApplicant()], {
      decide: (input) => decide({ ...input, exposureContext: null }, POLICY_V2),
      exposure: POLICY_V2.exposure,
      poolSizeCents: 450_000,
      maxWaitMonths: 2,
    });
    const c = result.customers[0]!;
    expect(c.outcome).toBe('APPROVED');
    expect(c).toMatchObject({ neverFunded: true, fundingWaitMonths: 3, payoutCount: 0 });
    expect(result).toMatchObject({ plansDelayed: 1, plansNeverFunded: 1, unfundedPayouts: 0 });
    expectCashConserved(result);
    // The same plan starts at once when the exposure rules are off.
    const open = runPortfolio([makeApplicant()], {
      decide: (input) => decide({ ...input, exposureContext: null }, POLICY_V2),
      exposure: null,
      poolSizeCents: 450_000,
    });
    expect(open.customers[0]!.payoutCount).toBe(12);
  });

  it('a business over its share of the pool waits: the limit is not cut', () => {
    // 5% of a $50,000 pool is $2,500, against a $4,000 plan.
    const result = runPortfolio([makeApplicant()], { ...v2, poolSizeCents: 5_000_000 });
    const c = result.customers[0]!;
    expect(c.outcome).toBe('APPROVED');
    expect(c.approvedLimitCents).toBe(400_000);
    expect(c).toMatchObject({ neverFunded: true, payoutCount: 0 });
  });
});

describe('portfolio simulator: fixed seed end to end', () => {
  const population = drawPopulation({ n: 300, seed: 'e2e' });
  const base = runPortfolio(population);
  const metrics = computeMetrics(base);

  it('is deterministic', () => {
    expect(runPortfolio(population)).toEqual(base);
    const other = runPortfolio(drawPopulation({ n: 300, seed: 'e2e-other' }));
    expect(computeMetrics(other).overall.volumeCents).not.toBe(metrics.overall.volumeCents);
  });

  it('decides every applicant once and the outcome rates sum to one', () => {
    expect(base.customers).toHaveLength(300);
    expect(new Set(base.customers.map((c) => c.applicantId)).size).toBe(300);
    const o = metrics.overall;
    expect(o.approved + o.declined + o.needsInfo).toBe(300);
    const rates = o.approvalRateBps + metrics.declineRateBps + metrics.needsInfoRateBps;
    expect(Math.abs(rates - 10_000)).toBeLessThanOrEqual(1);
    expect(o.approved).toBeGreaterThan(0);
    expect(o.declined).toBeGreaterThan(0);
  });

  it('volume equals the sum of landlord payouts, by customer and by month', () => {
    const byCustomer = sum(base, (c) => c.payoutCents);
    expect(metrics.overall.volumeCents).toBe(byCustomer);
    expect(base.pool.reduce((a, m) => a + m.payoutsCents, 0)).toBe(byCustomer);
    for (const c of base.customers) {
      expect(c.payoutCents).toBe(c.payoutCount * c.planRentCents);
      if (c.outcome !== 'APPROVED') expect(c.payoutCount).toBe(0);
      else expect(c.planRentCents).toBeLessThanOrEqual(c.requestedRentCents);
    }
  });

  it('conserves cash in base, under stress, and under other servicing policies', () => {
    expectCashConserved(base);
    expectCashConserved(runPortfolio(population, { stress: STRESS.severe }));
    expectCashConserved(runPortfolio(population, { servicing: WRITE_OFF }));
    expectCashConserved(runPortfolio(population, { poolSizeCents: 20_000_000 }));
  });

  it('keeps the pool non negative and the monthly series consistent', () => {
    expect(base.poolMinCents).toBeGreaterThanOrEqual(0);
    for (const m of base.pool) {
      expect(m.minPoolCents).toBeGreaterThanOrEqual(0);
      expect(m.endReceivableCents).toBeGreaterThanOrEqual(0);
      expect(m.peakUtilizationBps).toBeGreaterThanOrEqual(0);
      expect(m.peakUtilizationBps).toBeLessThanOrEqual(10_000);
    }
    expect(base.pool[base.pool.length - 1]!.endPoolCents).toBe(base.poolEndCents);
    expect(base.pool[base.pool.length - 1]!.endReceivableCents).toBe(0);
  });

  it('a book wide shock does not make the book perform better', () => {
    const severe = computeMetrics(runPortfolio(population, { stress: STRESS.severe }));
    expect(severe.overall.badRateBps).toBeGreaterThanOrEqual(metrics.overall.badRateBps);
    expect(severe.overall.approved).toBeLessThanOrEqual(metrics.overall.approved);
  });
});

// Whole populations are played forward here, which takes seconds on a CI runner.
describe('portfolio simulator: through the door', { timeout: 30_000 }, () => {
  const population = drawPopulation({ n: 300, seed: 'e2e' });
  const gatedConfig = {
    servicing: STANDARD_SERVICING_POLICY,
    returnDelayDays: 2,
  };
  const gated = runPortfolio(population, gatedConfig);
  const gatedMetrics = computeMetrics(gated);
  const door = runThroughTheDoor(population, { ...gatedConfig, fallbackFeeBps: 300 });
  const gatedById = new Map(gated.customers.map((c) => [c.applicantId, c]));

  it('funds every scored applicant at the rent requested, and nobody without a score', () => {
    expect(door.customers).toHaveLength(300);
    const scored = door.customers.filter((c) => c.score !== null);
    const unscored = door.customers.filter((c) => c.score === null);
    expect(unscored.length).toBeGreaterThan(0);
    for (const c of scored) {
      expect(c.payoutCount).toBeGreaterThan(0);
      expect(c.planRentCents).toBe(c.requestedRentCents);
      expect(c.payoutCents).toBe(c.payoutCount * c.requestedRentCents);
      expect(c.feeBps).not.toBeNull();
    }
    for (const c of unscored) {
      expect(c.outcome).toBe('NEEDS_INFO');
      expect(c.payoutCount).toBe(0);
    }
  });

  it('covers the applicants the policy declined, and some of them go bad', () => {
    const declined = door.customers.filter((c) => c.outcome === 'DECLINED' && c.score !== null);
    expect(declined.length).toBeGreaterThan(50);
    for (const c of declined) {
      expect(gatedById.get(c.applicantId)!.payoutCount).toBe(0);
      expect(c.payoutCount).toBeGreaterThan(0);
    }
    const declinedBad = declined.filter((c) => c.bad).length;
    expect(declinedBad).toBeGreaterThan(0);
    expect(declinedBad).toBeLessThan(declined.length);
    // An approval for less than the rent opens no plan in the product. It does here.
    const countered = door.customers.filter((c) => c.outcome === 'APPROVED' && c.counterOffer);
    for (const c of countered) {
      expect(gatedById.get(c.applicantId)!.unusableCounterOffer).toBe(true);
      expect(c.payoutCount).toBeGreaterThan(0);
    }
  });

  it('records the same decisions as the gated run', () => {
    for (const c of door.customers) {
      const g = gatedById.get(c.applicantId)!;
      expect([c.outcome, c.engineOutcome, c.referred, c.score, c.grade, c.counterOffer]).toEqual([
        g.outcome,
        g.engineOutcome,
        g.referred,
        g.score,
        g.grade,
        g.counterOffer,
      ]);
    }
  });

  it('plays a plan the gated run funded without delay exactly as the gated run did', () => {
    expect(gated.unfundedPayouts).toBe(0);
    const funded = gated.customers.filter((c) => c.payoutCount > 0 && c.fundingWaitMonths === 0);
    expect(funded.length).toBeGreaterThan(50);
    for (const g of funded) {
      expect(door.customers.find((c) => c.applicantId === g.applicantId)).toEqual(g);
    }
  });

  it('is never short of capital and applies no exposure rule', () => {
    expect(door.poolStartCents).toBe(UNCONSTRAINED_POOL_CENTS);
    expect(door.unfundedPayouts).toBe(0);
    expect(door.plansDelayed).toBe(0);
    expect(door.plansNeverFunded).toBe(0);
    expect(door.customers.every((c) => c.fundingWaitMonths === 0 && !c.neverFunded)).toBe(true);
    // Even when the caller passes a small pool and exposure rules, they are lifted.
    const forced = runThroughTheDoor(population, {
      ...gatedConfig,
      fallbackFeeBps: 300,
      poolSizeCents: 1,
      exposure: POLICY_V2.exposure,
      partialAdvance: true,
    });
    expect(forced).toEqual(door);
  });

  it('is deterministic', () => {
    expect(runThroughTheDoor(population, { ...gatedConfig, fallbackFeeBps: 300 })).toEqual(door);
  });

  it('gives the same customers when it reuses the plans the gated run already played', () => {
    const shared = throughTheDoorCustomers(
      population,
      { ...gatedConfig, fallbackFeeBps: 300 },
      gated,
    );
    expect(shared).toEqual(door.customers);
    // The reused results are the gated run's own objects, left as they were.
    const reused = shared.filter((c) => c === gatedById.get(c.applicantId));
    expect(reused.length).toBeGreaterThan(50);
    expect(reused.length).toBeLessThan(300);
    expect(runPortfolio(population, gatedConfig)).toEqual(gated);
  });

  it('reuses nothing from a run whose plans waited for the pool', () => {
    // A pool this small leaves payouts unfunded and plans waiting: none of it is the plan
    // an unconstrained pool would have given, so everyone is played again.
    const starved = runPortfolio(population, { ...gatedConfig, poolSizeCents: 30_000_000 });
    expect(starved.unfundedPayouts + starved.plansDelayed).toBeGreaterThan(0);
    expect(
      throughTheDoorCustomers(population, { ...gatedConfig, fallbackFeeBps: 300 }, starved),
    ).toEqual(door.customers);
    // The same under the launch policy and baseline servicing, as the comparisons run it.
    const v1 = {
      decide: (input: Parameters<typeof decide>[0]) => decide(input, POLICY_V1),
      servicing: BASELINE_SERVICING_POLICY,
      returnDelayDays: 0,
      fallbackFeeBps: 300,
    };
    expect(
      throughTheDoorCustomers(population, v1, runPortfolio(population, { ...v1, exposure: null })),
    ).toEqual(runThroughTheDoor(population, v1).customers);
  });

  it('leaves the gated run as it was', () => {
    // The gated run, repeated after the through the door run, is identical to the cent.
    const again = runPortfolio(population, gatedConfig);
    expect(again).toEqual(gated);
    expect(computeMetrics(again)).toEqual(gatedMetrics);
    // And the gated run funds only what the policy approved.
    expect(gatedMetrics.overall.plans).toBeLessThan(
      door.customers.filter((c) => c.payoutCount > 0).length,
    );
  });

  it('conserves cash', () => {
    expectCashConserved(door);
  });

  it('charges the quoted fee, then the priced fee held to the cap, then the fallback', () => {
    const base = decide({
      statedMonthlyRevenueCents: 4_000_000,
      timeInBusinessMonths: 48,
      requestedMonthlyRentCents: 400_000,
      bankData: null,
    });
    const priced = (feeBps: number, maxFeeBps: number) =>
      ({ feeBps, maxFeeBps }) as NonNullable<typeof base.snapshot.pricing>;
    const decision = (feeBps: number | null, pricing: typeof base.snapshot.pricing) => ({
      ...base,
      feeBps,
      snapshot: { ...base.snapshot, pricing },
    });
    expect(throughTheDoorFeeBps(decision(175, priced(175, 400)), 300)).toBe(175);
    expect(throughTheDoorFeeBps(decision(null, priced(260, 400)), 300)).toBe(260);
    expect(throughTheDoorFeeBps(decision(null, priced(900, 400)), 300)).toBe(400);
    expect(throughTheDoorFeeBps(decision(null, null), 300)).toBe(300);
  });

  it('gives a declined applicant a plan at the fallback fee, and an unscored one nothing', () => {
    const declineAll = {
      decide: (input: Parameters<typeof decide>[0]) => {
        const d = decide(input, POLICY_V1);
        return d.score === null
          ? d
          : { ...d, outcome: 'DECLINED' as const, approvedMonthlyLimitCents: null, feeBps: null };
      },
    };
    const applicants = [makeApplicant(), makeApplicant({ id: 'a00001', historyDays: 0 })];
    expect(runPortfolio(applicants, declineAll).customers.map((c) => c.payoutCount)).toEqual([
      0, 0,
    ]);
    const result = runThroughTheDoor(applicants, { ...declineAll, fallbackFeeBps: 300 });
    const [declined, unscored] = result.customers;
    expect(declined).toMatchObject({
      outcome: 'DECLINED',
      feeBps: 300,
      planRentCents: 400_000,
      payoutCount: 12,
      payoutCents: 12 * 400_000,
      feesCollectedCents: (12 * 400_000 * 300) / 10_000,
      bad: false,
    });
    expect(unscored).toMatchObject({ outcome: 'NEEDS_INFO', score: null, payoutCount: 0 });
  });
});

describe('portfolio simulator: pass-through plans and graduation', () => {
  const population = drawPopulation({ n: 300, seed: 'pass-through' });
  const v4 = {
    decide: (input: Parameters<typeof decide>[0]) => decide(input, POLICY_V4),
    exposure: POLICY_V4.exposure,
    servicing: STANDARD_SERVICING_POLICY,
    returnDelayDays: 2,
  };
  const without = runPortfolio(population, v4);
  const withPassThrough = runPortfolio(population, {
    ...v4,
    passThrough: defaultPassThroughSim(POLICY_V4.graduation!, 12),
  });

  it('leaves every origination decision as it was', () => {
    expect(withPassThrough.customers.map((c) => [c.applicantId, c.outcome, c.score])).toEqual(
      without.customers.map((c) => [c.applicantId, c.outcome, c.score]),
    );
    expect(without.passThrough).toBeNull();
    expect(without.graduates).toEqual([]);
  });

  it('puts credit declines, and only them, on a pass-through plan', () => {
    const stats = withPassThrough.passThrough!;
    expect(stats.declined).toBe(
      withPassThrough.customers.filter((c) => c.engineOutcome === 'DECLINED').length,
    );
    expect(stats.eligible).toBeGreaterThan(0);
    expect(stats.onTimeMonths + stats.missedMonths).toBe(stats.months);
    for (const c of withPassThrough.customers) {
      if (c.passThroughMonths > 0) expect(c.engineOutcome).toBe('DECLINED');
      // A pass-through plan never fronts anything.
      if (c.outcome !== 'APPROVED') expect(c.payoutCount).toBe(0);
    }
    expect(withPassThrough.customers.reduce((n, c) => n + c.passThroughMonths, 0)).toBe(
      stats.months,
    );
  });

  it('graduates only after enough on time months, as financed plans from the same pool', () => {
    const stats = withPassThrough.passThrough!;
    expect(withPassThrough.graduates).toHaveLength(stats.graduated);
    expect(stats.graduated).toBeLessThanOrEqual(stats.offers);
    expect(stats.offers).toBeLessThanOrEqual(stats.reviewApproved);
    for (const g of withPassThrough.graduates) {
      expect(g.graduated).toBe(true);
      expect(g.outcome).toBe('APPROVED');
      expect(g.passThroughOnTimeMonths).toBeGreaterThanOrEqual(
        POLICY_V4.graduation!.minOnTimeMonths,
      );
      expect(g.approvedLimitCents!).toBeGreaterThanOrEqual(g.requestedRentCents);
      expect(g.payoutCents).toBe(
        g.principalCollectedCents + g.chargedOffCents + g.outstandingCents,
      );
    }
    // The pool conserves cash across the origination book and the graduates together.
    const all = [...withPassThrough.customers, ...withPassThrough.graduates];
    const total = (f: (c: (typeof all)[number]) => number) => all.reduce((s, c) => s + f(c), 0);
    expect(
      withPassThrough.poolStartCents +
        total((c) => c.feesCollectedCents) -
        total((c) => c.chargedOffCents - c.recoveredCents),
    ).toBe(withPassThrough.poolEndCents + total((c) => c.outstandingCents));
  });

  it('is deterministic', () => {
    const again = runPortfolio(population, {
      ...v4,
      passThrough: defaultPassThroughSim(POLICY_V4.graduation!, 12),
    });
    expect(again.passThrough).toEqual(withPassThrough.passThrough);
    expect(again.graduates).toEqual(withPassThrough.graduates);
  });
});

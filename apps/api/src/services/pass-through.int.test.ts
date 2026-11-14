import { addDays, type IsoDate } from '@cashflow/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../context.ts';
import { effectiveAt, todayIso } from '../dates.ts';
import { apply, createBusiness, createLease, linkBank } from '../dev/builders.ts';
import { runAllJobs } from '../jobs/index.ts';
import { ACCOUNTS, receivableCode } from '../ledger/accounts.ts';
import { accountBalance, trialBalance } from '../ledger/service.ts';
import {
  adminClient,
  client,
  createTestApp,
  fundPool,
  registerUser,
  resetDb,
  type TestHarness,
} from '../test/helpers.ts';
import { acceptGraduationOffer } from './graduation.ts';
import { UNPAID } from './delinquency.ts';
import { paymentHistorySummary } from './payment-history.ts';
import { startPassThroughPlan } from './pass-through.ts';

/**
 * Pass-through plans across simulated dates, on a real Postgres. Each story starts a few
 * months back, because the sandbox bank's history ends today: the refresh-eligibility review
 * needs data that is fresh on the day it runs. Every day runs the whole job set twice; the
 * second run must change nothing, and the trial balance must balance after each.
 */

let h: TestHarness;
let ctx: AppContext;

beforeAll(async () => {
  h = await createTestApp();
  ctx = h.app.ctx;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDb(h.db);
  h.payments.reset();
});

const RENT = 400_000;
const HEALTHY = 'mock_healthy_rev_40000_rent_4000';

async function fingerprint() {
  const [tb, transactions, audits, plans, periods, payouts, disbursements, offers, decisions] =
    await Promise.all([
      trialBalance(h.db),
      h.db.ledgerTransaction.count(),
      h.db.auditEvent.count(),
      h.db.rentPlan.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
      h.db.passThroughPeriod.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, status: true, collectionAttempts: true, heldReason: true },
      }),
      h.db.landlordPayout.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
      h.db.landlordDisbursement.count(),
      h.db.graduationOffer.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
      h.db.underwritingDecision.count(),
    ]);
  return {
    balances: tb.accounts.map((a) => [a.account.code, a.balanceCents]),
    balanced: tb.balanced,
    transactions,
    audits,
    plans,
    periods,
    payouts,
    disbursements,
    offers,
    decisions,
  };
}

/** Run every job as of `asOf`, twice. The second run changes nothing; the books balance. */
async function run(asOf: IsoDate) {
  const result = await runAllJobs(ctx, asOf);
  for (const [name, job] of Object.entries(result)) {
    const j = job as { ok: boolean; error?: string };
    if (name !== 'asOf') expect(j.ok, `${name} on ${asOf}: ${j.error ?? ''}`).toBe(true);
  }
  const first = await fingerprint();
  expect(first.balanced, `trial balance on ${asOf}`).toBe(true);
  await runAllJobs(ctx, asOf);
  expect(await fingerprint(), `second run on ${asOf} changed something`).toEqual(first);
  return result;
}

async function runThrough(from: IsoDate, to: IsoDate) {
  for (let d = from; d <= to; d = addDays(d, 1)) await run(d);
}

/** Landlord payable and the pass-through cash behind it, and the alerts the books raise. */
async function passThroughBooks() {
  const [payable, cash, held] = await Promise.all([
    accountBalance(h.db, ACCOUNTS.LANDLORD_PAYABLE),
    accountBalance(h.db, ACCOUNTS.PASS_THROUGH_CASH),
    h.db.passThroughPeriod.aggregate({
      where: { status: { in: ['COLLECTING', 'SETTLED'] } },
      _sum: { amountCents: true },
    }),
  ]);
  const alerts = await h.db.alert.findMany({
    where: {
      type: {
        in: [
          'books.landlord_payable_mismatch',
          'books.pass_through_payout_before_settlement',
          'books.receivable_mismatch',
          'books.trial_balance_unbalanced',
        ],
      },
      status: { not: 'RESOLVED' },
    },
  });
  return { payable, cash, held: held._sum.amountCents ?? 0, alerts };
}

/**
 * A business declined on `start` for credit capacity: healthy cash flow, but four months in
 * business. Its lease is due on the first. Returns what a pass-through plan needs.
 */
async function declinedBusiness(start: IsoDate, bankToken = HEALTHY) {
  const session = await registerUser(h.app);
  const at = effectiveAt(start);
  const business = await createBusiness(
    ctx,
    session.userId,
    {
      legalName: 'Ridgeline Coffee LLC',
      dba: 'Ridgeline Coffee',
      industry: 'RESTAURANT',
      addressLine1: '1 Main St',
      postalCode: '97204',
      foundedOn: addDays(start, -120),
      monthlyRevenueCents: 4_000_000,
      taxIdLast4: '4821',
      owner: { fullName: 'Dana Rivera', title: 'Owner' },
    },
    { createdAt: at },
  );
  const { bankLink } = await linkBank(ctx, business.id, bankToken, at);
  const application = await apply(ctx, {
    businessId: business.id,
    bankLink,
    monthlyRevenueCents: 4_000_000,
    timeInBusinessMonths: 4,
    rentCents: RENT,
    asOf: start,
    createdAt: at,
  });
  expect(application.status).toBe('DECLINED');
  const lease = await createLease(ctx, {
    businessId: business.id,
    landlordName: 'Harbor View Properties',
    landlordPayoutToken: 'mock_landlord_harbor',
    addressLine1: '1 Main St',
    postalCode: '97204',
    rentCents: RENT,
    dueDayOfMonth: 1,
    startsOn: start,
  });
  return { session, business, bankLink, application, lease };
}

async function startPlan(start: IsoDate, bankToken = HEALTHY) {
  const b = await declinedBusiness(start, bankToken);
  const plan = await startPassThroughPlan(ctx, {
    userId: b.session.userId,
    applicationId: b.application.id,
    leaseId: b.lease.id,
    asOf: start,
  });
  const first = await h.db.passThroughPeriod.findFirstOrThrow({
    where: { rentPlanId: plan.id },
    orderBy: { dueDate: 'asc' },
  });
  return { ...b, plan, first };
}

const payoutsTo = (token: string) =>
  h.payments.calls.filter(
    (c) =>
      c.kind === 'payout' && (c.input as { destinationToken: string }).destinationToken === token,
  );

describe('pass-through plan', () => {
  it('is offered on a credit decline, and the API starts it with no fee and no pool check', async () => {
    const b = await declinedBusiness(todayIso());
    const api = client(h.app, b.session);
    const offer = await api.get<{ eligible: boolean; feeCents: number; explanation: string }>(
      `/v1/underwriting/applications/${b.application.id}/pass-through`,
    );
    expect(offer.status).toBe(200);
    expect(offer.body).toMatchObject({ eligible: true, feeCents: 0 });
    expect(offer.body.explanation).toContain('no fee');
    // No capital in the pool at all: a pass-through plan does not need any.
    const started = await api.post<{ kind: string; feeBps: number; id: string }>(
      '/v1/pass-through-plans',
      { applicationId: b.application.id, leaseId: b.lease.id },
    );
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ kind: 'PASS_THROUGH', feeBps: 0 });
    const detail = await api.get<{
      kind: string;
      passThrough: { nextPeriod: { amountCents: number; collectOn: string } | null } | null;
    }>(`/v1/rent-plans/${started.body.id}`);
    expect(detail.body.kind).toBe('PASS_THROUGH');
    expect(detail.body.passThrough?.nextPeriod?.amountCents).toBe(RENT);
    // A second plan on the same lease is refused.
    const again = await api.post('/v1/pass-through-plans', {
      applicationId: b.application.id,
      leaseId: b.lease.id,
    });
    expect(again.status).toBe(409);
    // Nothing is committed against the pool or the exposure caps.
    const offerAfter = await api.get<{ existingPlanId: string | null }>(
      `/v1/underwriting/applications/${b.application.id}/pass-through`,
    );
    expect(offerAfter.body.existingPlanId).toBe(started.body.id);
  });

  it('collects before the due date and pays the landlord only once the collection settled', async () => {
    const start = addDays(todayIso(), -70);
    const { plan, first } = await startPlan(start);
    expect(first.amountCents).toBe(RENT);

    // Before the collection window: nothing moves.
    await runThrough(start, addDays(first.collectOn, -1));
    expect(h.payments.calls).toHaveLength(0);

    // Collection day: the rent is debited and held for the landlord.
    await run(first.collectOn);
    let period = await h.db.passThroughPeriod.findUniqueOrThrow({ where: { id: first.id } });
    expect(period.status).toBe('COLLECTING');
    expect(period.collectedOn).toBe(first.collectOn);
    let books = await passThroughBooks();
    expect(books).toMatchObject({ payable: RENT, cash: RENT, held: RENT });
    // The pool is untouched by a pass-through plan.
    expect(await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL)).toBe(0);

    // Up to the day before the due date, the landlord is not paid.
    await runThrough(addDays(first.collectOn, 1), addDays(first.dueDate, -1));
    period = await h.db.passThroughPeriod.findUniqueOrThrow({ where: { id: first.id } });
    expect(period.status).toBe('SETTLED');
    expect(period.settledOn! <= first.dueDate).toBe(true);
    expect(payoutsTo('mock_landlord_harbor')).toHaveLength(0);

    // Due date: paid, from the settled collection.
    await run(first.dueDate);
    period = await h.db.passThroughPeriod.findUniqueOrThrow({ where: { id: first.id } });
    expect(period.status).toBe('PAID');
    expect(period.paidOn).toBe(first.dueDate);
    expect(payoutsTo('mock_landlord_harbor')).toHaveLength(1);
    books = await passThroughBooks();
    expect(books).toMatchObject({ payable: 0, cash: 0, held: 0, alerts: [] });
    expect(await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL)).toBe(0);
    expect(await accountBalance(h.db, ACCOUNTS.FEE_REVENUE)).toBe(0);
    const disbursements = await h.db.landlordDisbursement.findMany();
    expect(disbursements).toMatchObject([
      { kind: 'PASS_THROUGH', sourceId: first.id, status: 'SENT' },
    ]);

    // The month is on time in the payment history.
    const history = await paymentHistorySummary(h.db, plan.businessId, first.dueDate);
    expect(history).toMatchObject({ months: 1, onTimeMonths: 1, currentOnTimeStreak: 1 });
  }, 180_000);

  it('a collection that fails means the landlord is not paid, the owner is told, and the month is missed', async () => {
    const start = addDays(todayIso(), -70);
    const { plan, first, bankLink, session } = await startPlan(start);
    await h.db.bankLink.update({
      where: { id: bankLink.id },
      data: { providerAccountToken: 'mock_acct_ridgeline_fail' },
    });
    await runThrough(start, addDays(first.dueDate, 1));
    const period = await h.db.passThroughPeriod.findUniqueOrThrow({ where: { id: first.id } });
    expect(period.status).toBe('MISSED');
    expect(period.missedReason).toBe('COLLECTION_FAILED');
    expect(period.collectionAttempts).toBe(2);
    expect(payoutsTo('mock_landlord_harbor')).toHaveLength(0);
    expect(await passThroughBooks()).toMatchObject({ payable: 0, cash: 0, held: 0, alerts: [] });
    // No fee, no late fee: nothing was ever posted to revenue.
    expect(await accountBalance(h.db, ACCOUNTS.FEE_REVENUE)).toBe(0);
    const missed = await h.db.auditEvent.findFirst({
      where: { eventType: 'PASS_THROUGH_MISSED', subjectId: plan.id },
    });
    expect(missed?.payload).toMatchObject({ ownerToldToPayDirectly: true });
    const detail = await client(h.app, session).get<{
      passThrough: { periods: Array<{ status: string; message: string; landlordPaid: boolean }> };
    }>(`/v1/rent-plans/${plan.id}`);
    const shown = detail.body.passThrough.periods.find((p) => p.status === 'MISSED')!;
    expect(shown.landlordPaid).toBe(false);
    expect(shown.message).toContain('Please pay Harbor View Properties');
    const history = await paymentHistorySummary(h.db, plan.businessId, first.dueDate);
    expect(history).toMatchObject({ missedMonths: 1, currentOnTimeStreak: 0 });
  }, 180_000);

  it('a collection returned inside the settlement window is reversed and the landlord is not paid', async () => {
    const start = addDays(todayIso(), -70);
    const { first, bankLink } = await startPlan(start);
    await h.db.bankLink.update({
      where: { id: bankLink.id },
      data: { providerAccountToken: 'mock_acct_ridgeline_return_r01' },
    });
    await runThrough(start, addDays(first.dueDate, 1));
    const period = await h.db.passThroughPeriod.findUniqueOrThrow({ where: { id: first.id } });
    expect(period).toMatchObject({
      status: 'MISSED',
      missedReason: 'COLLECTION_RETURNED',
      returnCode: 'R01',
    });
    expect(payoutsTo('mock_landlord_harbor')).toHaveLength(0);
    expect(await passThroughBooks()).toMatchObject({ payable: 0, cash: 0, held: 0, alerts: [] });
  }, 180_000);

  it('a collection returned after the landlord was paid is owed by the business and alerted', async () => {
    const start = addDays(todayIso(), -80);
    const { plan, first, bankLink, business } = await startPlan(start);
    await fundPool(h.app, 5_000_000);
    await h.db.bankLink.update({
      where: { id: bankLink.id },
      data: { providerAccountToken: 'mock_acct_ridgeline_late_return_r10_once' },
    });
    // Unauthorized returns arrive three weeks later: well after the landlord was paid.
    await runThrough(start, addDays(first.collectedOn ?? first.collectOn, 25));
    const period = await h.db.passThroughPeriod.findUniqueOrThrow({ where: { id: first.id } });
    expect(period.status).toBe('RETURNED_AFTER_PAYOUT');
    expect(period.returnCode).toBe('R10');
    expect(payoutsTo('mock_landlord_harbor')).toHaveLength(1);
    // CashFlow's own money covered the rent; the business owes it.
    expect(await accountBalance(h.db, receivableCode(business.id))).toBe(RENT);
    expect(await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL)).toBe(5_000_000 - RENT);
    // The amount owed is an installment on a receivable row, serviced like a financed one.
    const receivable = await h.db.landlordPayout.findUniqueOrThrow({
      where: { passThroughPeriodId: first.id },
      include: { installments: true },
    });
    expect(receivable).toMatchObject({ rentPlanId: plan.id, status: 'PAID', amountCents: RENT });
    expect(receivable.installments).toEqual([
      expect.objectContaining({ principalCents: RENT, feeCents: 0, dueDate: period.returnedOn }),
    ]);
    // An unauthorized return freezes the plan for a reviewer and stops automatic debits.
    const frozen = await h.db.rentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(frozen).toMatchObject({ status: 'ACTIVE', advanceFrozenReason: 'UNAUTHORIZED_RETURN' });
    // The books agree with themselves: the receivable is expected, the payable is clear.
    expect(await passThroughBooks()).toMatchObject({ payable: 0, cash: 0, held: 0, alerts: [] });
    const alert = await h.db.alert.findFirst({
      where: { type: 'payments.pass_through_returned_after_payout' },
    });
    expect(alert?.severity).toBe('HIGH');
    expect((await trialBalance(h.db)).balanced).toBe(true);
  }, 180_000);
});

describe('pass-through receivable after a return', () => {
  /** The month a collection came back after the landlord was paid, and its receivable. */
  async function receivableOf(periodId: string) {
    return h.db.landlordPayout.findUniqueOrThrow({
      where: { passThroughPeriodId: periodId },
      include: { installments: { include: { repayments: true } } },
    });
  }

  it('is collected under the servicing policy, and the plan carries on once it is paid', async () => {
    const start = addDays(todayIso(), -80);
    const { plan, first, bankLink, business } = await startPlan(start);
    await fundPool(h.app, 5_000_000);
    // Insufficient funds, reported three weeks late: a retryable code, so the bank link stays.
    await h.db.bankLink.update({
      where: { id: bankLink.id },
      data: { providerAccountToken: 'mock_acct_ridgeline_late_return_r01_once' },
    });
    const returnDay = addDays(first.collectOn, 21);
    await runThrough(start, addDays(returnDay, 1));

    const period = await h.db.passThroughPeriod.findUniqueOrThrow({ where: { id: first.id } });
    expect(period).toMatchObject({ status: 'RETURNED_AFTER_PAYOUT', returnCode: 'R01' });
    // The collection job debited the amount owed on the day the return arrived, as the first
    // attempt under the servicing policy, and it went through.
    const receivable = await receivableOf(first.id);
    const [owed] = receivable.installments;
    expect(owed).toMatchObject({ status: 'PAID', attemptCount: 1, feeCents: 0 });
    expect(owed!.repayments.map((r) => r.status)).toEqual(['SUCCEEDED']);
    expect(await accountBalance(h.db, receivableCode(business.id))).toBe(0);
    // The pool covered the return and the collection paid it back: nothing lost.
    expect(await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL)).toBe(5_000_000);
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: plan.id } })).advanceFrozenAt,
    ).toBeNull();

    // With nothing owed, the next month is collected and paid to the landlord as usual.
    const next = await h.db.passThroughPeriod.findFirstOrThrow({
      where: { rentPlanId: plan.id, dueDate: { gt: first.dueDate } },
      orderBy: { dueDate: 'asc' },
    });
    await runThrough(addDays(returnDay, 2), addDays(next.dueDate, 1));
    expect(
      (await h.db.passThroughPeriod.findUniqueOrThrow({ where: { id: next.id } })).status,
    ).toBe('PAID');
    expect(payoutsTo('mock_landlord_harbor')).toHaveLength(2);
    expect(await passThroughBooks()).toMatchObject({ payable: 0, cash: 0, held: 0, alerts: [] });
  }, 300_000);

  it('holds every later month while owed, and is charged off at 90 days like a financed plan', async () => {
    const start = addDays(todayIso(), -80);
    const { plan, first, bankLink, business } = await startPlan(start);
    await fundPool(h.app, 5_000_000);
    // Unauthorized, three weeks late: the bank link is disabled, so nothing more can be
    // debited automatically, and the plan is frozen for a reviewer.
    await h.db.bankLink.update({
      where: { id: bankLink.id },
      data: { providerAccountToken: 'mock_acct_ridgeline_late_return_r10_once' },
    });
    const returnDay = addDays(first.collectOn, 21);
    // Every day through the return and the first weeks after it. `run` checks that the trial
    // balance balances and that a second run of the day changes nothing.
    await runThrough(start, addDays(returnDay, 10));
    const period = await h.db.passThroughPeriod.findUniqueOrThrow({ where: { id: first.id } });
    expect(period).toMatchObject({ status: 'RETURNED_AFTER_PAYOUT', returnCode: 'R10' });
    const returnedOn = period.returnedOn as IsoDate;
    expect(await h.db.bankLink.findUniqueOrThrow({ where: { id: bankLink.id } })).toMatchObject({
      status: 'ERROR',
    });
    // Not debited: there is no linked account to present it to. Waiting is not an attempt.
    let [owed] = (await receivableOf(first.id)).installments;
    expect(owed).toMatchObject({
      status: 'LATE',
      attemptCount: 0,
      collectionSkipReason: 'NO_BANK_LINK',
    });
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: plan.id } })).delinquencyStatus,
    ).toBe('DELINQUENT');

    // Then weekly until just before the charge-off age, and daily across it.
    for (let d = addDays(returnDay, 17); d < addDays(returnedOn, 88); d = addDays(d, 7)) {
      await run(d);
    }
    await runThrough(addDays(returnedOn, 88), addDays(returnedOn, 89));
    const beforeChargeOff = await h.db.rentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(beforeChargeOff).toMatchObject({ status: 'ACTIVE', delinquencyStatus: 'DEFAULT' });
    // The provision job reserved for it on the first of the month, at the DEFAULT rate.
    expect(-(await accountBalance(h.db, ACCOUNTS.ALLOWANCE))).toBe(RENT);
    // While it was owed, no later month was collected or paid: one payout to the landlord.
    const later = await h.db.passThroughPeriod.findMany({
      where: { rentPlanId: plan.id, dueDate: { gt: first.dueDate } },
    });
    expect(later.length).toBeGreaterThan(0);
    for (const p of later) expect(p.status).toBe('CANCELLED');
    expect(payoutsTo('mock_landlord_harbor')).toHaveLength(1);

    // Day 90: written off against the allowance, the plan closed, the business suspended.
    await runThrough(addDays(returnedOn, 90), addDays(returnedOn, 91));
    [owed] = (await receivableOf(first.id)).installments;
    expect(owed).toMatchObject({ status: 'CHARGED_OFF' });
    expect(owed!.chargedOffAt).not.toBeNull();
    expect(await h.db.rentPlan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({
      status: 'CLOSED',
      delinquencyStatus: 'CHARGED_OFF',
      closedReason: 'CHARGED_OFF',
    });
    expect((await h.db.business.findUniqueOrThrow({ where: { id: business.id } })).status).toBe(
      'SUSPENDED',
    );
    expect(await accountBalance(h.db, receivableCode(business.id))).toBe(0);
    expect(await accountBalance(h.db, ACCOUNTS.ALLOWANCE)).toBe(0);
    // The same posting as a financed charge-off: DR allowance, CR the business's receivable.
    const chargeOff = await h.db.ledgerTransaction.findFirstOrThrow({
      where: { referenceType: 'charge_off', referenceId: plan.id },
      include: { entries: { include: { account: true } } },
    });
    expect(
      chargeOff.entries.map((e) => [e.account.code, e.direction, e.amountCents]).sort(),
    ).toEqual(
      [
        [ACCOUNTS.ALLOWANCE, 'DEBIT', RENT],
        [receivableCode(business.id), 'CREDIT', RENT],
      ].sort(),
    );
    // The loss is the pool's: it covered the rent and nothing came back.
    expect(await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL)).toBe(5_000_000 - RENT);
    expect(
      await h.db.installment.count({
        where: { rentPlanId: plan.id, status: { in: UNPAID } },
      }),
    ).toBe(0);
    expect(await passThroughBooks()).toMatchObject({ payable: 0, cash: 0, held: 0, alerts: [] });
    expect((await trialBalance(h.db)).balanced).toBe(true);
  }, 600_000);
});

describe('graduation', () => {
  it('offers a financed plan after three on time months, and it takes over from the next month once accepted', async () => {
    await fundPool(h.app, 25_000_000);
    // About 140 days back, on the 10th: the first rent date (the 1st) is then inside the
    // 30 day horizon and its collection window is still open, whatever today's date is.
    const back = addDays(todayIso(), -140);
    const start = `${back.slice(0, 7)}-10` as IsoDate;
    const { plan, session } = await startPlan(start);

    // Play until the refresh-eligibility job makes an offer.
    let offer = null;
    for (let d = start; d <= todayIso() && !offer; d = addDays(d, 1)) {
      await run(d);
      offer = await h.db.graduationOffer.findFirst({ where: { passThroughPlanId: plan.id } });
    }
    expect(offer, 'no graduation offer was made').not.toBeNull();
    const offeredOn = offer!.offeredOn;
    expect(offer).toMatchObject({ status: 'OFFERED', onTimeMonths: 3 });
    const paid = await h.db.passThroughPeriod.count({
      where: { rentPlanId: plan.id, status: 'PAID' },
    });
    expect(paid).toBe(3);
    // The review is stored beside the decline, never as the current decision.
    const review = await h.db.underwritingDecision.findUniqueOrThrow({
      where: { id: offer!.decisionId },
    });
    expect(review).toMatchObject({ kind: 'ELIGIBILITY_REVIEW', outcome: 'APPROVED' });
    expect(
      (review.snapshot as { paymentHistory: { factor: { points: number } } }).paymentHistory.factor
        .points,
    ).toBeGreaterThan(0);
    const application = await h.db.underwritingApplication.findUniqueOrThrow({
      where: { id: plan.applicationId },
    });
    expect(application.status).toBe('DECLINED');
    // Owners see it through the API.
    const history = await client(h.app, session).get<{
      graduationOffer: { id: string; status: string; feeCentsPerMonth: number } | null;
    }>(`/v1/businesses/${plan.businessId}/payment-history`);
    expect(history.body.graduationOffer).toMatchObject({ id: offer!.id, status: 'OFFERED' });
    expect(history.body.graduationOffer!.feeCentsPerMonth).toBeGreaterThan(0);

    // Accepted the same day. The next month has not started collecting, so it switches now.
    const accepted = await acceptGraduationOffer(ctx, {
      offerId: offer!.id,
      userId: session.userId,
      asOf: offeredOn,
    });
    expect(accepted.completed).toBe(true);
    expect(accepted.offer.status).toBe('COMPLETED');
    const closed = await h.db.rentPlan.findUniqueOrThrow({ where: { id: plan.id } });
    expect(closed).toMatchObject({ status: 'CLOSED', closedReason: 'GRADUATED' });
    const financed = await h.db.rentPlan.findUniqueOrThrow({
      where: { id: accepted.offer.financedPlanId! },
      include: { payouts: true },
    });
    expect(financed.kind).toBe('FINANCED');
    expect(financed.feeBps).toBe(offer!.feeBps);
    expect(financed.payouts[0]!.periodMonth).toBe(accepted.offer.effectivePeriod);
    // Never two plans for one month: the pass-through month for that period was cancelled.
    const cancelled = await h.db.passThroughPeriod.findMany({
      where: { rentPlanId: plan.id, status: 'CANCELLED' },
    });
    expect(cancelled.map((p) => p.periodMonth)).toContain(accepted.offer.effectivePeriod);
    const current = await h.db.underwritingDecision.findFirstOrThrow({
      where: { applicationId: plan.applicationId, supersededAt: null, kind: 'GRADUATION' },
    });
    expect(current.outcome).toBe('APPROVED');
    for (const type of ['GRADUATION_OFFERED', 'GRADUATION_ACCEPTED', 'GRADUATION_COMPLETED']) {
      expect(
        await h.db.auditEvent.count({ where: { eventType: type, subjectId: plan.id } }),
        type,
      ).toBe(1);
    }

    // The financed plan pays the landlord on the first rent date of the effective month.
    const due = financed.payouts[0]!.scheduledFor;
    await runThrough(offeredOn, due);
    const payout = await h.db.landlordPayout.findFirstOrThrow({
      where: { rentPlanId: financed.id },
    });
    expect(payout.status).toBe('PAID');
    // One landlord payment per month across both plans.
    const months = await h.db.landlordDisbursement.groupBy({
      by: ['periodMonth'],
      _count: { _all: true },
    });
    expect(months.every((m) => m._count._all === 1)).toBe(true);
    expect((await trialBalance(h.db)).balanced).toBe(true);
  }, 600_000);

  it('makes no offer before three on time months, and accepting needs an open offer', async () => {
    const start = addDays(todayIso(), -40);
    const { plan, session } = await startPlan(start);
    await runThrough(start, addDays(start, 39));
    expect(await h.db.graduationOffer.count()).toBe(0);
    expect(
      await h.db.underwritingDecision.count({
        where: { applicationId: plan.applicationId, kind: 'ELIGIBILITY_REVIEW' },
      }),
    ).toBe(0);
    const res = await client(h.app, session).post('/v1/graduation-offers/nope/accept', {});
    expect(res.status).toBe(404);
  }, 300_000);
});

describe('admin reads', () => {
  it('shows plan kind, pass-through months and payment history to operators', async () => {
    const start = addDays(todayIso(), -40);
    const { plan, business } = await startPlan(start);
    await runThrough(start, addDays(start, 39));
    const admin = adminClient(h.app);
    const plans = await admin.get<Array<{ kind: string; passThroughPeriods: unknown[] }>>(
      `/v1/admin/businesses/${business.id}/rent-plans`,
    );
    expect(plans.status).toBe(200);
    expect(plans.body[0]).toMatchObject({ kind: 'PASS_THROUGH' });
    expect(plans.body[0]!.passThroughPeriods.length).toBeGreaterThan(0);
    const detail = await admin.get<{ paymentHistory: { summary: { months: number } } }>(
      `/v1/admin/businesses/${business.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.paymentHistory.summary.months).toBeGreaterThanOrEqual(1);
    expect(plan.kind).toBe('PASS_THROUGH');
  }, 300_000);
});

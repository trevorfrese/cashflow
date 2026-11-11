import { addDays, daysBetween, followingDueDate, type IsoDate } from '@cashflow/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '../context.ts';
import { todayIso } from '../dates.ts';
import { JOBS, runAllJobs, type JobName } from '../jobs/index.ts';
import { ACCOUNTS, receivableCode } from '../ledger/accounts.ts';
import {
  accountBalance,
  allowanceBalance,
  receivablesBalance,
  trialBalance,
} from '../ledger/service.ts';
import {
  ACTIVE_SERVICING_POLICY,
  delinquencyBucket,
  reserveCents,
  type OpenBucket,
} from '../servicing/policy.ts';
import {
  approvedBusiness,
  client,
  createTestApp,
  demoLease,
  fundPool,
  registerUser,
  resetDb,
  type TestHarness,
  adminClient,
} from '../test/helpers.ts';
import { collectInstallment } from './collections.ts';
import { countOnTimePeriods } from './portfolio-state.ts';
import { createRentPlan } from './rent-plan.ts';

/**
 * Servicing across simulated dates: the jobs are run as of one date after another against a
 * real Postgres. Every step runs the whole job set twice and checks that the second run
 * changed nothing, and that the trial balance balances and operating cash is zero.
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
afterEach(() => {
  vi.restoreAllMocks();
});

const POOL = 25_000_000;
const RENT = 620_000;
const policy = ACTIVE_SERVICING_POLICY;
const WINDOW = policy.payoutReleaseWindowDays ?? 0;

/** First of the month `n` months before today. */
function monthStart(n: number): IsoDate {
  const [y, m] = todayIso().split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

/** Everything a second run of the same day must leave untouched. */
async function fingerprint() {
  const [tb, transactions, repayments, audits, plans, payouts, installments, links, businesses] =
    await Promise.all([
      trialBalance(h.db),
      h.db.ledgerTransaction.count(),
      h.db.repayment.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
      h.db.auditEvent.count(),
      h.db.rentPlan.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, status: true, delinquencyStatus: true, advanceFrozenReason: true },
      }),
      h.db.landlordPayout.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, status: true, heldReason: true, returnCode: true },
      }),
      h.db.installment.findMany({
        orderBy: { id: 'asc' },
        select: {
          id: true,
          status: true,
          dueDate: true,
          attemptCount: true,
          lastAttemptOn: true,
          collectionSkipReason: true,
          collectionSkippedOn: true,
        },
      }),
      h.db.bankLink.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
      h.db.business.findMany({ orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    ]);
  return {
    balances: tb.accounts.map((a) => [a.account.code, a.balanceCents]),
    balanced: tb.balanced,
    transactions,
    repayments,
    audits,
    plans,
    payouts,
    installments,
    links,
    businesses,
  };
}

/**
 * Run every job as of `asOf`, then again. The second run must change nothing. The books must
 * balance and operating cash must be zero after the sweep.
 */
async function run(asOf: IsoDate) {
  const result = await runAllJobs(ctx, asOf);
  for (const [name, job] of Object.entries(result)) {
    if (name !== 'asOf') expect((job as { ok: boolean }).ok, `${name} on ${asOf}`).toBe(true);
  }
  const first = await fingerprint();
  expect(first.balanced).toBe(true);
  expect(await accountBalance(h.db, ACCOUNTS.CASH)).toBe(0);
  await runAllJobs(ctx, asOf);
  expect(await fingerprint(), `second run on ${asOf} changed something`).toEqual(first);
  return result;
}

async function books(businessId: string) {
  const tb = await trialBalance(h.db);
  expect(tb.balanced).toBe(true);
  const [pool, cash, receivable, receivables, allowance, fees, provision, recoveries] =
    await Promise.all([
      accountBalance(h.db, ACCOUNTS.CAPITAL_POOL),
      accountBalance(h.db, ACCOUNTS.CASH),
      accountBalance(h.db, receivableCode(businessId)),
      receivablesBalance(h.db),
      allowanceBalance(h.db),
      accountBalance(h.db, ACCOUNTS.FEE_REVENUE),
      accountBalance(h.db, ACCOUNTS.PROVISION_EXPENSE),
      accountBalance(h.db, ACCOUNTS.RECOVERY_INCOME),
    ]);
  return {
    pool,
    cash,
    receivable,
    receivables,
    allowance,
    netReceivable: receivables - allowance,
    fees,
    provision,
    recoveries,
  };
}

interface Running {
  api: ReturnType<typeof client>;
  businessId: string;
  bankLinkId: string;
  planId: string;
  /** Rent dates of the first three periods. */
  d1: IsoDate;
  d2: IsoDate;
  d3: IsoDate;
}

/** An approved business with a plan whose first rent date was five months ago. */
async function runningPlan(leaseOverrides: Record<string, unknown> = {}): Promise<Running> {
  await fundPool(h.app, POOL);
  const session = await registerUser(h.app);
  const api = client(h.app, session);
  const { businessId, bankLinkId, applicationId } = await approvedBusiness(h.app, session);
  const d1 = monthStart(5);
  const lease = await api.post<{ id: string }>(
    '/v1/leases',
    demoLease(businessId, { startsOn: addDays(d1, -10), ...leaseOverrides }),
  );
  expect(lease.status).toBe(201);
  const plan = await createRentPlan(ctx, {
    userId: session.userId,
    leaseId: lease.body.id,
    applicationId,
    installmentsPerMonth: 2,
    asOf: addDays(d1, -10),
  });
  const d2 = followingDueDate(d1, 1);
  return { api, businessId, bankLinkId, planId: plan.id, d1, d2, d3: followingDueDate(d2, 1) };
}

/** Point the business's bank account at a mock payments behavior. */
const setAccountToken = (bankLinkId: string, token: string) =>
  h.db.bankLink.update({ where: { id: bankLinkId }, data: { providerAccountToken: token } });

const installmentsOf = (planId: string, periodMonth: string) =>
  h.db.installment.findMany({
    where: { rentPlanId: planId, periodMonth },
    orderBy: { sequence: 'asc' },
    include: { repayments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });

const planRow = (planId: string) => h.db.rentPlan.findUniqueOrThrow({ where: { id: planId } });

const payoutOf = (planId: string, scheduledForMonth: string) =>
  h.db.landlordPayout.findFirstOrThrow({
    where: { rentPlanId: planId, periodMonth: scheduledForMonth },
  });

async function audit(planId: string) {
  const res = await adminClient(h.app).get<
    Array<{ eventType: string; at: string; payload: Record<string, unknown> }>
  >(`/v1/admin/audit-events?subjectType=rent_plan&subjectId=${planId}`);
  expect(res.status).toBe(200);
  return res.body;
}
const auditTypes = async (planId: string) => (await audit(planId)).map((e) => e.eventType);
const bucketChanges = async (planId: string) =>
  (await audit(planId))
    .filter((e) => e.eventType === 'DELINQUENCY_CHANGED')
    .map((e) => `${String(e.payload.from)}>${String(e.payload.to)}`);

interface PlanDetail {
  status: string;
  delinquencyStatus: string;
  daysPastDue: number;
  pastDueCents: number;
  needsPayment: boolean;
  advanceFrozen: boolean;
  closedReason: string | null;
  heldPayout: { id: string; status: string; heldReason: string; releaseBy: string } | null;
  upcomingInstallments: Array<{ id: string; status: string; attempts: number }>;
  payouts: Array<{ status: string; heldReason: string | null; returnCode: string | null }>;
}

describe('collections follow the servicing policy', () => {
  it('a failed debit that cures inside grace never goes late and holds nothing', async () => {
    const p = await runningPlan();
    await setAccountToken(p.bankLinkId, 'mock_acct_fail');

    await run(p.d1);
    let [first] = await installmentsOf(p.planId, p.d1.slice(0, 7));
    expect(first).toMatchObject({ status: 'FAILED', attemptCount: 1, lastAttemptOn: p.d1 });
    // A failed attempt is dated on the day it was made, like a successful one.
    expect(
      first!.repayments.map((r) => [r.status, r.createdAt.toISOString().slice(0, 10)]),
    ).toEqual([['FAILED', p.d1]]);
    expect((await planRow(p.planId)).delinquencyStatus).toBe('CURRENT');
    expect(await books(p.businessId)).toMatchObject({
      receivable: RENT,
      pool: POOL - RENT,
      fees: 0,
    });

    // The day after: one day past due is the grace bucket. No debit: the retry is on day 3.
    const dayOne = await run(addDays(p.d1, 1));
    expect(dayOne.collectInstallments.summary).toMatchObject({ paid: 0, failed: 0, skipped: 1 });
    expect((await planRow(p.planId)).delinquencyStatus).toBe('GRACE');

    // The business sorts its account out. The retry on day 3 clears.
    await setAccountToken(p.bankLinkId, 'mock_acct_ok');
    const dayThree = await run(addDays(p.d1, 3));
    expect(dayThree.collectInstallments.summary).toMatchObject({ paid: 1 });
    [first] = await installmentsOf(p.planId, p.d1.slice(0, 7));
    expect(first).toMatchObject({ status: 'PAID', attemptCount: 2 });
    expect(first!.repayments.map((r) => r.status)).toEqual(['FAILED', 'SUCCEEDED']);
    // Cured in the same transaction as the payment, not on the next aging run.
    expect((await planRow(p.planId)).delinquencyStatus).toBe('CURRENT');
    expect(await bucketChanges(p.planId)).toEqual(['CURRENT>GRACE', 'GRACE>CURRENT']);
    expect(await books(p.businessId)).toMatchObject({
      receivable: RENT - first!.principalCents,
      fees: first!.feeCents,
      pool: POOL - RENT + first!.totalCents,
    });

    // Paid on day 3 of 3: inside grace, so the period can still count as on time.
    await run(addDays(p.d1, 14));
    expect(await countOnTimePeriods(h.db, p.businessId)).toBe(1);
    // And next month's payout goes out.
    const next = await run(p.d2);
    expect(next.processPayouts.summary).toMatchObject({ paid: 1, held: 0 });
  });

  it('stops after three attempts and then takes a manual payment', async () => {
    const p = await runningPlan();
    await setAccountToken(p.bankLinkId, 'mock_acct_fail');
    const period = p.d1.slice(0, 7);

    // Attempts on days 0, 3, and 6. Nothing on the days between, and nothing after.
    for (let day = 0; day <= 12; day++) await run(addDays(p.d1, day));
    let [first] = await installmentsOf(p.planId, period);
    expect(first!.repayments.map((r) => r.createdAt.toISOString().slice(0, 10))).toEqual([
      p.d1,
      addDays(p.d1, 3),
      addDays(p.d1, 6),
    ]);
    expect(first).toMatchObject({ status: 'LATE', attemptCount: 3 });
    expect((await planRow(p.planId)).delinquencyStatus).toBe('DELINQUENT');
    expect(
      (await auditTypes(p.planId)).filter((t) => t === 'COLLECTION_ATTEMPTS_EXHAUSTED'),
    ).toEqual(['COLLECTION_ATTEMPTS_EXHAUSTED']);
    // Marked late by the aging job on day 4, a day with no debit.
    const lateOn = (await audit(p.planId)).find(
      (e) => e.eventType === 'DELINQUENCY_CHANGED' && e.payload.to === 'DELINQUENT',
    );
    expect(lateOn?.at.slice(0, 10)).toBe(addDays(p.d1, 4));

    const detail = await p.api.get<PlanDetail>(`/v1/rent-plans/${p.planId}`);
    expect(detail.body).toMatchObject({
      delinquencyStatus: 'DEFAULT', // as of today, months later
      needsPayment: true,
      pastDueCents: first!.totalCents + (await installmentsOf(p.planId, period))[1]!.totalCents,
    });
    expect(detail.body.daysPastDue).toBe(daysBetween(p.d1, todayIso()));
    expect(detail.body.upcomingInstallments[0]).toMatchObject({ status: 'LATE', attempts: 3 });

    // The owner pays by hand. While the account still fails, so does the payment.
    const refused = await p.api.post<{ error: { code: string; message: string } }>(
      '/v1/repayments',
      { installmentId: first!.id },
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('PAYMENT_FAILED');
    await setAccountToken(p.bankLinkId, 'mock_acct_ok');
    const paid = await p.api.post<{ status: string }>('/v1/repayments', {
      installmentId: first!.id,
    });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');
    [first] = await installmentsOf(p.planId, period);
    expect(first!.repayments.map((r) => [r.status, r.manual])).toEqual([
      ['FAILED', false],
      ['FAILED', false],
      ['FAILED', false],
      ['FAILED', true],
      ['SUCCEEDED', true],
    ]);
    expect(await books(p.businessId)).toMatchObject({
      receivable: RENT - first!.principalCents,
      fees: first!.feeCents,
    });
    // Paid, but weeks late: not an on time period.
    expect(await countOnTimePeriods(h.db, p.businessId)).toBe(0);
  });

  it('puts a debit off when the balance cannot cover it, without using an attempt', async () => {
    const p = await runningPlan();
    // The month's periodic review reads the same balance, so it runs before the balance drops.
    await JOBS.reunderwrite(ctx, p.d1);
    const balance = vi.spyOn(h.providers.bankLink, 'refreshBalance').mockResolvedValue(10_000);

    const due = await run(p.d1);
    expect(due.collectInstallments.summary).toMatchObject({ paid: 0, failed: 0, deferred: 1 });
    let [first] = await installmentsOf(p.planId, p.d1.slice(0, 7));
    expect(first).toMatchObject({
      status: 'SCHEDULED',
      attemptCount: 0,
      lastAttemptOn: null,
      collectionSkipReason: 'INSUFFICIENT_BALANCE',
      collectionSkippedOn: p.d1,
    });
    expect(first!.repayments).toEqual([]);
    expect(h.payments.calls.filter((c) => c.kind === 'charge')).toEqual([]);

    // Checked again the next day, and the day after: still short, still no attempt used.
    await run(addDays(p.d1, 1));
    await run(addDays(p.d1, 2));
    [first] = await installmentsOf(p.planId, p.d1.slice(0, 7));
    expect(first).toMatchObject({ attemptCount: 0, collectionSkippedOn: addDays(p.d1, 2) });
    // Recorded once, not once a day.
    expect((await auditTypes(p.planId)).filter((t) => t === 'COLLECTION_SKIPPED')).toHaveLength(1);
    expect((await planRow(p.planId)).delinquencyStatus).toBe('GRACE');

    // Money arrives. The debit goes out on the next run and clears first time.
    balance.mockResolvedValue(5_000_000);
    const cured = await run(addDays(p.d1, 3));
    expect(cured.collectInstallments.summary).toMatchObject({ paid: 1 });
    [first] = await installmentsOf(p.planId, p.d1.slice(0, 7));
    expect(first).toMatchObject({
      status: 'PAID',
      attemptCount: 1,
      collectionSkipReason: null,
      collectionSkippedOn: null,
    });
    // An unreadable balance never blocks a debit.
    balance.mockRejectedValue(new Error('bank is down'));
    const second = await run(addDays(p.d1, 14));
    expect(second.collectInstallments.summary).toMatchObject({ paid: 1 });
  });
});

describe('stop-advance', () => {
  /** A plan whose first period is unpaid when the second rent date arrives. */
  async function pastDueAtSecondRentDate() {
    const p = await runningPlan();
    await setAccountToken(p.bankLinkId, 'mock_acct_fail');
    for (const day of [0, 3, 6, 14, 17, 20]) await run(addDays(p.d1, day));
    const held = await run(p.d2);
    expect(held.processPayouts.summary).toMatchObject({ paid: 0, held: 1 });
    return p;
  }

  it('holds the next payout while past due, and releases it when the business cures', async () => {
    const p = await pastDueAtSecondRentDate();
    const second = await payoutOf(p.planId, p.d2.slice(0, 7));
    expect(second).toMatchObject({ status: 'HELD', heldReason: 'PAST_DUE' });
    // Nothing moved: the pool and the receivable still show one month of rent.
    expect(await books(p.businessId)).toMatchObject({ receivable: RENT, pool: POOL - RENT });
    // The owner is told, with the reason and the date by which to cure.
    const detail = await p.api.get<PlanDetail>(`/v1/rent-plans/${p.planId}`);
    expect(detail.body.heldPayout).toMatchObject({
      id: second.id,
      status: 'HELD',
      heldReason: 'PAST_DUE',
      releaseBy: addDays(p.d2, WINDOW),
    });
    const heldEvent = (await audit(p.planId)).find((e) => e.eventType === 'PAYOUT_HELD');
    expect(heldEvent?.payload).toMatchObject({ reason: 'PAST_DUE', payoutId: second.id });

    // Still held the next day, with no second event.
    await run(addDays(p.d2, 1));
    expect((await auditTypes(p.planId)).filter((t) => t === 'PAYOUT_HELD')).toHaveLength(1);

    // The business pays both overdue installments on day 2.
    await setAccountToken(p.bankLinkId, 'mock_acct_ok');
    const cureDate = addDays(p.d2, 2);
    for (const i of await installmentsOf(p.planId, p.d1.slice(0, 7))) {
      expect(await collectInstallment(ctx, i.id, cureDate, { manual: true })).toBe('paid');
    }
    expect((await planRow(p.planId)).delinquencyStatus).toBe('CURRENT');

    // The next run releases the payout and pays the landlord, three days late.
    const releaseDate = addDays(p.d2, 3);
    const released = await run(releaseDate);
    expect(released.processPayouts.summary).toMatchObject({ paid: 1, held: 0 });
    const paid = await payoutOf(p.planId, p.d2.slice(0, 7));
    expect(paid).toMatchObject({ status: 'PAID', heldReason: null });
    expect(paid.paidAt?.toISOString().slice(0, 10)).toBe(releaseDate);
    expect((await auditTypes(p.planId)).filter((t) => t === 'PAYOUT_RELEASED')).toHaveLength(1);
    // Its installments moved out by the same three days, and the first was collected.
    const moved = await installmentsOf(p.planId, p.d2.slice(0, 7));
    expect(moved.map((i) => [i.dueDate, i.status])).toEqual([
      [releaseDate, 'PAID'],
      [addDays(p.d2, 14 + 3), 'SCHEDULED'],
    ]);
    const b = await books(p.businessId);
    expect(b.receivable).toBe(RENT - moved[0]!.principalCents);
    expect(b.pool + b.receivable).toBe(POOL + b.fees);
  });

  it('cancels a payout that is still held after the release window, and voids its installments', async () => {
    const p = await pastDueAtSecondRentDate();
    const window = WINDOW;
    // The last day of the window: still held.
    await run(addDays(p.d2, window));
    expect((await payoutOf(p.planId, p.d2.slice(0, 7))).status).toBe('HELD');

    const before = await books(p.businessId);
    const cancelled = await run(addDays(p.d2, window + 1));
    expect(cancelled.processPayouts.summary).toMatchObject({ paid: 0, cancelled: 1 });
    const second = await payoutOf(p.planId, p.d2.slice(0, 7));
    expect(second).toMatchObject({ status: 'CANCELLED', heldReason: 'PAST_DUE', paidAt: null });
    expect(second.cancelledAt?.toISOString().slice(0, 10)).toBe(addDays(p.d2, window + 1));
    const voided = await installmentsOf(p.planId, p.d2.slice(0, 7));
    expect(voided.map((i) => i.status)).toEqual(['VOIDED', 'VOIDED']);
    // No money moved for a payout that was never made.
    expect(await books(p.businessId)).toEqual(before);
    expect((await auditTypes(p.planId)).filter((t) => t === 'PAYOUT_CANCELLED')).toHaveLength(1);

    // A voided installment is not owed, even after the business cures.
    await setAccountToken(p.bankLinkId, 'mock_acct_ok');
    const refused = await p.api.post<{ error: { code: string } }>('/v1/repayments', {
      installmentId: voided[0]!.id,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('NOT_OWED');
    // The cancelled month is never paid late, however long the jobs keep running.
    await run(addDays(p.d2, 20));
    expect((await payoutOf(p.planId, p.d2.slice(0, 7))).status).toBe('CANCELLED');
    expect(h.payments.calls.filter((c) => c.kind === 'payout')).toHaveLength(1);
  });

  it('a paused plan still collects rent already fronted, and gets no new payout', async () => {
    const p = await runningPlan();
    const first = await run(p.d1);
    expect(first.processPayouts.summary).toMatchObject({ paid: 1 });
    expect(first.collectInstallments.summary).toMatchObject({ paid: 1 });

    const paused = await p.api.patch<{ status: string }>(`/v1/rent-plans/${p.planId}`, {
      status: 'PAUSED',
    });
    expect(paused.body.status).toBe('PAUSED');

    // The second installment of the period already paid out is collected on its due date.
    const mid = await run(addDays(p.d1, 14));
    expect(mid.collectInstallments.summary).toMatchObject({ paid: 1 });
    expect((await installmentsOf(p.planId, p.d1.slice(0, 7))).map((i) => i.status)).toEqual([
      'PAID',
      'PAID',
    ]);
    expect((await books(p.businessId)).receivable).toBe(0);

    // The next rent date: the payout is held because of the pause, and nothing is generated.
    const next = await run(p.d2);
    expect(next.processPayouts.summary).toMatchObject({ paid: 0, held: 1 });
    expect(next.generatePeriods.summary).toMatchObject({ plans: 0, periodsCreated: 0 });
    expect(await payoutOf(p.planId, p.d2.slice(0, 7))).toMatchObject({
      status: 'HELD',
      heldReason: 'PLAN_PAUSED',
    });

    // Resumed inside the window: the landlord is paid, a day late.
    await p.api.patch(`/v1/rent-plans/${p.planId}`, { status: 'ACTIVE' });
    const resumed = await run(addDays(p.d2, 1));
    expect(resumed.processPayouts.summary).toMatchObject({ paid: 1 });
    expect((await payoutOf(p.planId, p.d2.slice(0, 7))).status).toBe('PAID');
  });

  it('a pause that outlasts the window cancels the month and does not make it up later', async () => {
    const p = await runningPlan();
    await run(p.d1);
    await run(addDays(p.d1, 14));
    await p.api.patch(`/v1/rent-plans/${p.planId}`, { status: 'PAUSED' });
    await run(p.d2);
    await run(addDays(p.d2, WINDOW + 1));
    expect(await payoutOf(p.planId, p.d2.slice(0, 7))).toMatchObject({
      status: 'CANCELLED',
      heldReason: 'PLAN_PAUSED',
    });
    // Resumed two months on. Scheduling restarts from the next rent date, not the missed ones.
    await p.api.patch(`/v1/rent-plans/${p.planId}`, { status: 'ACTIVE' });
    const d4 = followingDueDate(p.d3, 1);
    await run(addDays(p.d3, 20));
    const payouts = await h.db.landlordPayout.findMany({
      where: { rentPlanId: p.planId },
      orderBy: { scheduledFor: 'asc' },
    });
    expect(payouts.map((x) => [x.scheduledFor, x.status])).toEqual([
      [p.d1, 'PAID'],
      [p.d2, 'CANCELLED'],
      [d4, 'SCHEDULED'],
    ]);
  });
});

describe('payment returns', () => {
  it('reverses a payment that settled and was then returned, and reopens the installment', async () => {
    const p = await runningPlan();
    // Accepted on the day, returned two days later for insufficient funds. Once.
    await setAccountToken(p.bankLinkId, 'mock_acct_return_r01_once');
    const period = p.d1.slice(0, 7);

    await run(p.d1);
    let [first] = await installmentsOf(p.planId, period);
    expect(first).toMatchObject({ status: 'PAID', attemptCount: 1 });
    const collected = await books(p.businessId);
    expect(collected).toMatchObject({
      receivable: RENT - first!.principalCents,
      fees: first!.feeCents,
      pool: POOL - RENT + first!.totalCents,
    });
    await run(addDays(p.d1, 1));
    expect((await installmentsOf(p.planId, period))[0]!.status).toBe('PAID');

    // Day 2: the return arrives.
    const returned = await run(addDays(p.d1, 2));
    expect(returned.reconcilePayments.summary).toMatchObject({
      repaymentsReversed: 1,
      payoutsReversed: 0,
    });
    [first] = await installmentsOf(p.planId, period);
    expect(first).toMatchObject({ status: 'FAILED', paidAt: null, attemptCount: 1 });
    expect(first!.repayments).toMatchObject([{ status: 'RETURNED', returnCode: 'R01' }]);
    expect(first!.repayments[0]!.returnedAt?.toISOString().slice(0, 10)).toBe(addDays(p.d1, 2));
    // The books are back where they were before the payment: the fee is not revenue, the
    // receivable is whole, and the pool has given the money back.
    expect(await books(p.businessId)).toMatchObject({
      receivable: RENT,
      fees: 0,
      pool: POOL - RENT,
      cash: 0,
    });
    // The original posting is still there. The reversal is a new one.
    const postings = await h.db.ledgerTransaction.findMany({
      where: { idempotencyKey: { startsWith: `repayment:${first!.repayments[0]!.id}` } },
      orderBy: { effectiveDate: 'asc' },
    });
    expect(postings.map((t) => [t.referenceType, t.effectiveDate])).toEqual([
      ['installment', p.d1],
      ['repayment_return', addDays(p.d1, 2)],
    ]);
    expect((await planRow(p.planId)).delinquencyStatus).toBe('GRACE');
    expect((await auditTypes(p.planId)).filter((t) => t === 'PAYMENT_RETURNED')).toHaveLength(1);
    // Insufficient funds is retryable: the bank link stays, and the plan is not frozen.
    expect((await h.db.bankLink.findUniqueOrThrow({ where: { id: p.bankLinkId } })).status).toBe(
      'LINKED',
    );
    expect((await planRow(p.planId)).advanceFrozenAt).toBeNull();

    // Day 3: the scheduled retry. The return counted as the first attempt.
    const retry = await run(addDays(p.d1, 3));
    expect(retry.collectInstallments.summary).toMatchObject({ paid: 1 });
    [first] = await installmentsOf(p.planId, period);
    expect(first).toMatchObject({ status: 'PAID', attemptCount: 2 });
    expect(first!.repayments.map((r) => r.status)).toEqual(['RETURNED', 'SUCCEEDED']);
    expect(await books(p.businessId)).toEqual(collected);

    // Both installments end up paid inside grace, but a payment bounced: not an on time period.
    await run(addDays(p.d1, 14));
    expect((await installmentsOf(p.planId, period)).map((i) => i.status)).toEqual(['PAID', 'PAID']);
    expect(await countOnTimePeriods(h.db, p.businessId)).toBe(0);
    const history = await p.api.get<Array<{ status: string; returnCode: string | null }>>(
      `/v1/rent-plans/${p.planId}/repayments`,
    );
    expect(history.body.map((r) => [r.status, r.returnCode])).toContainEqual(['RETURNED', 'R01']);
  });

  it('a hard return disables the bank link until the business links an account again', async () => {
    const p = await runningPlan();
    await setAccountToken(p.bankLinkId, 'mock_acct_return_r02');
    const period = p.d1.slice(0, 7);
    await run(p.d1);
    await run(addDays(p.d1, 2));
    expect((await h.db.bankLink.findUniqueOrThrow({ where: { id: p.bankLinkId } })).status).toBe(
      'ERROR',
    );
    expect(await auditTypes(p.planId)).toContain('BANK_LINK_DISABLED');
    // Account closed is not fraud: the plan is not frozen.
    expect((await planRow(p.planId)).advanceFrozenAt).toBeNull();

    // No further automatic debit, on the retry day or after, and no attempt is used.
    for (const day of [3, 4, 6, 9]) {
      const res = await run(addDays(p.d1, day));
      expect(res.collectInstallments.summary).toMatchObject({ paid: 0, failed: 0, late: 0 });
    }
    let [first] = await installmentsOf(p.planId, period);
    expect(first).toMatchObject({
      status: 'LATE',
      attemptCount: 1,
      collectionSkipReason: 'NO_BANK_LINK',
    });
    expect(first!.repayments).toHaveLength(1);
    expect(h.payments.calls.filter((c) => c.kind === 'charge')).toHaveLength(1);
    const detail = await p.api.get<PlanDetail>(`/v1/rent-plans/${p.planId}`);
    expect(detail.body.needsPayment).toBe(true);

    // A new account is linked. Collection starts again with a fresh set of attempts.
    const linked = await p.api.post<{ id: string }>('/v1/bank-links', {
      businessId: p.businessId,
      publicToken: 'mock_healthy_rev_48000_rent_6200_second',
    });
    expect(linked.status).toBe(201);
    const resumed = await run(addDays(p.d1, 10));
    expect(resumed.collectInstallments.summary).toMatchObject({ paid: 1 });
    [first] = await installmentsOf(p.planId, period);
    expect(first).toMatchObject({
      status: 'PAID',
      attemptCount: 1,
      attemptBankLinkId: linked.body.id,
    });
  });

  it('an unauthorized return freezes the plan and raises a high severity event', async () => {
    const p = await runningPlan();
    // Accepted, and disputed as unauthorized three weeks later.
    await setAccountToken(p.bankLinkId, 'mock_acct_late_return_r10');
    const period = p.d1.slice(0, 7);
    await run(p.d1);
    await run(addDays(p.d1, 14));
    expect((await installmentsOf(p.planId, period)).map((i) => i.status)).toEqual(['PAID', 'PAID']);
    expect(await countOnTimePeriods(h.db, p.businessId)).toBe(1);

    const returned = await run(addDays(p.d1, 21));
    expect(returned.reconcilePayments.summary).toMatchObject({ repaymentsReversed: 1 });
    const [first, second] = await installmentsOf(p.planId, period);
    expect(first).toMatchObject({ status: 'LATE', paidAt: null });
    expect(second!.status).toBe('PAID');
    const plan = await planRow(p.planId);
    expect(plan.advanceFrozenAt).not.toBeNull();
    expect(plan.advanceFrozenReason).toBe('UNAUTHORIZED_RETURN');
    expect(plan.delinquencyStatus).toBe('DELINQUENT');
    expect((await h.db.bankLink.findUniqueOrThrow({ where: { id: p.bankLinkId } })).status).toBe(
      'ERROR',
    );
    const event = (await audit(p.planId)).find((e) => e.eventType === 'UNAUTHORIZED_RETURN');
    expect(event?.payload).toMatchObject({
      severity: 'high',
      returnCode: 'R10',
      installmentId: first!.id,
      businessId: p.businessId,
    });
    expect(await auditTypes(p.planId)).toEqual(
      expect.arrayContaining(['PAYMENT_RETURNED', 'BANK_LINK_DISABLED', 'PLAN_ADVANCE_FROZEN']),
    );
    // The period no longer counts toward the limit ladder.
    expect(await countOnTimePeriods(h.db, p.businessId)).toBe(0);
    expect(await books(p.businessId)).toMatchObject({ receivable: first!.principalCents });

    // The next payout is held by the freeze. A reviewer releasing the freeze does not pay it
    // while the returned installment is still unpaid: the reason becomes the past due balance.
    await run(p.d2);
    expect(await payoutOf(p.planId, p.d2.slice(0, 7))).toMatchObject({
      status: 'HELD',
      heldReason: 'ADVANCE_FROZEN',
    });
    const release = await adminClient(h.app).post<{ advanceFrozen: boolean }>(
      `/v1/admin/rent-plans/${p.planId}/release-freeze`,
      { reason: 'Customer confirmed the debit was theirs' },
    );
    expect(release.status).toBe(200);
    expect(release.body.advanceFrozen).toBe(false);
    await run(addDays(p.d2, 1));
    expect(await payoutOf(p.planId, p.d2.slice(0, 7))).toMatchObject({
      status: 'HELD',
      heldReason: 'PAST_DUE',
    });
    expect(await auditTypes(p.planId)).toContain('PLAN_ADVANCE_RELEASED');
    // Releasing a plan that is not frozen is refused.
    const again = await adminClient(h.app).post<{ error: { code: string } }>(
      `/v1/admin/rent-plans/${p.planId}/release-freeze`,
      { reason: 'again' },
    );
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('PLAN_NOT_FROZEN');
  });

  it('a returned landlord payout restores the pool and the receivable and is not retried', async () => {
    // The landlord's account sends the payout back two days later: no such account.
    const p = await runningPlan({
      landlordPayout: {
        accountHolderName: 'Harbor View Properties LLC',
        routingNumber: '123456789',
        accountNumberLast4: '4321',
        providerToken: 'mock_landlord_return_r03',
      },
    });
    const period = p.d1.slice(0, 7);
    await run(p.d1);
    const [first] = await installmentsOf(p.planId, period);
    expect(first!.status).toBe('PAID');
    expect(await books(p.businessId)).toMatchObject({
      receivable: RENT - first!.principalCents,
      pool: POOL - RENT + first!.totalCents,
    });

    const returned = await run(addDays(p.d1, 2));
    expect(returned.reconcilePayments.summary).toMatchObject({ payoutsReversed: 1 });
    const payout = await payoutOf(p.planId, period);
    expect(payout).toMatchObject({ status: 'FAILED', returnCode: 'R03', paidAt: null });
    expect(payout.failureReason).toMatch(/R03/);
    // The pool has its rent back. The receivable is taken off in full, which leaves the
    // principal already collected as a credit owed back to the business.
    expect(await books(p.businessId)).toMatchObject({
      receivable: -first!.principalCents,
      pool: POOL + first!.totalCents,
      fees: first!.feeCents,
    });
    expect((await installmentsOf(p.planId, period)).map((i) => i.status)).toEqual([
      'PAID',
      'VOIDED',
    ]);
    const event = (await audit(p.planId)).find((e) => e.eventType === 'PAYOUT_RETURNED');
    expect(event?.payload).toMatchObject({
      severity: 'high',
      returnCode: 'R03',
      amountCents: RENT,
      customerCreditCents: first!.principalCents,
    });
    const plan = await planRow(p.planId);
    expect(plan.advanceFrozenReason).toBe('PAYOUT_RETURNED');
    expect(plan.delinquencyStatus).toBe('CURRENT');

    // Not sent again to the same account, and the voided installment is never collected.
    await run(addDays(p.d1, 3));
    await run(addDays(p.d1, 14));
    expect(h.payments.calls.filter((c) => c.kind === 'payout')).toHaveLength(1);
    expect((await payoutOf(p.planId, period)).status).toBe('FAILED');
    const detail = await p.api.get<PlanDetail>(`/v1/rent-plans/${p.planId}`);
    expect(detail.body.payouts[0]).toMatchObject({ status: 'FAILED', returnCode: 'R03' });
    expect(detail.body.advanceFrozen).toBe(true);
  });
});

describe('aging, provisioning, charge-off, and recovery', () => {
  const rate = (bucket: OpenBucket) => policy.provisionRatesBps[bucket];

  it('provisions a healthy book at the current rate, once a month, posting only the change', async () => {
    const p = await runningPlan();
    const first = await run(p.d1);
    const [one, two] = await installmentsOf(p.planId, p.d1.slice(0, 7));
    // After the day's collection one installment of principal is outstanding, all current.
    const outstanding = RENT - one!.principalCents;
    expect(first.provision.summary).toMatchObject({
      posted: true,
      requiredCents: reserveCents(policy, 'CURRENT', outstanding),
      changeCents: reserveCents(policy, 'CURRENT', outstanding),
    });
    let b = await books(p.businessId);
    expect(b.allowance).toBe(Math.round((outstanding * rate('CURRENT')) / 10_000));
    expect(b.provision).toBe(b.allowance);
    expect(b.netReceivable).toBe(outstanding - b.allowance);

    // Later in the same month the receivable is repaid. The allowance is not touched again.
    const mid = await run(addDays(p.d1, 14));
    expect(mid.provision.summary).toMatchObject({ posted: false, alreadyPosted: true });
    expect((await books(p.businessId)).allowance).toBe(b.allowance);
    expect(two!.status).toBe('SCHEDULED');

    // Next month the book is the same size, so the allowance is already right: no posting.
    const next = await run(p.d2);
    expect(next.provision.summary).toMatchObject({
      posted: false,
      alreadyPosted: false,
      changeCents: 0,
    });
    b = await books(p.businessId);
    expect(b.netReceivable).toBe(b.receivables - reserveCents(policy, 'CURRENT', b.receivables));

    // Pause the plan so nothing new is fronted. The month after, the book is empty and the
    // allowance is released: a credit to provision expense.
    await p.api.patch(`/v1/rent-plans/${p.planId}`, { status: 'PAUSED' });
    // The month was settled on the first, with no change. A later run that month leaves the
    // allowance alone even though the book has since been repaid.
    const settled = await run(addDays(p.d2, 14));
    expect(settled.provision.summary).toMatchObject({ posted: false, alreadyPosted: true });
    expect((await books(p.businessId)).receivables).toBe(0);
    const released = await run(p.d3);
    expect(released.provision.summary).toMatchObject({ posted: true, requiredCents: 0 });
    expect(await books(p.businessId)).toMatchObject({
      receivables: 0,
      allowance: 0,
      provision: 0,
      netReceivable: 0,
    });
    const postings = await h.db.ledgerTransaction.findMany({
      where: { idempotencyKey: { startsWith: 'provision:' } },
      orderBy: { effectiveDate: 'asc' },
    });
    expect(postings.map((t) => [t.idempotencyKey, t.effectiveDate])).toEqual([
      [`provision:${p.d1.slice(0, 7)}`, p.d1],
      [`provision:${p.d3.slice(0, 7)}`, p.d3],
    ]);
  });

  it('ages a plan through every bucket, charges it off at 90 days, closes it, and books a recovery', async () => {
    const p = await runningPlan();
    await setAccountToken(p.bankLinkId, 'mock_acct_fail');
    const period = p.d1.slice(0, 7);
    const status = async () => (await planRow(p.planId)).delinquencyStatus;

    await run(p.d1);
    expect(await status()).toBe('CURRENT');
    // The month's provision was booked with the whole month's rent outstanding and current.
    expect((await books(p.businessId)).allowance).toBe(reserveCents(policy, 'CURRENT', RENT));

    await run(addDays(p.d1, 1));
    expect(await status()).toBe('GRACE');
    await run(addDays(p.d1, 3));
    expect(await status()).toBe('GRACE');
    // Day 4 has no debit scheduled. The aging job still moves the bucket and marks it late.
    const dayFour = await run(addDays(p.d1, 4));
    expect(dayFour.collectInstallments.summary).toMatchObject({ failed: 0, late: 0 });
    expect(await status()).toBe('DELINQUENT');
    expect((await installmentsOf(p.planId, period))[0]).toMatchObject({
      status: 'LATE',
      attemptCount: 2,
    });
    await run(addDays(p.d1, 6));
    await run(addDays(p.d1, 29));
    expect(await status()).toBe('DELINQUENT');
    await run(addDays(p.d1, 30));
    expect(await status()).toBe('DEFAULT');

    // The second rent date. The payout is held, and the month's provision moves the
    // allowance to the rate for the bucket the plan is in.
    if (p.d2 > addDays(p.d1, 30)) await run(p.d2);
    const bucketAtD2 = delinquencyBucket(policy, daysBetween(p.d1, p.d2)) as OpenBucket;
    const provisionD2 = await h.db.ledgerTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `provision:${p.d2.slice(0, 7)}` },
      include: { entries: true },
    });
    expect(provisionD2.effectiveDate).toBe(p.d2);
    expect(provisionD2.entries[0]!.amountCents).toBe(
      reserveCents(policy, bucketAtD2, RENT) - reserveCents(policy, 'CURRENT', RENT),
    );
    await run(p.d3);
    let b = await books(p.businessId);
    expect(b.allowance).toBe(reserveCents(policy, 'DEFAULT', RENT));
    expect(b.netReceivable).toBe(RENT - reserveCents(policy, 'DEFAULT', RENT));
    expect(b.receivable).toBe(RENT);

    // Day 89: still on the books.
    await run(addDays(p.d1, 89));
    expect(await status()).toBe('DEFAULT');
    expect((await planRow(p.planId)).status).toBe('ACTIVE');

    // Day 90: written off.
    const off = await run(addDays(p.d1, 90));
    expect(off.ageReceivables.summary).toMatchObject({ chargedOffPlans: 1, chargedOffCents: RENT });
    const plan = await planRow(p.planId);
    expect(plan).toMatchObject({
      status: 'CLOSED',
      delinquencyStatus: 'CHARGED_OFF',
      closedReason: 'CHARGED_OFF',
    });
    expect(plan.closedAt?.toISOString().slice(0, 10)).toBe(addDays(p.d1, 90));
    const written = await installmentsOf(p.planId, period);
    expect(written.map((i) => i.status)).toEqual(['CHARGED_OFF', 'CHARGED_OFF']);
    // The receivable is gone against the allowance, which was topped up to cover it. Every
    // cent of the loss has been through provision expense. No fee was ever booked.
    b = await books(p.businessId);
    expect(b).toMatchObject({
      receivable: 0,
      receivables: 0,
      allowance: 0,
      netReceivable: 0,
      provision: RENT,
      fees: 0,
      recoveries: 0,
      pool: POOL - RENT,
    });
    const chargeOff = await h.db.ledgerTransaction.findFirstOrThrow({
      where: { referenceType: 'charge_off', referenceId: p.planId },
      include: { entries: { include: { account: true } } },
    });
    expect(
      chargeOff.entries.map((e) => [e.account.code, e.direction, e.amountCents]).sort(),
    ).toEqual(
      [
        [ACCOUNTS.ALLOWANCE, 'DEBIT', RENT],
        [receivableCode(p.businessId), 'CREDIT', RENT],
      ].sort(),
    );
    expect(await bucketChanges(p.planId)).toEqual([
      'CURRENT>GRACE',
      'GRACE>DELINQUENT',
      'DELINQUENT>DEFAULT',
      'DEFAULT>CHARGED_OFF',
    ]);
    const event = (await audit(p.planId)).find((e) => e.eventType === 'PLAN_CHARGED_OFF');
    expect(event?.payload).toMatchObject({
      severity: 'high',
      principalCents: RENT,
      installments: 2,
      unpaidFeeCents: written[0]!.feeCents + written[1]!.feeCents,
    });
    expect((await h.db.business.findUniqueOrThrow({ where: { id: p.businessId } })).status).toBe(
      'SUSPENDED',
    );
    // Every payout after the first was held and then cancelled. None is left open.
    const payouts = await h.db.landlordPayout.findMany({
      where: { rentPlanId: p.planId },
      orderBy: { scheduledFor: 'asc' },
    });
    expect(payouts[0]!.status).toBe('PAID');
    expect(payouts.slice(1).every((x) => x.status === 'CANCELLED')).toBe(true);
    expect(payouts.length).toBeGreaterThan(1);
    // A closed plan cannot be resumed, and a written off plan generates nothing more.
    const reopen = await p.api.patch<{ error: { code: string } }>(`/v1/rent-plans/${p.planId}`, {
      status: 'ACTIVE',
    });
    expect(reopen.body.error.code).toBe('PLAN_CLOSED');
    await run(addDays(p.d1, 120));
    expect(await h.db.landlordPayout.count({ where: { rentPlanId: p.planId } })).toBe(
      payouts.length,
    );
    // No automatic debit after the write off.
    expect(written.flatMap((i) => i.repayments).every((r) => r.status === 'FAILED')).toBe(true);
    const charges = h.payments.calls.filter((c) => c.kind === 'charge').length;

    // The owner sees a closed, written off plan with both installments still payable.
    const detail = await p.api.get<PlanDetail>(`/v1/rent-plans/${p.planId}`);
    expect(detail.body).toMatchObject({
      status: 'CLOSED',
      delinquencyStatus: 'CHARGED_OFF',
      closedReason: 'CHARGED_OFF',
      needsPayment: true,
      pastDueCents: written[0]!.totalCents + written[1]!.totalCents,
    });
    expect(detail.body.upcomingInstallments.map((i) => i.status)).toEqual([
      'CHARGED_OFF',
      'CHARGED_OFF',
    ]);

    // Later the business pays the first installment by hand. That is a recovery.
    await setAccountToken(p.bankLinkId, 'mock_acct_ok');
    const paid = await p.api.post<{ status: string; chargedOffAt: string | null }>(
      '/v1/repayments',
      { installmentId: written[0]!.id },
    );
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');
    expect(paid.body.chargedOffAt).not.toBeNull();
    expect(h.payments.calls.filter((c) => c.kind === 'charge')).toHaveLength(charges + 1);
    await run(addDays(p.d1, 121)); // sweep the recovered cash
    b = await books(p.businessId);
    expect(b).toMatchObject({
      receivable: 0,
      allowance: 0,
      recoveries: written[0]!.principalCents,
      fees: written[0]!.feeCents,
      provision: RENT,
      pool: POOL - RENT + written[0]!.totalCents,
    });
    const recovery = (await installmentsOf(p.planId, period))[0]!;
    expect(recovery.repayments.at(-1)).toMatchObject({ status: 'SUCCEEDED', recovery: true });
    expect(await auditTypes(p.planId)).toContain('RECOVERY_RECEIVED');
    // The plan stays closed and written off, and the period is never an on time one.
    expect(await planRow(p.planId)).toMatchObject({
      status: 'CLOSED',
      delinquencyStatus: 'CHARGED_OFF',
    });
    expect(await countOnTimePeriods(h.db, p.businessId)).toBe(0);

    // The operator's summary agrees with the ledger.
    const summary = await adminClient(h.app).get<{
      buckets: Array<{ status: string; plans: number; principalCents: number }>;
      allowanceCents: number;
      receivableCents: number;
      chargedOffCents: number;
      chargedOffPlans: number;
      recoveredCents: number;
      provisionExpenseCents: number;
    }>('/v1/admin/delinquency');
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({
      allowanceCents: 0,
      receivableCents: 0,
      chargedOffCents: RENT,
      chargedOffPlans: 1,
      recoveredCents: written[0]!.principalCents,
      provisionExpenseCents: RENT,
    });
    expect(summary.body.buckets.find((x) => x.status === 'CHARGED_OFF')).toMatchObject({
      plans: 1,
      principalCents: 0,
    });
    // A suspended business cannot open another plan.
    await expect(
      createRentPlan(ctx, {
        userId: (await h.db.business.findUniqueOrThrow({ where: { id: p.businessId } }))
          .ownerUserId,
        leaseId: plan.leaseId,
        applicationId: plan.applicationId,
        installmentsPerMonth: 2,
        asOf: todayIso(),
      }),
    ).rejects.toMatchObject({ code: 'BUSINESS_SUSPENDED' });
  });

  it('the delinquency summary groups open balances by bucket with the reserve each calls for', async () => {
    const p = await runningPlan();
    await setAccountToken(p.bankLinkId, 'mock_acct_fail');
    await run(p.d1);
    await run(addDays(p.d1, 10));
    const summary = await adminClient(h.app).get<{
      servicingPolicy: string;
      buckets: Array<{
        status: string;
        plans: number;
        principalCents: number;
        provisionRateBps: number | null;
        requiredReserveCents: number;
      }>;
      requiredAllowanceCents: number;
      allowanceCents: number;
      netReceivableCents: number;
      heldPayouts: number;
    }>('/v1/admin/delinquency');
    expect(summary.body.servicingPolicy).toBe('standard');
    expect(summary.body.buckets.map((x) => x.status)).toEqual([
      'CURRENT',
      'GRACE',
      'DELINQUENT',
      'DEFAULT',
      'CHARGED_OFF',
    ]);
    expect(summary.body.buckets.find((x) => x.status === 'DELINQUENT')).toEqual({
      status: 'DELINQUENT',
      plans: 1,
      principalCents: RENT,
      provisionRateBps: rate('DELINQUENT'),
      requiredReserveCents: reserveCents(policy, 'DELINQUENT', RENT),
    });
    expect(summary.body.requiredAllowanceCents).toBe(reserveCents(policy, 'DELINQUENT', RENT));
    // The allowance was last set on the first, when the plan was current. It catches up at
    // the next monthly provision, which is why the summary shows both figures.
    expect(summary.body.allowanceCents).toBe(reserveCents(policy, 'CURRENT', RENT));
    expect(summary.body.netReceivableCents).toBe(RENT - summary.body.allowanceCents);
  });
});

describe('each job on its own', () => {
  it('can be run twice for the same date without changing anything', async () => {
    const p = await runningPlan();
    await setAccountToken(p.bankLinkId, 'mock_acct_return_r01');
    // Build up a state with something for every job: a paid payout, a returned payment, a
    // past due plan, and a held payout.
    for (const day of [0, 2, 3, 5, 6, 8]) await runAllJobs(ctx, addDays(p.d1, day));
    for (const asOf of [addDays(p.d1, 9), p.d2, addDays(p.d1, 95)]) {
      for (const name of Object.keys(JOBS) as JobName[]) {
        const first = await JOBS[name](ctx, asOf);
        expect(first.ok, `${name} on ${asOf}`).toBe(true);
        const after = await fingerprint();
        const second = await JOBS[name](ctx, asOf);
        expect(second.ok).toBe(true);
        expect(await fingerprint(), `${name} twice on ${asOf}`).toEqual(after);
        expect(after.balanced).toBe(true);
      }
    }
    // Every run was recorded.
    for (const name of Object.keys(JOBS)) {
      expect(await h.db.jobRun.count({ where: { name, ok: true } })).toBeGreaterThanOrEqual(6);
    }
    expect((await planRow(p.planId)).delinquencyStatus).toBe('CHARGED_OFF');
  });
});

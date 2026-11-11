import { feeForRent } from '@cashflow/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ACCOUNTS, receivableCode } from '../ledger/accounts.ts';
import { accountBalance, postTransaction } from '../ledger/service.ts';
import {
  approvedBusiness,
  client,
  createTestApp,
  demoLease,
  registerUser,
  resetDb,
  type TestHarness,
  adminClient,
} from '../test/helpers.ts';

let h: TestHarness;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDb(h.db);
});

const RENT = 620_000;

async function fundPool(amountCents: number) {
  const res = await adminClient(h.app).post('/v1/admin/capital/fund', {
    amountCents,
    description: 'test funding',
  });
  expect(res.status).toBe(200);
}

async function runJobs(asOf: string) {
  const res = await adminClient(h.app).post<Record<string, unknown>>('/v1/admin/jobs/run', {
    asOf,
  });
  expect(res.status).toBe(200);
  return res.body;
}

async function trialBalance() {
  const res = await adminClient(h.app).get<{ balanced: boolean; totalDebitsCents: number }>(
    '/v1/admin/ledger/trial-balance',
  );
  expect(res.status).toBe(200);
  return res.body;
}

describe('rent payment lifecycle', () => {
  it('pays the landlord on the due date, collects two installments, and keeps the ledger balanced', async () => {
    await fundPool(25_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId, decision } = await approvedBusiness(h.app, session);
    // Fee per period at the rate underwriting priced for this business.
    const FEE = feeForRent(RENT, decision.feeBps);

    const lease = await api.post<{ id: string; landlordPayout: Record<string, unknown> }>(
      '/v1/leases',
      demoLease(businessId),
    );
    expect(lease.status).toBe(201);
    // The payout token is never echoed back.
    expect(lease.body.landlordPayout).not.toHaveProperty('providerToken');

    const plan = await api.post<{ id: string; feeBps: number }>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId,
      installmentsPerMonth: 2,
    });
    expect(plan.status).toBe(201);
    // The plan inherits the fee the underwriting decision priced.
    expect(plan.body.feeBps).toBe(decision.feeBps);

    // The plan was created "today", so the first period is the next due date from today.
    const detail = await api.get<{
      payouts: Array<{
        id: string;
        scheduledFor: string;
        status: string;
        amountCents: number;
        periodMonth: string;
      }>;
      upcomingInstallments: Array<{
        id: string;
        dueDate: string;
        totalCents: number;
        sequence: number;
      }>;
      nextInstallment: { sequence: number };
    }>(`/v1/rent-plans/${plan.body.id}`);
    expect(detail.body.payouts).toHaveLength(1);
    expect(detail.body.upcomingInstallments).toHaveLength(2);
    expect(detail.body.nextInstallment.sequence).toBe(1);

    const payout = detail.body.payouts[0]!;
    const first = detail.body.upcomingInstallments[0]!;
    const second = detail.body.upcomingInstallments[1]!;
    expect(payout.amountCents).toBe(RENT);
    expect(first.totalCents + second.totalCents).toBe(RENT + FEE);
    expect(first.dueDate).toBe(payout.scheduledFor);

    // Nothing happens before the due date.
    const dayBefore = await runJobs(addDaysStr(payout.scheduledFor, -1));
    expect((dayBefore.processPayouts as { summary: { paid: number } }).summary.paid).toBe(0);

    // Due date: landlord paid, first installment collected, cash swept back to the pool.
    const dueDay = await runJobs(payout.scheduledFor);
    expect((dueDay.processPayouts as { summary: { paid: number } }).summary.paid).toBe(1);
    expect((dueDay.collectInstallments as { summary: { paid: number } }).summary.paid).toBe(1);

    const afterDue = await api.get<{
      payouts: Array<{ status: string; providerRef: string | null }>;
      upcomingInstallments: unknown[];
    }>(`/v1/rent-plans/${plan.body.id}`);
    expect(afterDue.body.payouts[0]?.status).toBe('PAID');
    expect(afterDue.body.payouts[0]?.providerRef).toMatch(/^mock_payout_/);
    expect(afterDue.body.upcomingInstallments).toHaveLength(1);

    const tb1 = await trialBalance();
    expect(tb1.balanced).toBe(true);
    expect(await accountBalance(h.db, receivableCode(businessId))).toBe(
      RENT - second.totalCents + FEE - feeOf(first),
    );
    // Pool: funded 25,000,000, paid out 620,000, swept back first installment (principal + fee).
    expect(await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL)).toBe(
      25_000_000 - RENT + first.totalCents,
    );
    expect(await accountBalance(h.db, ACCOUNTS.CASH)).toBe(0);

    // Second installment.
    await runJobs(second.dueDate);
    // The job run also scheduled next month's period (30 day horizon), so only check this period is settled.
    const done = await api.get<{ upcomingInstallments: Array<{ periodMonth: string }> }>(
      `/v1/rent-plans/${plan.body.id}`,
    );
    expect(
      done.body.upcomingInstallments.filter((i) => i.periodMonth === payout.periodMonth),
    ).toHaveLength(0);
    expect(done.body.upcomingInstallments.length).toBeGreaterThan(0);
    expect(await accountBalance(h.db, receivableCode(businessId))).toBe(0);
    expect(await accountBalance(h.db, ACCOUNTS.FEE_REVENUE)).toBe(FEE);
    expect(await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL)).toBe(25_000_000 + FEE);
    expect((await trialBalance()).balanced).toBe(true);

    // Payment history lists both successful collections.
    const history = await api.get<Array<{ status: string }>>(
      `/v1/rent-plans/${plan.body.id}/repayments`,
    );
    expect(history.body.map((r) => r.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);

    // Running the same day again changes nothing.
    const before = await trialBalance();
    await runJobs(second.dueDate);
    const after = await trialBalance();
    expect(after.totalDebitsCents).toBe(before.totalDebitsCents);
  });

  it('fails the payout when the pool is short and recovers after funding', async () => {
    // A plan can only be opened against a pool with room for it. The pool is then drawn
    // down, as it would be by other payouts, before this one falls due.
    await fundPool(25_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    const lease = await api.post<{ id: string }>('/v1/leases', demoLease(businessId));
    const plan = await api.post<{ id: string }>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId,
      installmentsPerMonth: 2,
    });
    expect(plan.status).toBe(201);
    await h.db.$transaction((tx) =>
      postTransaction(tx, {
        description: 'Test: capital withdrawn',
        effectiveDate: '2026-01-01',
        referenceType: 'capital_withdrawal',
        entries: [
          { accountCode: ACCOUNTS.POOL_EQUITY, direction: 'DEBIT', amountCents: 24_900_000 },
          { accountCode: ACCOUNTS.CAPITAL_POOL, direction: 'CREDIT', amountCents: 24_900_000 },
        ],
      }),
    ); // $1,000 left: far less than one month's rent
    const detail = await api.get<{ payouts: Array<{ scheduledFor: string }> }>(
      `/v1/rent-plans/${plan.body.id}`,
    );
    const due = detail.body.payouts[0]!.scheduledFor;

    await runJobs(due);
    let payouts = await api.get<Array<{ status: string; failureReason: string | null }>>(
      `/v1/rent-plans/${plan.body.id}/payouts`,
    );
    expect(payouts.body[0]?.status).toBe('FAILED');
    expect(payouts.body[0]?.failureReason).toMatch(/Insufficient capital/);
    // No installment is collected while the landlord is unpaid.
    const installments = await api.get<Array<{ status: string }>>(
      `/v1/rent-plans/${plan.body.id}/installments`,
    );
    expect(installments.body.every((i) => i.status === 'SCHEDULED')).toBe(true);

    await fundPool(10_000_000);
    await runJobs(due);
    payouts = await api.get(`/v1/rent-plans/${plan.body.id}/payouts`);
    expect(payouts.body[0]?.status).toBe('PAID');
    expect((await trialBalance()).balanced).toBe(true);
  });

  it('records a failed collection and marks it late after the grace period', async () => {
    await fundPool(25_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    // Replace the good bank link with one whose account token forces charge failures.
    await h.db.bankLink.updateMany({
      where: { businessId },
      data: { providerAccountToken: 'mock_acct_fail' },
    });

    const lease = await api.post<{ id: string }>('/v1/leases', demoLease(businessId));
    const plan = await api.post<{ id: string }>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId,
      installmentsPerMonth: 2,
    });
    const detail = await api.get<{ payouts: Array<{ scheduledFor: string }> }>(
      `/v1/rent-plans/${plan.body.id}`,
    );
    const due = detail.body.payouts[0]!.scheduledFor;

    await runJobs(due);
    let installments = await api.get<Array<{ status: string; sequence: number }>>(
      `/v1/rent-plans/${plan.body.id}/installments`,
    );
    expect(installments.body.find((i) => i.sequence === 1)?.status).toBe('FAILED');

    await runJobs(addDaysStr(due, 5));
    installments = await api.get(`/v1/rent-plans/${plan.body.id}/installments`);
    expect(installments.body.find((i) => i.sequence === 1)?.status).toBe('LATE');

    const history = await api.get<Array<{ status: string; failureReason: string | null }>>(
      `/v1/rent-plans/${plan.body.id}/repayments`,
    );
    expect(history.body.length).toBeGreaterThanOrEqual(2);
    expect(history.body.every((r) => r.status === 'FAILED')).toBe(true);
    // The receivable is still outstanding and the books still balance.
    expect(await accountBalance(h.db, receivableCode(businessId))).toBe(RENT);
    expect((await trialBalance()).balanced).toBe(true);
  });

  it('lets a business pay an installment early, and refuses over-limit rent', async () => {
    await fundPool(25_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);

    const tooBig = await api.post<{ id: string }>(
      '/v1/leases',
      demoLease(businessId, { monthlyRentCents: 5_000_000 }),
    );
    const rejected = await api.post<{ error: { code: string } }>('/v1/rent-plans', {
      leaseId: tooBig.body.id,
      applicationId,
      installmentsPerMonth: 2,
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.error.code).toBe('RENT_OVER_LIMIT');

    const lease = await api.post<{ id: string }>('/v1/leases', demoLease(businessId));
    const plan = await api.post<{ id: string }>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId,
      installmentsPerMonth: 2,
    });
    const detail = await api.get<{
      payouts: Array<{ scheduledFor: string }>;
      upcomingInstallments: Array<{ id: string; sequence: number }>;
    }>(`/v1/rent-plans/${plan.body.id}`);
    const second = detail.body.upcomingInstallments.find((i) => i.sequence === 2)!;

    // Before the landlord is paid, early payment is refused.
    const early = await api.post<{ error: { code: string } }>('/v1/repayments', {
      installmentId: second.id,
    });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('PAYOUT_PENDING');

    await runJobs(detail.body.payouts[0]!.scheduledFor);
    const paid = await api.post<{ status: string }>('/v1/repayments', { installmentId: second.id });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('PAID');
    const again = await api.post<{ error: { code: string } }>('/v1/repayments', {
      installmentId: second.id,
    });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('ALREADY_PAID');
  });
});

function addDaysStr(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

function feeOf(i: { totalCents: number }): number {
  // installment total = principal + fee; principal is RENT / 2 for two installments
  return i.totalCents - RENT / 2;
}

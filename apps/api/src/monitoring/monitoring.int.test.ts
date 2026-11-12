import { addDays } from '@cashflow/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../context.ts';
import { todayIso } from '../dates.ts';
import { JOB_NAMES } from '../jobs/index.ts';
import { ACCOUNTS } from '../ledger/accounts.ts';
import { accountBalance } from '../ledger/service.ts';
import { collectInstallment } from '../services/collections.ts';
import {
  adminClient,
  approvedBusiness,
  client,
  createTestApp,
  demoBusiness,
  demoLease,
  fundPool,
  registerUser,
  resetDb,
  runJobsAsOf,
  soonDue,
  type TestHarness,
} from '../test/helpers.ts';
import { RULES } from './engine.ts';

/**
 * The monitor job against a real database: it opens alerts idempotently, resolves the ones
 * whose condition clears, trips the circuit breaker, and the books rules catch a ledger
 * that disagrees with the records.
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

const TODAY = todayIso();
const RENT = 620_000;

interface AlertBody {
  id: string;
  type: string;
  category: string;
  severity: string;
  status: string;
  subjectType: string;
  subjectId: string;
  title: string;
  disposition: string | null;
  acknowledgedBy: string | null;
  resolvedBy: string | null;
  notes: string | null;
  detail: Record<string, unknown>;
}
type ErrorBody = { error: { code: string } };

const reviewer = (actor = 'pat@cashflow.example') =>
  adminClient(h.app, { role: 'reviewer', actor });
const admin = (actor = 'chief@cashflow.example') => adminClient(h.app, { actor });

const alerts = async (query = '') =>
  (
    await reviewer().get<{ items: AlertBody[]; nextCursor: string | null }>(
      `/v1/admin/alerts${query}`,
    )
  ).body.items;

const monitor = async (asOf = TODAY) =>
  (await runJobsAsOf(h.app, asOf, 'monitor')).monitor as unknown as {
    ok: boolean;
    summary: Record<string, number | boolean>;
  };

/** An approved business with a plan whose first rent date is within days. */
async function runningPlan(
  options: { bankToken?: string; business?: Record<string, unknown> } = {},
) {
  const session = await registerUser(h.app);
  const api = client(h.app, session);
  const approved = await approvedBusiness(h.app, session, options);
  const due = soonDue(TODAY);
  const lease = await api.post<{ id: string }>(
    '/v1/leases',
    demoLease(approved.businessId, { dueDayOfMonth: due.dueDay }),
  );
  const plan = await api.post<{ id: string }>('/v1/rent-plans', {
    leaseId: lease.body.id,
    applicationId: approved.applicationId,
  });
  expect(plan.status).toBe(201);
  return { api, session, ...approved, leaseId: lease.body.id, planId: plan.body.id, due: due.date };
}

/** A clean applicant on its own bank account, name and address. */
async function applicant(n: number) {
  const session = await registerUser(h.app);
  const api = client(h.app, session);
  const business = await api.post<{ id: string }>('/v1/businesses', {
    ...demoBusiness,
    legalName: `Applicant ${n} LLC`,
    address: { ...demoBusiness.address, line1: `${n} Applicant Way` },
  });
  const link = await api.post<{ id: string }>('/v1/bank-links', {
    businessId: business.body.id,
    publicToken: `mock_healthy_rev_48000_rent_6200_applicant_${n}`,
  });
  const draft = await api.post<{ id: string }>('/v1/underwriting/applications', {
    businessId: business.body.id,
    statedMonthlyRevenueCents: 4_800_000,
    timeInBusinessMonths: 36,
    requestedMonthlyRentCents: RENT,
    bankLinkId: link.body.id,
  });
  const submitted = await api.post<{ id: string; status: string }>(
    `/v1/underwriting/applications/${draft.body.id}/submit`,
  );
  return submitted.body;
}

describe('the monitor job', () => {
  it('finds nothing on an empty database and on a healthy book', async () => {
    const empty = await monitor();
    expect(empty.summary).toMatchObject({
      rules: RULES.length,
      ruleErrors: 0,
      candidates: 0,
      opened: 0,
    });
    await fundPool(h.app, 25_000_000);
    const p = await runningPlan();
    await runJobsAsOf(h.app, p.due);
    await runJobsAsOf(h.app, p.due);
    expect(await alerts('?status=ALL')).toEqual([]);
    expect(await h.db.jobRun.count({ where: { name: 'monitor', ok: true } })).toBe(3);
  });

  it('is idempotent: the same condition opens one alert however often it runs', async () => {
    await fundPool(h.app, 25_000_000);
    const p = await runningPlan();
    await p.api.patch(`/v1/leases/${p.leaseId}`, { landlordName: 'Harbor View Holdings' });
    // The request opened the alert. The monitor finds it there and adds nothing.
    const first = await monitor();
    expect(first.summary).toMatchObject({ candidates: 1, opened: 0, refreshed: 1 });
    const second = await monitor();
    expect(second.summary).toMatchObject({
      candidates: 1,
      opened: 0,
      refreshed: 1,
      autoResolved: 0,
    });
    const open = await alerts();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ type: 'fraud.landlord_change_pending', status: 'OPEN' });
    expect(await h.db.auditEvent.count({ where: { eventType: 'ALERT_OPENED' } })).toBe(1);
    // A full run on the same day, twice, still leaves exactly one.
    await runJobsAsOf(h.app, TODAY);
    await runJobsAsOf(h.app, TODAY);
    expect(await h.db.alert.count()).toBe(1);
  });

  it('the database refuses a second open alert with the same key', async () => {
    const data = {
      type: 'books.pool_negative',
      category: 'BOOKS',
      severity: 'CRITICAL' as const,
      subjectType: 'ledger',
      subjectId: 'capital_pool',
      title: 'x',
      detail: {},
      dedupeKey: 'books.pool_negative',
    };
    const first = await h.db.alert.create({ data });
    await expect(h.db.alert.create({ data })).rejects.toThrow();
    // Once the first is resolved, a new one may open.
    await h.db.alert.update({ where: { id: first.id }, data: { status: 'RESOLVED' } });
    await expect(h.db.alert.create({ data })).resolves.toBeTruthy();
  });

  it('acknowledge and resolve record who and why, and a resolved condition is not reopened by the next run', async () => {
    await fundPool(h.app, 25_000_000);
    const p = await runningPlan();
    await p.api.patch(`/v1/leases/${p.leaseId}`, { landlordName: 'Harbor View Holdings' });
    const [alert] = await alerts();

    const detail = await reviewer().get<{
      alert: AlertBody;
      subject: { label: string; businessId: string; leaseId: string; rentPlanId: string };
      rule: { type: string; autoResolves: boolean };
      auditEvents: Array<{ eventType: string }>;
    }>(`/v1/admin/alerts/${alert!.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.subject).toMatchObject({
      businessId: p.businessId,
      leaseId: p.leaseId,
      rentPlanId: p.planId,
    });
    expect(detail.body.subject.label).toContain('Blue Door Bakery LLC');
    expect(detail.body.rule).toMatchObject({
      type: 'fraud.landlord_change_pending',
      autoResolves: true,
    });
    expect(detail.body.auditEvents.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['ALERT_OPENED', 'LEASE_CHANGE_REQUESTED']),
    );

    const acked = await reviewer().post<AlertBody>(`/v1/admin/alerts/${alert!.id}/acknowledge`, {
      notes: 'Calling the landlord.',
    });
    expect(acked.body).toMatchObject({
      status: 'ACKNOWLEDGED',
      acknowledgedBy: 'pat@cashflow.example',
    });
    expect(acked.body.notes).toContain('Calling the landlord.');
    expect(
      (await reviewer().post<ErrorBody>(`/v1/admin/alerts/${alert!.id}/acknowledge`)).body.error
        .code,
    ).toBe('ALERT_NOT_OPEN');
    // Still one alert while acknowledged.
    await monitor();
    expect(await h.db.alert.count()).toBe(1);

    // Resolving needs a disposition and a note, and cannot claim the monitor's disposition.
    const url = `/v1/admin/alerts/${alert!.id}/resolve`;
    expect((await reviewer().post(url, { disposition: 'FALSE_POSITIVE' })).status).toBe(400);
    expect(
      (await reviewer().post(url, { disposition: 'CONDITION_CLEARED', notes: 'cleared' })).status,
    ).toBe(400);
    const resolved = await reviewer('lee@cashflow.example').post<AlertBody>(url, {
      disposition: 'FALSE_POSITIVE',
      notes: 'Landlord confirmed the rename in writing.',
    });
    expect(resolved.body).toMatchObject({
      status: 'RESOLVED',
      disposition: 'FALSE_POSITIVE',
      resolvedBy: 'lee@cashflow.example',
    });
    expect(resolved.body.notes).toMatch(/Calling the landlord[\s\S]*confirmed the rename/);
    expect(
      (await reviewer().post<ErrorBody>(url, { disposition: 'NO_ACTION', notes: 'again' })).body
        .error.code,
    ).toBe('ALERT_RESOLVED');

    // The change is still pending. A person closed the alert, so the monitor leaves it.
    const run = await monitor();
    expect(run.summary).toMatchObject({ candidates: 1, opened: 0 });
    expect(await alerts()).toEqual([]);
    const trail = await h.db.auditEvent.findMany({
      where: { subjectType: 'alert', subjectId: alert!.id },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    expect(trail.map((e) => [e.eventType, e.actorType, e.actorId])).toEqual([
      ['ALERT_OPENED', 'system', 'lease-change-control'],
      ['ALERT_ACKNOWLEDGED', 'reviewer', 'pat@cashflow.example'],
      ['ALERT_RESOLVED', 'reviewer', 'lee@cashflow.example'],
    ]);
  });

  it('filters and pages the alert list', async () => {
    for (let i = 0; i < 5; i++) {
      await h.db.alert.create({
        data: {
          type: i < 3 ? 'books.job_stale' : 'fraud.screening_hit',
          category: i < 3 ? 'BOOKS' : 'FRAUD',
          severity: i < 3 ? 'HIGH' : 'CRITICAL',
          subjectType: 'job',
          subjectId: `s${i}`,
          title: `alert ${i}`,
          detail: {},
          dedupeKey: `k${i}`,
          status: i === 0 ? 'RESOLVED' : 'OPEN',
          createdAt: new Date(Date.now() - i * 1000),
        },
      });
    }
    expect(await alerts()).toHaveLength(4);
    expect(await alerts('?status=ALL')).toHaveLength(5);
    expect(await alerts('?status=RESOLVED')).toHaveLength(1);
    expect(await alerts('?severity=CRITICAL')).toHaveLength(2);
    expect(await alerts('?category=BOOKS')).toHaveLength(2);
    expect(await alerts('?type=fraud.screening_hit&subjectId=s4')).toHaveLength(1);
    const page1 = await reviewer().get<{ items: AlertBody[]; nextCursor: string | null }>(
      '/v1/admin/alerts?limit=3',
    );
    expect(page1.body.items.map((a) => a.title)).toEqual(['alert 1', 'alert 2', 'alert 3']);
    const page2 = await reviewer().get<{ items: AlertBody[]; nextCursor: string | null }>(
      `/v1/admin/alerts?limit=3&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.items.map((a) => a.title)).toEqual(['alert 4']);
    expect(page2.body.nextCursor).toBeNull();
  });

  it('summarizes open alerts, the breaker, and the last run of every job and rule', async () => {
    await fundPool(h.app, 25_000_000);
    const p = await runningPlan();
    await p.api.patch(`/v1/leases/${p.leaseId}`, { landlordName: 'Harbor View Holdings' });
    await runJobsAsOf(h.app, TODAY);
    const res = await reviewer().get<{
      openBySeverity: Record<string, number>;
      openByCategory: Record<string, number>;
      openByType: Array<{ type: string; severity: string; count: number }>;
      unacknowledged: number;
      circuitBreaker: { tripped: boolean };
      lastMonitorRun: { asOf: string; ok: boolean };
      jobs: Array<{
        name: string;
        lastRun: { ok: boolean } | null;
        lastSuccessAsOf: string | null;
      }>;
      rules: Array<{
        type: string;
        openAlerts: number;
        lastRunCandidates: number | null;
        lastRunOk: boolean;
      }>;
      pendingLeaseChanges: number;
    }>('/v1/admin/monitoring/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      openBySeverity: { INFO: 0, WARNING: 0, HIGH: 1, CRITICAL: 0 },
      openByCategory: { FRAUD: 1, PAYMENTS: 0, PORTFOLIO: 0, BOOKS: 0, COMPLIANCE: 0 },
      openByType: [{ type: 'fraud.landlord_change_pending', severity: 'HIGH', count: 1 }],
      unacknowledged: 1,
      circuitBreaker: { tripped: false },
      lastMonitorRun: { asOf: TODAY, ok: true },
      pendingLeaseChanges: 1,
    });
    expect(res.body.jobs.map((j) => j.name)).toEqual([...JOB_NAMES]);
    expect(res.body.jobs.every((j) => j.lastRun?.ok === true && j.lastSuccessAsOf === TODAY)).toBe(
      true,
    );
    expect(res.body.rules.map((r) => r.type)).toEqual(RULES.map((r) => r.type));
    expect(res.body.rules.every((r) => r.lastRunOk === true)).toBe(true);
    expect(res.body.rules.find((r) => r.type === 'fraud.landlord_change_pending')).toMatchObject({
      openAlerts: 1,
      lastRunCandidates: 1,
    });
  });
});

describe('the circuit breaker', () => {
  it('trips on a critical portfolio breach, refers new approvals, and restores them when an admin resets it', async () => {
    await fundPool(h.app, 25_000_000);
    const p = await runningPlan();
    expect((await applicant(1)).status).toBe('APPROVED');

    // Committed rent far above the pool's capital: the book cannot fund itself.
    await h.db.rentPlan.update({ where: { id: p.planId }, data: { monthlyRentCents: 30_000_000 } });
    const run = await monitor();
    expect(run.summary.breakerTripped).toBe(true);
    const [alert] = await alerts('?type=portfolio.pool_utilization');
    expect(alert).toMatchObject({ severity: 'CRITICAL', category: 'PORTFOLIO' });
    const status = await reviewer().get<{
      tripped: boolean;
      trippedByRule: string;
      trippedAlertId: string;
      reason: string;
    }>('/v1/admin/circuit-breaker');
    expect(status.body).toMatchObject({
      tripped: true,
      trippedByRule: 'portfolio.pool_utilization',
      trippedAlertId: alert!.id,
    });
    expect(status.body.reason).toMatch(/utilization/i);
    const tripped = await h.db.auditEvent.findFirstOrThrow({
      where: { eventType: 'CIRCUIT_BREAKER_TRIPPED' },
    });
    expect(tripped).toMatchObject({ actorType: 'job', actorId: 'monitor' });
    expect(tripped.payload).toMatchObject({ rule: 'portfolio.pool_utilization', severity: 'high' });

    // The same clean applicant that was approved a moment ago is now referred.
    const referred = await applicant(2);
    expect(referred.status).toBe('IN_REVIEW');
    const queue =
      await reviewer().get<
        Array<{ applicationId: string; referTriggers: string[]; recommendedOutcome: string }>
      >('/v1/admin/reviews');
    expect(queue.body.find((q) => q.applicationId === referred.id)).toMatchObject({
      referTriggers: ['CIRCUIT_BREAKER'],
      recommendedOutcome: 'APPROVED',
    });
    // A reviewer can still approve it: the breaker puts a person in the loop, it does not stop lending.
    const approved = await reviewer().post<{ application: { status: string } }>(
      `/v1/admin/applications/${referred.id}/review`,
      { decision: 'APPROVE' },
    );
    expect(approved.body.application.status).toBe('APPROVED');

    // Only an admin resets it, with a reason.
    const reset = '/v1/admin/circuit-breaker/reset';
    expect((await reviewer().post(reset, { reason: 'Looks fine now' })).status).toBe(403);
    expect((await admin().post(reset, {})).status).toBe(400);
    const done = await admin().post<{ tripped: boolean; resetBy: string; resetReason: string }>(
      reset,
      {
        reason: 'Pool funded for next month. Commitments reviewed plan by plan.',
      },
    );
    expect(done.body).toMatchObject({ tripped: false, resetBy: 'chief@cashflow.example' });
    const resetEvent = await h.db.auditEvent.findFirstOrThrow({
      where: { eventType: 'CIRCUIT_BREAKER_RESET' },
    });
    expect(resetEvent).toMatchObject({ actorType: 'admin', actorId: 'chief@cashflow.example' });
    expect(resetEvent.payload).toMatchObject({ trippedByRule: 'portfolio.pool_utilization' });
    expect((await admin().post<ErrorBody>(reset, { reason: 'again' })).body.error.code).toBe(
      'BREAKER_NOT_TRIPPED',
    );

    // Decisions are automatic again, and the alert that is still open does not trip it twice.
    expect((await applicant(3)).status).toBe('APPROVED');
    const again = await monitor();
    expect(again.summary).toMatchObject({ breakerTripped: false, opened: 0 });
    expect(
      (await reviewer().get<{ tripped: boolean }>('/v1/admin/circuit-breaker')).body.tripped,
    ).toBe(false);
    expect(await h.db.auditEvent.count({ where: { eventType: 'CIRCUIT_BREAKER_TRIPPED' } })).toBe(
      1,
    );

    // When the condition clears the alert resolves on its own.
    await h.db.rentPlan.update({ where: { id: p.planId }, data: { monthlyRentCents: RENT } });
    await monitor();
    expect(await alerts('?type=portfolio.pool_utilization')).toEqual([]);
  });
});

describe('books and operations rules on a real ledger', () => {
  it('catches cash left by a sweep that did not happen, and clears when it does', async () => {
    await fundPool(h.app, 25_000_000);
    const p = await runningPlan();
    await runJobsAsOf(h.app, p.due);
    expect(await alerts()).toEqual([]);

    // The owner pays the second installment early. That lands in operating cash, where it
    // waits for the next collection run: not a fault yet.
    const second = await h.db.installment.findFirstOrThrow({
      where: { rentPlanId: p.planId, status: 'SCHEDULED', payout: { status: 'PAID' } },
      orderBy: { dueDate: 'asc' },
    });
    expect(await collectInstallment(ctx, second.id, p.due, { manual: true })).toBe('paid');
    const cash = await accountBalance(h.db, ACCOUNTS.CASH);
    expect(cash).toBeGreaterThan(0);
    await monitor(p.due);
    expect(await alerts('?type=books.cash_not_swept')).toEqual([]);

    // A collection run that reports success but never settled cash with the pool.
    await h.db.jobRun.create({
      data: {
        name: 'collect-installments',
        asOf: p.due,
        ok: true,
        finishedAt: new Date(Date.now() + 60_000),
        summary: { due: 0, sweptCents: 0 },
      },
    });
    await monitor(p.due);
    const [alert] = await alerts('?type=books.cash_not_swept');
    expect(alert).toMatchObject({
      severity: 'HIGH',
      category: 'BOOKS',
      detail: { cashCents: cash },
    });

    // The real job sweeps, and the alert resolves.
    await runJobsAsOf(h.app, p.due);
    expect(await accountBalance(h.db, ACCOUNTS.CASH)).toBe(0);
    expect(await alerts('?type=books.cash_not_swept')).toEqual([]);
    const [resolved] = await alerts('?type=books.cash_not_swept&status=RESOLVED');
    expect(resolved).toMatchObject({
      disposition: 'CONDITION_CLEARED',
      resolvedBy: 'system:monitor',
    });
  });

  it('catches a receivable that does not match the installments', async () => {
    await fundPool(h.app, 25_000_000);
    const p = await runningPlan();
    await runJobsAsOf(h.app, p.due);
    // The ledger says 3,100 is owed (the second installment). Shrink the installment
    // without a posting, as a bad data fix would.
    const unpaid = await h.db.installment.findFirstOrThrow({
      where: { rentPlanId: p.planId, status: 'SCHEDULED', payout: { status: 'PAID' } },
    });
    await h.db.installment.update({
      where: { id: unpaid.id },
      data: { principalCents: unpaid.principalCents - 10_000 },
    });
    await monitor(p.due);
    const [alert] = await alerts('?type=books.receivable_mismatch');
    expect(alert).toMatchObject({
      severity: 'CRITICAL',
      subjectType: 'business',
      subjectId: p.businessId,
      detail: { ledgerCents: 310_000, expectedCents: 300_000, differenceCents: 10_000 },
    });
    // Put right, it clears.
    await h.db.installment.update({
      where: { id: unpaid.id },
      data: { principalCents: unpaid.principalCents },
    });
    await monitor(p.due);
    expect(await alerts('?type=books.receivable_mismatch')).toEqual([]);
  });

  it('catches a job that failed and a job that stopped running', async () => {
    await runJobsAsOf(h.app, TODAY);
    expect(await alerts()).toEqual([]);
    await h.db.jobRun.create({
      data: {
        name: 'process-payouts',
        asOf: addDays(TODAY, 1),
        ok: false,
        error: 'connection refused',
        finishedAt: new Date(),
      },
    });
    await monitor(addDays(TODAY, 1));
    expect(await alerts('?type=books.job_stale')).toMatchObject([
      { severity: 'HIGH', subjectId: 'process-payouts', detail: { error: 'connection refused' } },
    ]);

    // Two days on, only the monitor has run: every other job is behind.
    await monitor(addDays(TODAY, 2));
    const stale = await alerts('?type=books.job_stale');
    expect(stale.map((a) => a.subjectId).sort()).toEqual(
      JOB_NAMES.filter((n) => n !== 'monitor').sort(),
    );
    // A full run catches everything up and the alerts resolve.
    await runJobsAsOf(h.app, addDays(TODAY, 2));
    expect(await alerts('?type=books.job_stale')).toEqual([]);
  });

  it('catches an append-only guard that has been switched off', async () => {
    await monitor();
    expect(await alerts()).toEqual([]);
    await h.db.$executeRawUnsafe(
      'ALTER TABLE "LedgerEntry" DISABLE TRIGGER "LedgerEntry_append_only"',
    );
    try {
      await monitor();
      expect(await alerts('?type=books.append_only_triggers_missing')).toMatchObject([
        { severity: 'CRITICAL', detail: { missing: ['LedgerEntry'] } },
      ]);
    } finally {
      await h.db.$executeRawUnsafe(
        'ALTER TABLE "LedgerEntry" ENABLE TRIGGER "LedgerEntry_append_only"',
      );
    }
    await monitor();
    expect(await alerts('?type=books.append_only_triggers_missing')).toEqual([]);
    // And the guard is back: history cannot be edited.
    await fundPool(h.app, 1000);
    await expect(h.db.ledgerEntry.updateMany({ data: { amountCents: 1 } })).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('alerts from what servicing already detects', () => {
  it('turns a returned landlord payout into one alert, and never reopens it once resolved', async () => {
    await fundPool(h.app, 25_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    const due = soonDue(TODAY);
    const lease = await api.post<{ id: string }>(
      '/v1/leases',
      demoLease(businessId, {
        dueDayOfMonth: due.dueDay,
        landlordPayout: {
          accountHolderName: 'Harbor View Properties LLC',
          routingNumber: '123456789',
          accountNumberLast4: '4321',
          providerToken: 'mock_landlord_return_r03',
        },
      }),
    );
    const plan = await api.post<{ id: string }>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId,
    });
    await runJobsAsOf(h.app, due.date);
    await runJobsAsOf(h.app, addDays(due.date, 2));
    await runJobsAsOf(h.app, addDays(due.date, 2));

    const [alert] = await alerts('?type=payments.payout_returned');
    expect(alert).toMatchObject({
      severity: 'HIGH',
      subjectType: 'rent_plan',
      subjectId: plan.body.id,
      detail: { returnCode: 'R03', customerCreditCents: 310_000 },
    });
    expect(await h.db.alert.count({ where: { type: 'payments.payout_returned' } })).toBe(1);

    await reviewer().post(`/v1/admin/alerts/${alert!.id}/resolve`, {
      disposition: 'CONFIRMED',
      notes: 'Landlord closed the account. Owner is sending new details.',
    });
    await runJobsAsOf(h.app, addDays(due.date, 3));
    await runJobsAsOf(h.app, addDays(due.date, 40));
    expect(await h.db.alert.count({ where: { type: 'payments.payout_returned' } })).toBe(1);
  });

  it('opens a compliance alert as an undecided application ages, and escalates the same alert', async () => {
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const business = await api.post<{ id: string }>('/v1/businesses', {
      ...demoBusiness,
      taxIdLast4: '0000',
    });
    const link = await api.post<{ id: string }>('/v1/bank-links', {
      businessId: business.body.id,
      publicToken: 'mock_healthy_rev_48000_rent_6200',
    });
    const draft = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId: business.body.id,
      statedMonthlyRevenueCents: 4_800_000,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: RENT,
      bankLinkId: link.body.id,
    });
    const submitted = await api.post<{ status: string }>(
      `/v1/underwriting/applications/${draft.body.id}/submit`,
    );
    expect(submitted.body.status).toBe('IN_REVIEW');

    await monitor(addDays(TODAY, 19));
    expect(await alerts('?type=compliance.decision_deadline')).toEqual([]);
    await monitor(addDays(TODAY, 20));
    const [warning] = await alerts('?type=compliance.decision_deadline');
    expect(warning).toMatchObject({ severity: 'WARNING', subjectId: draft.body.id });
    const escalated = await monitor(addDays(TODAY, 30));
    expect(escalated.summary).toMatchObject({ escalated: 1 });
    const [critical] = await alerts('?type=compliance.decision_deadline');
    expect(critical).toMatchObject({ id: warning!.id, severity: 'CRITICAL' });

    // Decided, it resolves.
    await reviewer().post(`/v1/admin/applications/${draft.body.id}/review`, {
      decision: 'DECLINE',
      reasonCodes: ['DOCUMENTS_NOT_PROVIDED'],
      principalReasonCodes: ['IDENTITY_NOT_VERIFIED'],
    });
    await monitor(addDays(TODAY, 31));
    expect(await alerts('?type=compliance.decision_deadline')).toEqual([]);
  });
});

import type { OperatorPolicy } from '@cashflow/shared';
import {
  BusinessLimitView,
  CircuitBreakerStatus,
  OperatorApplicationDetail,
  OperatorBusinessDetail,
  OperatorJobs,
  OperatorLatePlans,
} from '@cashflow/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JOB_NAMES } from '../jobs/index.ts';
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
  type Session,
  type TestHarness,
} from '../test/helpers.ts';
import { CONTROLS_POLICY } from './policy.ts';

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

type ErrorBody = { error: { code: string; message: string } };

const admin = (actor = 'avery@cashflow.example') => adminClient(h.app, { role: 'admin', actor });
const reviewer = (actor = 'pat@cashflow.example') =>
  adminClient(h.app, { role: 'reviewer', actor });

const events = (eventType: string, subjectId: string) =>
  h.db.auditEvent.findMany({ where: { eventType, subjectId }, orderBy: { at: 'asc' } });

/** A business with a running plan whose first payout has gone out. */
async function fundedPlan(session: Session) {
  await fundPool(h.app, 25_000_000);
  const api = client(h.app, session);
  const approved = await approvedBusiness(h.app, session);
  const { dueDay, date } = soonDue();
  const lease = await api.post<{ id: string }>(
    '/v1/leases',
    demoLease(approved.businessId, { dueDayOfMonth: dueDay }),
  );
  const plan = await api.post<{ id: string }>('/v1/rent-plans', {
    leaseId: lease.body.id,
    applicationId: approved.applicationId,
    installmentsPerMonth: 2,
  });
  expect(plan.status).toBe(201);
  await runJobsAsOf(h.app, date);
  return { ...approved, api, leaseId: lease.body.id, planId: plan.body.id };
}

/**
 * An application the engine refers because a second user links the first user's bank
 * account, asking for `rentCents` a month.
 */
async function referredApplication(rentCents: number, bankToken: string) {
  const first = await registerUser(h.app);
  await approvedBusiness(h.app, first, { bankToken });
  const session = await registerUser(h.app);
  const api = client(h.app, session);
  const business = await api.post<{ id: string }>('/v1/businesses', {
    ...demoBusiness,
    legalName: 'Second Street Bakery LLC',
    address: { ...demoBusiness.address, line1: '9 Second St' },
  });
  const link = await api.post<{ id: string }>('/v1/bank-links', {
    businessId: business.body.id,
    publicToken: bankToken,
  });
  const application = await api.post<{ id: string }>('/v1/underwriting/applications', {
    businessId: business.body.id,
    statedMonthlyRevenueCents: 20_000_000,
    timeInBusinessMonths: 36,
    requestedMonthlyRentCents: rentCents,
    bankLinkId: link.body.id,
  });
  const submitted = await api.post<{ status: string }>(
    `/v1/underwriting/applications/${application.body.id}/submit`,
  );
  expect(submitted.body.status).toBe('IN_REVIEW');
  return { businessId: business.body.id, applicationId: application.body.id };
}

describe('pause new approvals (trip the circuit breaker by hand)', () => {
  it('is admin only, needs a reason, audits, refuses a second trip, and resets', async () => {
    const byReviewer = await reviewer().post<ErrorBody>('/v1/admin/circuit-breaker/trip', {
      reason: 'Fraud ring on the news',
    });
    expect(byReviewer.status).toBe(403);
    expect((await admin().post('/v1/admin/circuit-breaker/trip', { reason: '' })).status).toBe(400);
    expect((await admin().post('/v1/admin/circuit-breaker/trip', {})).status).toBe(400);
    expect(await h.db.circuitBreaker.count()).toBe(0);

    const tripped = await admin().post<CircuitBreakerStatus>('/v1/admin/circuit-breaker/trip', {
      reason: 'Fraud ring on the news',
    });
    expect(tripped.status).toBe(200);
    expect(CircuitBreakerStatus.parse(tripped.body)).toMatchObject({
      tripped: true,
      trippedByRule: 'manual',
      reason: 'Fraud ring on the news',
      trippedAlertId: null,
    });
    const [event] = await events('CIRCUIT_BREAKER_TRIPPED', 'new_approvals');
    expect(event).toMatchObject({ actorType: 'admin', actorId: 'avery@cashflow.example' });
    expect(event!.payload).toMatchObject({ rule: 'manual', reason: 'Fraud ring on the news' });

    const again = await admin().post<ErrorBody>('/v1/admin/circuit-breaker/trip', {
      reason: 'Twice',
    });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('BREAKER_ALREADY_TRIPPED');

    // While paused, an application the engine would approve goes to a person.
    const session = await registerUser(h.app);
    await expect(approvedBusiness(h.app, session)).rejects.toThrow(/IN_REVIEW/);

    const reset = await admin().post<CircuitBreakerStatus>('/v1/admin/circuit-breaker/reset', {
      reason: 'All clear',
    });
    expect(reset.status).toBe(200);
    expect(reset.body.tripped).toBe(false);
  });
});

describe('freeze a plan', () => {
  it('is admin only, audits, refuses a frozen or closed plan, and only an admin releases it', async () => {
    const session = await registerUser(h.app);
    const { planId } = await fundedPlan(session);

    const byReviewer = await reviewer().post<ErrorBody>(`/v1/admin/rent-plans/${planId}/freeze`, {
      reason: 'Owner said they are closing',
    });
    expect(byReviewer.status).toBe(403);
    expect(
      (await admin().post(`/v1/admin/rent-plans/${planId}/freeze`, { reason: ' ' })).status,
    ).toBe(400);
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: planId } })).advanceFrozenAt,
    ).toBeNull();

    const frozen = await admin().post<{ id: string }>(`/v1/admin/rent-plans/${planId}/freeze`, {
      reason: 'Owner said they are closing',
    });
    expect(frozen.status).toBe(200);
    const plan = await h.db.rentPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.advanceFrozenAt).not.toBeNull();
    expect(plan.advanceFrozenReason).toBe('OPERATOR_HOLD');
    const [event] = await events('PLAN_ADVANCE_FROZEN', planId);
    expect(event).toMatchObject({ actorType: 'admin', actorId: 'avery@cashflow.example' });
    expect(event!.payload).toMatchObject({
      reason: 'OPERATOR_HOLD',
      note: 'Owner said they are closing',
    });
    // A hold is an unfavorable change to existing credit: the owner gets a notice, with a
    // catalog reason and never the admin's own note.
    const notices = await h.db.adverseActionNotice.findMany({ where: { kind: 'PLAN_FROZEN' } });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      applicationId: plan.applicationId,
      decisionId: event!.id,
      reasonCodes: ['PLAN_UNDER_REVIEW'],
      generatedBy: 'admin:avery@cashflow.example',
    });
    expect(notices[0]!.text).toContain('a member of our team placed your plan');
    expect(notices[0]!.text).not.toContain('Owner said they are closing');

    const twice = await admin().post<ErrorBody>(`/v1/admin/rent-plans/${planId}/freeze`, {
      reason: 'Again',
    });
    expect(twice.status).toBe(422);
    expect(twice.body.error.code).toBe('PLAN_ALREADY_FROZEN');

    // A reviewer cannot undo a control an admin put on.
    const reviewerRelease = await reviewer().post<ErrorBody>(
      `/v1/admin/rent-plans/${planId}/release-freeze`,
      { reason: 'Looks fine' },
    );
    expect(reviewerRelease.status).toBe(403);
    expect(reviewerRelease.body.error.code).toBe('ADMIN_FREEZE');

    const released = await admin().post(`/v1/admin/rent-plans/${planId}/release-freeze`, {
      reason: 'Owner is staying open',
    });
    expect(released.status).toBe(200);
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: planId } })).advanceFrozenAt,
    ).toBeNull();

    await h.db.rentPlan.update({ where: { id: planId }, data: { status: 'CLOSED' } });
    const closed = await admin().post<ErrorBody>(`/v1/admin/rent-plans/${planId}/freeze`, {
      reason: 'Closed already',
    });
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('PLAN_CLOSED');
  });

  it('answers 404 for a plan that does not exist', async () => {
    const res = await admin().post('/v1/admin/rent-plans/nope/freeze', { reason: 'Because' });
    expect(res.status).toBe(404);
  });
});

describe('lower a business limit', () => {
  it('only lowers, is admin only, audits, binds new plans, and an admin can take it off', async () => {
    const session = await registerUser(h.app);
    await fundPool(h.app, 25_000_000);
    const approved = await approvedBusiness(h.app, session);
    const decisionLimit = approved.decision.approvedMonthlyLimitCents;
    const url = `/v1/admin/businesses/${approved.businessId}/limit`;

    const view = await reviewer().get<BusinessLimitView>(url);
    expect(view.status).toBe(200);
    expect(BusinessLimitView.parse(view.body)).toMatchObject({
      decisionLimitCents: decisionLimit,
      capCents: null,
      effectiveLimitCents: decisionLimit,
      plansAboveLimit: [],
    });

    const byReviewer = await reviewer().post(`${url}/lower`, {
      limitCents: 100_000,
      reason: 'Owner called about trouble',
    });
    expect(byReviewer.status).toBe(403);

    // Not lower: refused, whatever the amount above.
    for (const limitCents of [decisionLimit, decisionLimit + 1, 99_000_000]) {
      const res = await admin().post<ErrorBody>(`${url}/lower`, {
        limitCents,
        reason: 'Trying to raise it',
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('LIMIT_NOT_LOWER');
    }
    expect((await admin().post(`${url}/lower`, { limitCents: -1, reason: 'x y z' })).status).toBe(
      400,
    );
    expect((await admin().post(`${url}/lower`, { limitCents: 100_000 })).status).toBe(400);
    expect(await events('LIMIT_CAP_SET', approved.businessId)).toHaveLength(0);

    const lowered = await admin().post<BusinessLimitView>(`${url}/lower`, {
      limitCents: 300_000,
      reason: 'Owner called about trouble',
    });
    expect(lowered.status).toBe(200);
    expect(lowered.body).toMatchObject({
      decisionLimitCents: decisionLimit,
      capCents: 300_000,
      effectiveLimitCents: 300_000,
      capSetBy: 'avery@cashflow.example',
      capReason: 'Owner called about trouble',
    });
    const [set] = await events('LIMIT_CAP_SET', approved.businessId);
    expect(set).toMatchObject({ actorType: 'admin', actorId: 'avery@cashflow.example' });
    expect(set!.payload).toMatchObject({
      capCents: 300_000,
      previousEffectiveLimitCents: decisionLimit,
      reason: 'Owner called about trouble',
    });

    // Above the cap, below the decision: still a raise, still refused.
    const up = await admin().post<ErrorBody>(`${url}/lower`, {
      limitCents: 400_000,
      reason: 'Raise a little',
    });
    expect(up.status).toBe(422);
    expect(up.body.error.code).toBe('LIMIT_NOT_LOWER');

    // A plan on a lease above the cap is refused, though the decision would allow it.
    const api = client(h.app, session);
    const lease = await api.post<{ id: string }>('/v1/leases', demoLease(approved.businessId));
    const refused = await api.post<ErrorBody>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId: approved.applicationId,
      installmentsPerMonth: 2,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('RENT_OVER_LIMIT');

    // The business detail carries it for the console.
    const detail = await reviewer().get<OperatorBusinessDetail>(
      `/v1/admin/businesses/${approved.businessId}`,
    );
    expect(OperatorBusinessDetail.parse(detail.body).limit).toMatchObject({ capCents: 300_000 });

    const byReviewerRemove = await reviewer().post(`${url}/remove-cap`, { reason: 'Undo it' });
    expect(byReviewerRemove.status).toBe(403);
    const removed = await admin().post<BusinessLimitView>(`${url}/remove-cap`, {
      reason: 'Owner sent bank statements',
    });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ capCents: null, effectiveLimitCents: decisionLimit });
    expect(await events('LIMIT_CAP_REMOVED', approved.businessId)).toHaveLength(1);
    const again = await admin().post<ErrorBody>(`${url}/remove-cap`, { reason: 'Again' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('NO_LIMIT_CAP');

    const opened = await api.post('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId: approved.applicationId,
      installmentsPerMonth: 2,
    });
    expect(opened.status).toBe(201);
  });

  it('lists a running plan above a new cap, and leaves it running', async () => {
    const session = await registerUser(h.app);
    const { businessId, planId } = await fundedPlan(session);
    const lowered = await admin().post<BusinessLimitView>(
      `/v1/admin/businesses/${businessId}/limit/lower`,
      { limitCents: 0, reason: 'Nothing new for now' },
    );
    expect(lowered.status).toBe(200);
    expect(lowered.body.effectiveLimitCents).toBe(0);
    expect(lowered.body.plansAboveLimit.map((p) => p.id)).toEqual([planId]);
    const plan = await h.db.rentPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('ACTIVE');
    expect(plan.advanceFrozenAt).toBeNull();
  });

  it('refuses a business with nothing approved, and a business that does not exist', async () => {
    const session = await registerUser(h.app);
    const business = await client(h.app, session).post<{ id: string }>(
      '/v1/businesses',
      demoBusiness,
    );
    const res = await admin().post<ErrorBody>(
      `/v1/admin/businesses/${business.body.id}/limit/lower`,
      { limitCents: 100, reason: 'Nothing to lower' },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_LIMIT_TO_LOWER');
    expect((await reviewer().get('/v1/admin/businesses/nope/limit')).status).toBe(404);
  });
});

describe('reviewer dollar authority', () => {
  const ceiling = CONTROLS_POLICY.reviewerApprovalCeilingCents;

  it('lets a reviewer approve up to the ceiling and only an admin above it', async () => {
    const rent = ceiling + 200_000;
    const { applicationId } = await referredApplication(rent, 'mock_healthy_rev_200000_rent_12000');

    const detail = await reviewer().get<OperatorApplicationDetail>(
      `/v1/admin/applications/${applicationId}`,
    );
    expect(OperatorApplicationDetail.parse(detail.body).authority).toMatchObject({
      reviewerApprovalCeilingCents: ceiling,
    });

    const above = await reviewer().post<ErrorBody>(
      `/v1/admin/applications/${applicationId}/review`,
      {
        decision: 'APPROVE',
        reasonCodes: ['INTEGRITY_FLAG_CLEARED', 'EXPOSURE_ADJUSTED'],
        approvedMonthlyLimitCents: ceiling + 100_000,
        feeBps: 200,
      },
    );
    expect(above.status).toBe(403);
    expect(above.body.error.code).toBe('ABOVE_REVIEWER_AUTHORITY');
    expect(await h.db.applicationReview.count({ where: { applicationId } })).toBe(0);

    const byAdmin = await admin().post<{ application: { status: string } }>(
      `/v1/admin/applications/${applicationId}/review`,
      {
        decision: 'APPROVE',
        reasonCodes: ['INTEGRITY_FLAG_CLEARED', 'EXPOSURE_ADJUSTED'],
        approvedMonthlyLimitCents: ceiling + 100_000,
        feeBps: 200,
      },
    );
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.application.status).toBe('APPROVED');
  });

  it('lets a reviewer approve at the ceiling', async () => {
    const { applicationId } = await referredApplication(
      ceiling + 200_000,
      'mock_healthy_rev_200000_rent_12000',
    );
    const res = await reviewer().post<{ application: { status: string } }>(
      `/v1/admin/applications/${applicationId}/review`,
      {
        decision: 'APPROVE',
        reasonCodes: ['INTEGRITY_FLAG_CLEARED', 'EXPOSURE_ADJUSTED'],
        approvedMonthlyLimitCents: ceiling,
        feeBps: 200,
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.application.status).toBe('APPROVED');
  });

  it('shows the ceiling on the policy page', async () => {
    const res = await reviewer().get<OperatorPolicy>('/v1/admin/policy');
    const controls = res.body.sections.find((s) => s.id === 'controls')!;
    expect(controls.parameters).toContainEqual(
      expect.objectContaining({ key: 'reviewerApprovalCeilingCents', value: ceiling }),
    );
  });
});

describe('jobs view', () => {
  it('lists every job, flags one that never ran, failed, or is late', async () => {
    const empty = await reviewer().get<OperatorJobs>('/v1/admin/jobs');
    expect(empty.status).toBe(200);
    expect(OperatorJobs.parse(empty.body).jobs.map((j) => j.name)).toEqual([...JOB_NAMES]);
    expect(empty.body.jobs.every((j) => j.health === 'NEVER_RAN')).toBe(true);

    const today = new Date().toISOString().slice(0, 10);
    await runJobsAsOf(h.app, today);
    const ran = await reviewer().get<OperatorJobs>('/v1/admin/jobs');
    expect(ran.body.jobs.every((j) => j.health === 'OK')).toBe(true);
    expect(ran.body.recent.length).toBe(JOB_NAMES.length);

    // The last run of one job failed; another last succeeded a week ago.
    await h.db.jobRun.create({
      data: {
        name: 'provision',
        asOf: today,
        finishedAt: new Date(),
        ok: false,
        error: 'Error: boom\n    at somewhere',
      },
    });
    await h.db.jobRun.deleteMany({ where: { name: 'rescreen' } });
    await h.db.jobRun.create({
      data: { name: 'rescreen', asOf: '2020-01-01', finishedAt: new Date('2020-01-01'), ok: true },
    });
    const res = await reviewer().get<OperatorJobs>('/v1/admin/jobs?limit=5');
    const byName = new Map(res.body.jobs.map((j) => [j.name, j]));
    expect(byName.get('provision')).toMatchObject({ health: 'FAILED', recentFailures: 1 });
    expect(byName.get('provision')!.lastRun!.error).toBe('Error: boom');
    expect(byName.get('rescreen')).toMatchObject({ health: 'LATE', lastSuccessAsOf: '2020-01-01' });
    expect(res.body.recent).toHaveLength(5);
    expect((await reviewer().get('/v1/admin/jobs?limit=0')).status).toBe(400);
  });
});

describe('late plans view', () => {
  it('lists a plan with an installment past due, with the amount and the business', async () => {
    const session = await registerUser(h.app);
    const { businessId, planId } = await fundedPlan(session);
    const none = await reviewer().get<OperatorLatePlans>('/v1/admin/delinquency/plans');
    expect(OperatorLatePlans.parse(none.body).plans).toEqual([]);

    const installment = await h.db.installment.findFirstOrThrow({
      where: { rentPlanId: planId, payout: { status: 'PAID' } },
      orderBy: { dueDate: 'asc' },
    });
    await h.db.installment.update({
      where: { id: installment.id },
      data: { dueDate: '2020-01-01', status: 'SCHEDULED' },
    });
    const res = await reviewer().get<OperatorLatePlans>('/v1/admin/delinquency/plans');
    expect(res.body.plans).toHaveLength(1);
    expect(res.body.plans[0]).toMatchObject({
      planId,
      businessId,
      businessName: demoBusiness.legalName,
      pastDueCents: installment.totalCents,
    });
    expect(res.body.plans[0]!.daysPastDue).toBeGreaterThan(30);
  });
});

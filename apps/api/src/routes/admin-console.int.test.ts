import {
  AuditLogPage,
  OperatorApplicationDetail,
  OperatorBusinessDetail,
  OperatorBusinessList,
  OperatorEvaluation,
  OperatorPolicy,
  OperatorPortfolio,
  OperatorRentPlan,
} from '@cashflow/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { evaluationView } from '../services/operator.ts';
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
  soonDue,
  runJobsAsOf,
  type Session,
  type TestHarness,
} from '../test/helpers.ts';
import { CURRENT_POLICY } from '../underwriting/policy.ts';

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

const reviewer = (actor = 'pat@cashflow.example') =>
  adminClient(h.app, { role: 'reviewer', actor });

type ErrorBody = { error: { code: string } };

/** A business with a running plan whose first payout has gone out. */
async function fundedPlan(session: Session, overrides: Record<string, unknown> = {}) {
  const api = client(h.app, session);
  const approved = await approvedBusiness(h.app, session, { business: overrides });
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
  return { ...approved, leaseId: lease.body.id, planId: plan.body.id, paidOn: date };
}

/** A second user applying with the first user's bank account: the engine refers it. */
async function referredApplication() {
  const session = await registerUser(h.app);
  const api = client(h.app, session);
  const business = await api.post<{ id: string }>('/v1/businesses', {
    ...demoBusiness,
    legalName: 'Second Street Bakery LLC',
    address: { ...demoBusiness.address, line1: '9 Second St' },
  });
  const link = await api.post<{ id: string }>('/v1/bank-links', {
    businessId: business.body.id,
    publicToken: 'mock_healthy_rev_48000_rent_6200',
  });
  const application = await api.post<{ id: string }>('/v1/underwriting/applications', {
    businessId: business.body.id,
    statedMonthlyRevenueCents: 4_800_000,
    timeInBusinessMonths: 36,
    requestedMonthlyRentCents: 620_000,
    bankLinkId: link.body.id,
  });
  const submitted = await api.post<{ status: string }>(
    `/v1/underwriting/applications/${application.body.id}/submit`,
  );
  expect(submitted.body.status).toBe('IN_REVIEW');
  return { session, api, businessId: business.body.id, applicationId: application.body.id };
}

describe('console read routes: access', () => {
  const URLS = [
    '/v1/admin/businesses',
    '/v1/admin/businesses/x',
    '/v1/admin/businesses/x/rent-plans',
    '/v1/admin/applications/x',
    '/v1/admin/audit-log',
    '/v1/admin/portfolio',
    '/v1/admin/policy',
    '/v1/admin/policy/evaluation',
  ];

  it('refuses a customer token on every route, with or without an actor header', async () => {
    const session = await registerUser(h.app);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    // The owner's own ids, so a refusal is about the token and not a missing record.
    const urls = URLS.map((u) =>
      u
        .replace('/businesses/x', `/businesses/${businessId}`)
        .replace('/applications/x', `/applications/${applicationId}`),
    );
    for (const api of [
      client(h.app, session),
      client(h.app, session, { 'x-admin-actor': 'owner@example.com' }),
    ]) {
      for (const url of urls) {
        const res = await api.get<ErrorBody>(url);
        expect(res.status, url).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      }
    }
  });

  it('refuses no token, and a reviewer without an actor', async () => {
    const noActor = client(h.app, undefined, {
      authorization: `Bearer ${process.env.REVIEWER_API_TOKEN}`,
    });
    for (const url of URLS) {
      expect((await client(h.app).get(url)).status, url).toBe(401);
      const res = await noActor.get<ErrorBody>(url);
      expect(res.status, url).toBe(400);
      expect(res.body.error.code).toBe('ACTOR_REQUIRED');
    }
  });

  it('answers a reviewer and an admin, and 404s an unknown id', async () => {
    for (const api of [reviewer(), adminClient(h.app)]) {
      for (const url of URLS) {
        const res = await api.get(url);
        expect(res.status, url).toBe(url.includes('/x') ? 404 : 200);
      }
    }
  });

  it('writes no audit event: every route is a read', async () => {
    for (const url of URLS) await reviewer().get(url);
    expect(await h.db.auditEvent.count()).toBe(0);
  });
});

describe('GET /admin/businesses', () => {
  it('lists by name, pages by cursor, and filters by search, status, and verification', async () => {
    const names = ['Alder Florist LLC', 'Birch Books LLC', 'Cedar Cycles LLC'];
    const sessions: Session[] = [];
    for (const legalName of names) {
      const session = await registerUser(h.app, {
        email: `${legalName.split(' ')[0]!.toLowerCase()}@example.com`,
      });
      sessions.push(session);
      await client(h.app, session).post('/v1/businesses', {
        ...demoBusiness,
        legalName,
        dba: `${legalName.split(' ')[0]} Trading`,
        address: { ...demoBusiness.address, line1: `${legalName} St` },
      });
    }

    const first = await reviewer().get('/v1/admin/businesses?limit=2');
    expect(first.status).toBe(200);
    const page1 = OperatorBusinessList.parse(first.body);
    expect(page1.items.map((b) => b.legalName)).toEqual(names.slice(0, 2));
    expect(page1.nextCursor).not.toBeNull();
    const page2 = OperatorBusinessList.parse(
      (await reviewer().get(`/v1/admin/businesses?limit=2&cursor=${page1.nextCursor}`)).body,
    );
    expect(page2.items.map((b) => b.legalName)).toEqual(names.slice(2));
    expect(page2.nextCursor).toBeNull();

    const search = async (q: string) =>
      OperatorBusinessList.parse(
        (await reviewer().get(`/v1/admin/businesses?q=${encodeURIComponent(q)}`)).body,
      ).items.map((b) => b.legalName);
    expect(await search('birch')).toEqual(['Birch Books LLC']);
    expect(await search('Cedar Trading')).toEqual(['Cedar Cycles LLC']);
    expect(await search('alder@example.com')).toEqual(['Alder Florist LLC']);
    expect(await search(page1.items[1]!.id)).toEqual(['Birch Books LLC']);
    expect(await search('no such business')).toEqual([]);

    const onboarding = OperatorBusinessList.parse(
      (await reviewer().get('/v1/admin/businesses?status=ONBOARDING')).body,
    );
    expect(onboarding.items).toHaveLength(3);
    const active = OperatorBusinessList.parse(
      (await reviewer().get('/v1/admin/businesses?status=ACTIVE')).body,
    );
    expect(active.items).toHaveLength(0);
    const failed = OperatorBusinessList.parse(
      (await reviewer().get('/v1/admin/businesses?verification=FAILED')).body,
    );
    expect(failed.items).toHaveLength(0);

    expect(page1.items[0]).toMatchObject({
      ownerEmail: 'alder@example.com',
      openPlans: 0,
      worstDelinquency: null,
      latestApplicationStatus: null,
    });
    expect((await reviewer().get('/v1/admin/businesses?limit=500')).status).toBe(400);
    expect((await reviewer().get('/v1/admin/businesses?status=NOPE')).status).toBe(400);
  });
});

describe('business detail and plans', () => {
  it('shows the operator view of a business and never the payout token', async () => {
    await fundPool(h.app, 25_000_000);
    const session = await registerUser(h.app, { email: 'dana@example.com' });
    const { businessId, planId, applicationId } = await fundedPlan(session);

    const res = await reviewer().get(`/v1/admin/businesses/${businessId}`);
    expect(res.status).toBe(200);
    const detail = OperatorBusinessDetail.parse(res.body);
    expect(detail.business).toMatchObject({
      legalName: 'Blue Door Bakery LLC',
      status: 'ACTIVE',
      owner: { email: 'dana@example.com' },
    });
    expect(detail.identity.owners).toHaveLength(1);
    expect(detail.bankLinks).toHaveLength(1);
    expect(detail.leases).toHaveLength(1);
    expect(detail.leases[0]).toMatchObject({
      routingNumber: '123456789',
      accountNumberLast4: '4321',
    });
    expect(detail.applications).toHaveLength(1);
    expect(detail.applications[0]).toMatchObject({ id: applicationId, status: 'APPROVED' });
    expect(detail.applications[0]!.currentDecision).toMatchObject({
      outcome: 'APPROVED',
      kind: 'ENGINE',
      supersededAt: null,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/mock_landlord_harbor|PayoutToken|providerToken/);

    const plans = z
      .array(OperatorRentPlan)
      .parse((await reviewer().get(`/v1/admin/businesses/${businessId}/rent-plans`)).body);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      id: planId,
      landlordName: 'Harbor View Properties',
      delinquencyStatus: 'CURRENT',
      advanceFrozenAt: null,
    });
    expect(plans[0]!.payouts.some((p) => p.status === 'PAID')).toBe(true);
    expect(plans[0]!.payouts.every((p) => p.canResend === false)).toBe(true);
    expect(plans[0]!.installments.length).toBeGreaterThanOrEqual(2);
    expect(plans[0]!.installments[0]).toHaveProperty('repayments');
    expect(JSON.stringify(plans)).not.toMatch(/mock_landlord_harbor/);
  });

  it('lists a pending lease change, an open hit, and alerts about the business', async () => {
    await fundPool(h.app, 25_000_000);
    const session = await registerUser(h.app);
    const { businessId, leaseId, planId } = await fundedPlan(session);
    const changed = await client(h.app, session).patch(`/v1/leases/${leaseId}`, {
      landlordPayout: {
        accountHolderName: 'Harbor View Properties LLC',
        routingNumber: '987654321',
        accountNumberLast4: '9999',
        providerToken: 'mock_landlord_new',
      },
    });
    expect(changed.status).toBe(200);
    await h.db.alert.create({
      data: {
        type: 'test.rule',
        category: 'FRAUD',
        severity: 'HIGH',
        subjectType: 'rent_plan',
        subjectId: planId,
        title: 'About the plan',
        detail: {},
        dedupeKey: 'test:plan',
      },
    });
    await h.db.alert.create({
      data: {
        type: 'test.rule',
        category: 'FRAUD',
        severity: 'INFO',
        subjectType: 'bank_account',
        subjectId: 'elsewhere',
        title: 'Names the business in its detail',
        detail: { businessId },
        dedupeKey: 'test:detail',
      },
    });
    await h.db.alert.create({
      data: {
        type: 'test.rule',
        category: 'FRAUD',
        severity: 'INFO',
        subjectType: 'business',
        subjectId: 'another-business',
        title: 'Somebody else',
        detail: {},
        dedupeKey: 'test:other',
      },
    });

    const detail = OperatorBusinessDetail.parse(
      (await reviewer().get(`/v1/admin/businesses/${businessId}`)).body,
    );
    expect(detail.pendingLeaseChanges).toHaveLength(1);
    expect(detail.pendingLeaseChanges[0]!.proposed).toMatchObject({
      routingNumber: '987654321',
      payoutTokenChanged: true,
    });
    const titles = detail.alerts.map((a) => a.title);
    expect(titles).toContain('About the plan');
    expect(titles).toContain('Names the business in its detail');
    expect(titles).not.toContain('Somebody else');
    expect(JSON.stringify(detail)).not.toMatch(/mock_landlord_new|mock_landlord_harbor/);
  });
});

describe('GET /admin/applications/:id', () => {
  it('shows a referred application with what the engine found, which the owner cannot see', async () => {
    await approvedBusiness(h.app, await registerUser(h.app));
    const { api, applicationId, businessId } = await referredApplication();

    const res = await reviewer().get(`/v1/admin/applications/${applicationId}`);
    expect(res.status).toBe(200);
    const detail = OperatorApplicationDetail.parse(res.body);
    expect(detail.application).toMatchObject({
      id: applicationId,
      businessId,
      businessName: 'Second Street Bakery LLC',
      status: 'IN_REVIEW',
    });
    expect(detail.ageDays).toBe(0);
    expect(detail.decisionDueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const current = detail.current!;
    expect(current).toMatchObject({ outcome: 'REFER', kind: 'ENGINE', supersededAt: null });
    expect(current.recommendation).toMatchObject({
      outcome: 'APPROVED',
      approvedMonthlyLimitCents: 620_000,
    });
    expect(current.referTriggers).toEqual(['INTEGRITY:DUPLICATE_BANK_ACCOUNT']);
    expect(current.integrityFlags.map((f) => f.code)).toContain('DUPLICATE_BANK_ACCOUNT');
    expect(current.pricing).toMatchObject({ feeBps: current.recommendation.feeBps });
    expect(current.cashFlow).not.toBeNull();
    // The rebuilt factor points add up to the score the engine stored.
    expect(current.factorsMatchScore).toBe(true);
    expect(current.factors!.reduce((sum, f) => sum + f.points, 0)).toBe(current.score);
    expect(current.factors!.reduce((sum, f) => sum + f.maxPoints, 0)).toBe(100);
    expect(detail.history).toHaveLength(1);
    expect(detail.reviews).toHaveLength(0);
    expect(detail.identity.businessId).toBe(businessId);
    expect(detail.auditEvents.map((e) => e.eventType).sort()).toEqual([
      'APPLICATION_REFERRED',
      'DECISION_MADE',
    ]);

    // The owner's view of the same application is unchanged: no terms, no internals.
    const own = await api.get<{ decision: Record<string, unknown> }>(
      `/v1/underwriting/applications/${applicationId}`,
    );
    expect(own.body.decision.approvedMonthlyLimitCents).toBeNull();
    expect(own.body.decision.feeBps).toBeNull();
    expect(JSON.stringify(own.body)).not.toMatch(
      /referTriggers|integrityFlags|pdBps|recommendation|factors|DUPLICATE/,
    );
  });

  it('keeps the history after a review and names the reviewer', async () => {
    await approvedBusiness(h.app, await registerUser(h.app));
    const { applicationId } = await referredApplication();
    const reviewed = await reviewer('lee@cashflow.example').post(
      `/v1/admin/applications/${applicationId}/review`,
      { decision: 'DECLINE', reasonCodes: ['INTEGRITY_FLAG_CONFIRMED'], notes: 'Same account.' },
    );
    expect(reviewed.status).toBe(200);
    const detail = OperatorApplicationDetail.parse(
      (await reviewer().get(`/v1/admin/applications/${applicationId}`)).body,
    );
    expect(detail.application.status).toBe('DECLINED');
    expect(detail.history.map((d) => [d.kind, d.outcome, d.supersededAt === null])).toEqual([
      ['REVIEW', 'DECLINED', true],
      ['ENGINE', 'REFER', false],
    ]);
    expect(detail.current).toMatchObject({
      kind: 'REVIEW',
      isOverride: true,
      reviewer: 'lee@cashflow.example',
    });
    // The engine's recommendation is still readable on the review decision.
    expect(detail.current!.recommendation.outcome).toBe('APPROVED');
    expect(detail.reviews).toHaveLength(1);
    expect(detail.reviews[0]).toMatchObject({
      reviewer: 'lee@cashflow.example',
      notes: 'Same account.',
    });
  });

  it('adds the age and the due date to the review queue', async () => {
    await approvedBusiness(h.app, await registerUser(h.app));
    const { applicationId } = await referredApplication();
    await h.db.underwritingApplication.update({
      where: { id: applicationId },
      data: { submittedAt: new Date(Date.now() - 25 * 86_400_000) },
    });
    const queue =
      await reviewer().get<Array<{ ageDays: number; decisionDueOn: string }>>('/v1/admin/reviews');
    expect(queue.body[0]!.ageDays).toBe(25);
    const due = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect(queue.body[0]!.decisionDueOn).toBe(due);
  });
});

describe('GET /admin/audit-log', () => {
  it('lists newest first, pages, and filters by subject, event, actor, business, and date', async () => {
    await fundPool(h.app, 25_000_000);
    const session = await registerUser(h.app);
    const { businessId, applicationId, planId } = await fundedPlan(session);
    await approvedBusiness(h.app, await registerUser(h.app), {
      bankToken: 'mock_healthy_rev_52000_rent_6200',
      business: {
        legalName: 'Other Business LLC',
        address: { ...demoBusiness.address, line1: '1 Other St' },
      },
    });

    const get = async (qs: string) => {
      const res = await reviewer().get(`/v1/admin/audit-log${qs}`);
      expect(res.status, qs).toBe(200);
      return AuditLogPage.parse(res.body);
    };

    const all = await get('?limit=200');
    expect(all.items.length).toBeGreaterThan(5);
    expect(all.eventTypes).toContain('DECISION_MADE');
    expect(all.subjectTypes).toContain('rent_plan');
    const times = all.items.map((e) => e.at);
    expect(times).toEqual([...times].sort().reverse());

    // Paging walks the same list without a gap or a repeat.
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const page: z.infer<typeof AuditLogPage> = await get(
        `?limit=4${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(page.items.length).toBeLessThanOrEqual(4);
      walked.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(walked).toEqual(all.items.map((e) => e.id));

    const funded = await get('?eventType=POOL_FUNDED');
    expect(funded.items).toHaveLength(1);
    expect(funded.items[0]).toMatchObject({ actorType: 'admin', subjectType: 'system' });

    const onApplication = await get(`?subjectType=application&subjectId=${applicationId}`);
    expect(onApplication.items.length).toBeGreaterThan(0);
    expect(onApplication.items.every((e) => e.subjectId === applicationId)).toBe(true);

    const byAdmin = await get('?actorType=admin');
    expect(byAdmin.items.length).toBeGreaterThan(0);
    expect(byAdmin.items.every((e) => e.actorType === 'admin')).toBe(true);
    const byName = await get('?actor=TEST-OPERATOR');
    expect(byName.items.length).toBe(byAdmin.items.length);
    expect((await get('?actor=nobody-by-this-name')).items).toHaveLength(0);

    const business = await get(`?businessId=${businessId}&limit=200`);
    const subjects = new Set(business.items.map((e) => `${e.subjectType}:${e.subjectId}`));
    expect(subjects).toContain(`business:${businessId}`);
    expect(subjects).toContain(`application:${applicationId}`);
    expect(subjects).toContain(`rent_plan:${planId}`);
    expect(business.items.length).toBeLessThan(all.items.length);
    expect(business.items.some((e) => e.eventType === 'POOL_FUNDED')).toBe(false);

    const today = new Date().toISOString().slice(0, 10);
    expect((await get(`?from=${today}&to=${today}&limit=200`)).items.length).toBeGreaterThan(0);
    expect((await get('?to=2001-01-01')).items).toHaveLength(0);
    expect((await get('?from=2999-01-01')).items).toHaveLength(0);
    expect((await reviewer().get('/v1/admin/audit-log?from=yesterday')).status).toBe(400);
    expect((await reviewer().get('/v1/admin/audit-log?limit=0')).status).toBe(400);
  });
});

describe('GET /admin/portfolio', () => {
  it('is all zeros on an empty book', async () => {
    const res = await reviewer().get('/v1/admin/portfolio');
    expect(res.status).toBe(200);
    const book = OperatorPortfolio.parse(res.body);
    expect(book.pool).toMatchObject({ capitalCents: 0, committedCents: 0, utilizationBps: null });
    expect(book.concentration).toEqual({ industries: [], businesses: [] });
    expect(book.firstPaymentDefault.cohorts).toEqual([]);
    expect(book.plans).toEqual({ active: 0, paused: 0, closed: 0 });
  });

  it('reports pool, concentration against the policy caps, delinquency, and cohorts', async () => {
    await fundPool(h.app, 25_000_000);
    const session = await registerUser(h.app);
    const { businessId, paidOn } = await fundedPlan(session);

    const book = OperatorPortfolio.parse((await reviewer().get('/v1/admin/portfolio')).body);
    // Capital is the funding plus whatever fee the first installment has already earned.
    expect(book.pool.capitalCents).toBe(book.pool.cashCents + book.pool.receivableCents);
    expect(book.pool.capitalCents).toBeGreaterThanOrEqual(25_000_000);
    expect(book.pool.capitalCents).toBeLessThan(25_020_000);
    expect(book.pool.receivableCents).toBe(book.delinquency.receivableCents);
    expect(book.pool.receivableCents).toBeGreaterThan(0);
    expect(book.pool.committedCents).toBe(620_000);
    expect(book.pool.utilizationBps).toBe(248);
    expect(book.pool.maxUtilizationBps).toBe(CURRENT_POLICY.exposure!.maxPoolUtilizationBps);
    expect(book.plans).toEqual({ active: 1, paused: 0, closed: 0 });
    expect(book.concentration.industries).toEqual([
      {
        key: 'RESTAURANT',
        label: 'RESTAURANT',
        committedCents: 620_000,
        shareBps: 248,
        capBps: CURRENT_POLICY.exposure!.maxIndustryShareBps,
        overCap: false,
      },
    ]);
    expect(book.concentration.businesses).toEqual([
      {
        key: businessId,
        label: 'Blue Door Bakery LLC',
        committedCents: 620_000,
        shareBps: 248,
        capBps: CURRENT_POLICY.exposure!.maxSingleNameShareBps,
        overCap: false,
      },
    ]);
    expect(book.delinquency.buckets.find((b) => b.status === 'CURRENT')).toMatchObject({
      plans: 1,
      principalCents: book.pool.receivableCents,
    });
    // The first installment is not 30 days old yet, so no cohort can be judged.
    expect(book.firstPaymentDefault.cohorts).toEqual([]);

    // Age the first installment past the default window without paying it.
    await h.db.installment.updateMany({ data: { dueDate: '2020-01-05' } });
    const aged = OperatorPortfolio.parse((await reviewer().get('/v1/admin/portfolio')).body);
    expect(aged.firstPaymentDefault.cohorts).toEqual([
      { month: paidOn.slice(0, 7), plans: 1, defaults: 1, rateBps: 10_000, belowMinSample: true },
    ]);
  });
});

describe('policy and evaluation', () => {
  it('returns the numbers in force', async () => {
    const res = await reviewer().get('/v1/admin/policy');
    expect(res.status).toBe(200);
    const policy = OperatorPolicy.parse(res.body);
    expect(policy.creditPolicyVersion).toBe(CURRENT_POLICY.version);
    expect(policy.servicingPolicy).toBe('standard');
    const value = (section: string, key: string) =>
      policy.sections.find((s) => s.id === section)!.parameters.find((p) => p.key === key)!.value;
    expect(value('credit', 'minScore')).toBe(CURRENT_POLICY.minScore);
    expect(value('escalation', 'referAmountCents')).toBe(
      CURRENT_POLICY.escalation!.referAmountCents,
    );
    expect(value('servicing', 'chargeOffAfterDays')).toBe(90);
    expect(value('controls', 'decisionNoticeDays')).toBe(30);
    expect(policy.gradeTable.map((g) => g.grade)).toEqual(['A', 'B', 'C', 'D', 'F']);
    expect(policy.ladder).toEqual(CURRENT_POLICY.exposure!.ladder);
    expect(policy.pdBands.length).toBeGreaterThan(5);
    expect(policy.scorecardWeights.reduce((sum, w) => sum + w.maxPoints, 0)).toBe(100);
    expect(policy.integrityRules.map((r) => r.code)).toContain('ROUND_TRIP_DEPOSITS');
    expect(policy.returnCodes.map((r) => r.code)).toContain('R01');
    expect(policy.monitoringRules.length).toBeGreaterThan(10);
    expect(policy.provisionRates.map((r) => r.bucket)).toEqual([
      'CURRENT',
      'GRACE',
      'DELINQUENT',
      'DEFAULT',
    ]);
  });

  it('returns the gate results of the checked in baseline for the current policy', async () => {
    const res = await reviewer().get('/v1/admin/policy/evaluation');
    expect(res.status).toBe(200);
    const evaluation = OperatorEvaluation.parse(res.body);
    expect(evaluation).toMatchObject({
      available: true,
      source: 'apps/api/evals/baseline.json',
      policyVersion: CURRENT_POLICY.version,
      matchesCurrentPolicy: true,
      allPass: true,
    });
    expect(evaluation.gates.map((g) => g.id)).toEqual([
      'net_loss_base',
      'net_margin_base',
      'net_margin_mild_stress',
      'bad_rate_monotonic',
      'auc',
      'fraud_approval',
      'pool_funding',
      'approval_floor',
      'refer_rate',
    ]);
    for (const gate of evaluation.gates) {
      expect(gate.description).not.toBe(gate.id);
      expect(gate.pass).toBe(true);
    }
  });

  it('says so when there is no baseline to read', () => {
    expect(evaluationView('/nonexistent/baseline.json')).toMatchObject({
      available: false,
      gates: [],
      allPass: false,
    });
  });
});

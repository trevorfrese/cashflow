import { addDays, type IsoDate } from '@cashflow/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../context.ts';
import { todayIso } from '../dates.ts';
import { runAllJobs } from '../jobs/index.ts';
import { reunderwriteJob } from '../jobs/reunderwrite.ts';
import { ACCOUNTS } from '../ledger/accounts.ts';
import { postTransaction } from '../ledger/service.ts';
import { encodeItemId, parseScenario } from '../providers/bank-link/synthetic.ts';
import {
  approvedBusiness,
  client,
  createTestApp,
  demoBusiness,
  demoLease,
  fundPool,
  registerUser,
  resetDb,
  type Session,
  type TestHarness,
} from '../test/helpers.ts';
import { POLICY_VERSION } from '../underwriting/policy.ts';
import { CURRENT_DECISION, decisionHistory } from './decisions.ts';
import { createRentPlan } from './rent-plan.ts';

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
});

const HEALTHY = 'mock_healthy_rev_48000_rent_6200';
const RENT = 620_000;

interface ApplicationBody {
  id: string;
  status: string;
  decision: {
    id: string;
    outcome: string;
    approvedMonthlyLimitCents: number | null;
    feeBps: number | null;
    score: number | null;
    policyVersion: string;
    kind: string;
    reasons: Array<{ code: string; message: string }>;
  } | null;
}

/** A business, a bank link, and a submitted application, with every name overridable. */
async function apply(
  session: Session,
  options: {
    token?: string;
    legalName?: string;
    line1?: string;
    rentCents?: number;
    statedCents?: number;
  } = {},
) {
  const api = client(h.app, session);
  const business = await api.post<{ id: string }>('/v1/businesses', {
    ...demoBusiness,
    legalName: options.legalName ?? demoBusiness.legalName,
    address: { ...demoBusiness.address, line1: options.line1 ?? demoBusiness.address.line1 },
  });
  const link = await api.post<{ id: string }>('/v1/bank-links', {
    businessId: business.body.id,
    publicToken: options.token ?? HEALTHY,
  });
  const created = await api.post<{ id: string }>('/v1/underwriting/applications', {
    businessId: business.body.id,
    statedMonthlyRevenueCents: options.statedCents ?? 4_800_000,
    timeInBusinessMonths: 36,
    requestedMonthlyRentCents: options.rentCents ?? RENT,
    bankLinkId: link.body.id,
  });
  const submitted = await api.post<ApplicationBody>(
    `/v1/underwriting/applications/${created.body.id}/submit`,
  );
  return {
    api,
    businessId: business.body.id,
    bankLinkId: link.body.id,
    application: submitted.body,
  };
}

/** An application that the engine refers: the same bank account under a second user. */
async function referred() {
  const first = await apply(await registerUser(h.app));
  expect(first.application.status).toBe('APPROVED');
  const second = await apply(await registerUser(h.app), {
    legalName: 'Second Street Bakery LLC',
    line1: '9 Second St',
  });
  return second;
}

const admin = () => client(h.app);
const auditTypes = async (subjectType: string, subjectId: string) => {
  const res = await admin().get<Array<{ eventType: string }>>(
    `/v1/admin/audit-events?subjectType=${subjectType}&subjectId=${subjectId}`,
  );
  expect(res.status).toBe(200);
  return res.body.map((e) => e.eventType);
};

describe('decision history', () => {
  it('is append-only, and every reader sees the current decision', async () => {
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const business = await api.post<{ id: string }>('/v1/businesses', demoBusiness);
    const created = await api.post<ApplicationBody>('/v1/underwriting/applications', {
      businessId: business.body.id,
      statedMonthlyRevenueCents: 4_800_000,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: RENT,
    });
    expect(created.body.decision).toBeNull();

    const first = await api.post<ApplicationBody>(
      `/v1/underwriting/applications/${created.body.id}/submit`,
    );
    expect(first.body.status).toBe('NEEDS_INFO');
    const link = await api.post<{ id: string }>('/v1/bank-links', {
      businessId: business.body.id,
      publicToken: HEALTHY,
    });
    const second = await api.post<ApplicationBody>(
      `/v1/underwriting/applications/${created.body.id}/submit`,
      { bankLinkId: link.body.id },
    );
    expect(second.body.status).toBe('APPROVED');
    expect(second.body.decision!.id).not.toBe(first.body.decision!.id);

    // Both decisions are kept. The first is marked superseded, the second is current.
    const history = await decisionHistory(h.db, created.body.id);
    expect(history.map((d) => [d.outcome, d.supersededAt !== null, d.kind])).toEqual([
      ['NEEDS_INFO', true, 'ENGINE'],
      ['APPROVED', false, 'ENGINE'],
    ]);
    expect(history[0]!.id).toBe(first.body.decision!.id);

    // Every decision carries the policy version and a snapshot.
    for (const d of history) {
      expect(d.policyVersion).toBe(POLICY_VERSION);
      expect(d.snapshot).toMatchObject({ policyVersion: POLICY_VERSION });
    }
    expect(history[1]!.snapshot).toMatchObject({
      thresholds: { minScore: expect.any(Number) },
      integrityFlags: [],
      pricing: { pdBps: expect.any(Number), expectedLossBps: expect.any(Number) },
      inputs: { requestedMonthlyRentCents: RENT },
    });

    // Readers: the application, the list, and plan creation all use the current one.
    const fetched = await api.get<ApplicationBody>(
      `/v1/underwriting/applications/${created.body.id}`,
    );
    expect(fetched.body.decision!.id).toBe(second.body.decision!.id);
    expect(fetched.body.decision).toMatchObject({ policyVersion: POLICY_VERSION, kind: 'ENGINE' });
    const list = await api.get<ApplicationBody[]>(
      `/v1/businesses/${business.body.id}/applications`,
    );
    expect(list.body.map((a) => a.decision!.id)).toEqual([second.body.decision!.id]);

    // The applicant never sees the snapshot.
    expect(JSON.stringify(fetched.body)).not.toMatch(
      /snapshot|pdBps|expectedLoss|thresholds|minScore/,
    );

    await expect(auditTypes('application', created.body.id)).resolves.toEqual([
      'DECISION_MADE',
      'DECISION_MADE',
      'LIMIT_FEE_SET',
    ]);
  });

  it('the database allows only one current decision per application', async () => {
    const { application } = await apply(await registerUser(h.app));
    const current = await h.db.underwritingDecision.findFirstOrThrow({
      where: { applicationId: application.id, ...CURRENT_DECISION },
    });
    await expect(
      h.db.underwritingDecision.create({
        data: {
          applicationId: application.id,
          outcome: 'DECLINED',
          reasons: [],
          provider: 'test',
          policyVersion: POLICY_VERSION,
        },
      }),
    ).rejects.toThrow();
    expect(
      await h.db.underwritingDecision.count({ where: { applicationId: application.id } }),
    ).toBe(1);
    expect(current.supersededAt).toBeNull();
  });
});

describe('manual review', () => {
  it('refers an application that shares a bank account with another user, without showing terms', async () => {
    const { api, application } = await referred();
    expect(application.status).toBe('IN_REVIEW');
    expect(application.decision).toMatchObject({
      outcome: 'REFER',
      approvedMonthlyLimitCents: null,
      feeBps: null,
    });
    expect(application.decision!.reasons[0]!.code).toBe('IN_REVIEW');
    // Nothing about why it was referred reaches the applicant.
    expect(JSON.stringify(application)).not.toMatch(/DUPLICATE|INTEGRITY|referTriggers/);

    const again = await api.post<{ error: { code: string } }>(
      `/v1/underwriting/applications/${application.id}/submit`,
    );
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('APPLICATION_IN_REVIEW');

    // The operator queue shows what the engine found and what it would have offered.
    const queue = await admin().get<
      Array<{
        applicationId: string;
        recommendedOutcome: string;
        recommendedMonthlyLimitCents: number;
        recommendedFeeBps: number;
        referTriggers: string[];
        integrityFlags: Array<{ code: string; action: string }>;
      }>
    >('/v1/admin/reviews');
    expect(queue.status).toBe(200);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({
      applicationId: application.id,
      recommendedOutcome: 'APPROVED',
      recommendedMonthlyLimitCents: RENT,
      referTriggers: ['INTEGRITY:DUPLICATE_BANK_ACCOUNT'],
    });
    expect(queue.body[0]!.integrityFlags).toEqual([
      expect.objectContaining({ code: 'DUPLICATE_BANK_ACCOUNT', action: 'REFER' }),
    ]);
    await expect(auditTypes('application', application.id)).resolves.toEqual([
      'DECISION_MADE',
      'APPLICATION_REFERRED',
    ]);
  });

  it('approves at the recommended terms without an override or reason codes', async () => {
    const { api, businessId, application } = await referred();
    const res = await admin().post<{
      review: { isOverride: boolean; reviewer: string; decision: string };
      application: ApplicationBody;
    }>(`/v1/admin/applications/${application.id}/review`, {
      reviewer: 'pat@cashflow.example',
      decision: 'APPROVE',
      notes: 'Called both owners. Shared premises, separate businesses.',
    });
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({
      isOverride: false,
      reviewer: 'pat@cashflow.example',
      decision: 'APPROVE',
    });
    expect(res.body.application.status).toBe('APPROVED');
    expect(res.body.application.decision).toMatchObject({
      outcome: 'APPROVED',
      kind: 'REVIEW',
      approvedMonthlyLimitCents: RENT,
    });
    expect(res.body.application.decision!.feeBps).toBeGreaterThan(0);
    expect(res.body.application.decision!.reasons[0]!.code).toBe('APPROVED_AFTER_REVIEW');

    // The engine's decision is kept, superseded, and the applicant now sees the review's.
    const history = await decisionHistory(h.db, application.id);
    expect(history.map((d) => [d.kind, d.outcome, d.supersededAt !== null, d.isOverride])).toEqual([
      ['ENGINE', 'REFER', true, false],
      ['REVIEW', 'APPROVED', false, false],
    ]);
    const seen = await api.get<ApplicationBody>(`/v1/underwriting/applications/${application.id}`);
    expect(seen.body.decision!.kind).toBe('REVIEW');
    expect((await api.get<{ status: string }>(`/v1/businesses/${businessId}`)).body.status).toBe(
      'ACTIVE',
    );
    expect((await admin().get<unknown[]>('/v1/admin/reviews')).body).toEqual([]);
    await expect(auditTypes('application', application.id)).resolves.toEqual([
      'DECISION_MADE',
      'APPLICATION_REFERRED',
      'REVIEW_RECORDED',
      'DECISION_MADE',
      'LIMIT_FEE_SET',
    ]);
  });

  it('requires reason codes to decline what the engine would have approved, and records the override', async () => {
    const { application } = await referred();
    const url = `/v1/admin/applications/${application.id}/review`;
    const bare = await admin().post<{ error: { code: string } }>(url, {
      reviewer: 'pat@cashflow.example',
      decision: 'DECLINE',
    });
    expect(bare.status).toBe(422);
    expect(bare.body.error.code).toBe('REASON_CODES_REQUIRED');
    // Nothing was written by the refused review.
    expect(await h.db.applicationReview.count()).toBe(0);

    const res = await admin().post<{
      review: { isOverride: boolean; reasonCodes: string[] };
      application: ApplicationBody;
    }>(url, {
      reviewer: 'pat@cashflow.example',
      decision: 'DECLINE',
      reasonCodes: ['FRAUD_SUSPECTED', 'DOCUMENTS_NOT_PROVIDED'],
    });
    expect(res.status).toBe(200);
    expect(res.body.review).toMatchObject({
      isOverride: true,
      reasonCodes: ['FRAUD_SUSPECTED', 'DOCUMENTS_NOT_PROVIDED'],
    });
    expect(res.body.application.status).toBe('DECLINED');
    expect(res.body.application.decision).toMatchObject({
      outcome: 'DECLINED',
      kind: 'REVIEW',
      approvedMonthlyLimitCents: null,
      feeBps: null,
    });
    // The internal reason codes are not in what the applicant reads.
    expect(JSON.stringify(res.body.application)).not.toContain('FRAUD_SUSPECTED');
    const current = await h.db.underwritingDecision.findFirstOrThrow({
      where: { applicationId: application.id, ...CURRENT_DECISION },
    });
    expect(current.isOverride).toBe(true);
    const events = await auditTypes('application', application.id);
    expect(events).toContain('DECISION_OVERRIDDEN');
    expect(events).not.toContain('LIMIT_FEE_SET');
  });

  it('treats different terms as an override, and keeps them inside the request and the fee cap', async () => {
    const { application } = await referred();
    const url = `/v1/admin/applications/${application.id}/review`;
    const reviewer = 'pat@cashflow.example';
    const noCodes = await admin().post<{ error: { code: string } }>(url, {
      reviewer,
      decision: 'APPROVE',
      approvedMonthlyLimitCents: 400_000,
    });
    expect(noCodes.body.error.code).toBe('REASON_CODES_REQUIRED');
    const tooMuch = await admin().post<{ error: { code: string } }>(url, {
      reviewer,
      decision: 'APPROVE',
      approvedMonthlyLimitCents: RENT + 1,
      reasonCodes: ['EXPOSURE_ADJUSTED'],
    });
    expect(tooMuch.body.error.code).toBe('LIMIT_OUT_OF_RANGE');
    const tooDear = await admin().post<{ error: { code: string } }>(url, {
      reviewer,
      decision: 'APPROVE',
      feeBps: 900,
      reasonCodes: ['PRICING_ADJUSTED'],
    });
    expect(tooDear.body.error.code).toBe('FEE_OUT_OF_RANGE');

    const ok = await admin().post<{
      review: { isOverride: boolean };
      application: ApplicationBody;
    }>(url, {
      reviewer,
      decision: 'APPROVE',
      approvedMonthlyLimitCents: 400_000,
      feeBps: 250,
      reasonCodes: ['EXPOSURE_ADJUSTED', 'PRICING_ADJUSTED'],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.review.isOverride).toBe(true);
    expect(ok.body.application.decision).toMatchObject({
      approvedMonthlyLimitCents: 400_000,
      feeBps: 250,
    });
  });

  it('asks the applicant for information, after which they can resubmit', async () => {
    const { api, application } = await referred();
    const url = `/v1/admin/applications/${application.id}/review`;
    const missing = await admin().post<{ error: { code: string } }>(url, {
      reviewer: 'pat@cashflow.example',
      decision: 'REQUEST_INFO',
      reasonCodes: ['DOCUMENTS_NOT_PROVIDED'],
    });
    expect(missing.body.error.code).toBe('APPLICANT_MESSAGE_REQUIRED');
    const res = await admin().post<{ application: ApplicationBody }>(url, {
      reviewer: 'pat@cashflow.example',
      decision: 'REQUEST_INFO',
      reasonCodes: ['DOCUMENTS_NOT_PROVIDED'],
      notes: 'internal: same account as another applicant',
      applicantMessage: 'Please send a copy of your signed lease.',
    });
    expect(res.body.application.status).toBe('NEEDS_INFO');
    expect(res.body.application.decision!.reasons[0]).toMatchObject({
      code: 'INFO_REQUESTED',
      message: 'Please send a copy of your signed lease.',
    });
    expect(JSON.stringify(res.body.application)).not.toContain('internal:');
    const again = await api.post<ApplicationBody>(
      `/v1/underwriting/applications/${application.id}/submit`,
    );
    expect(again.status).toBe(200);
    expect(
      await h.db.underwritingDecision.count({ where: { applicationId: application.id } }),
    ).toBe(3);
  });

  it('lets a reviewer reconsider a decline only with terms and reason codes', async () => {
    const { application } = await apply(await registerUser(h.app), {
      token: 'mock_overdrafts_rev_9000_rent_3500',
      rentCents: 350_000,
      statedCents: 900_000,
    });
    expect(application.status).toBe('DECLINED');
    const url = `/v1/admin/applications/${application.id}/review`;
    const noTerms = await admin().post<{ error: { code: string } }>(url, {
      reviewer: 'lee@cashflow.example',
      decision: 'APPROVE',
      reasonCodes: ['COMPENSATING_FACTORS'],
    });
    expect(noTerms.body.error.code).toBe('TERMS_REQUIRED');
    const ok = await admin().post<{
      review: { isOverride: boolean };
      application: ApplicationBody;
    }>(url, {
      reviewer: 'lee@cashflow.example',
      decision: 'APPROVE',
      approvedMonthlyLimitCents: 200_000,
      feeBps: 300,
      reasonCodes: ['COMPENSATING_FACTORS'],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.review.isOverride).toBe(true);
    expect(ok.body.application).toMatchObject({ status: 'APPROVED' });
    // An approved application is no longer reviewable.
    const closed = await admin().post<{ error: { code: string } }>(url, {
      reviewer: 'lee@cashflow.example',
      decision: 'DECLINE',
      reasonCodes: ['OTHER'],
    });
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('NOT_REVIEWABLE');
  });
});

describe('exposure rules when a plan is opened', () => {
  it('refuses a plan the pool cannot take, and opens it once the pool has room', async () => {
    // $7,000 of capital against $6,200 of rent is 89% committed, over the 85% ceiling.
    await fundPool(h.app, 700_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    const lease = await api.post<{ id: string }>('/v1/leases', demoLease(businessId));
    const body = { leaseId: lease.body.id, applicationId, installmentsPerMonth: 2 };
    const refused = await api.post<{ error: { code: string; details: { blockers: string[] } } }>(
      '/v1/rent-plans',
      body,
    );
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('FUNDING_UNAVAILABLE');
    expect(refused.body.error.details.blockers).toContain('POOL_UTILIZATION');
    expect(await h.db.rentPlan.count()).toBe(0);

    await fundPool(h.app, 25_000_000);
    const opened = await api.post<{ id: string }>('/v1/rent-plans', body);
    expect(opened.status).toBe(201);
    await expect(auditTypes('rent_plan', opened.body.id)).resolves.toEqual(['PLAN_CREATED']);
  });

  it('refuses a second plan that takes the business over its aggregate cap', async () => {
    await fundPool(h.app, 100_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, bankLinkId, applicationId } = await approvedBusiness(h.app, session);
    // A second approval for a second space, decided while nothing is committed yet.
    const second = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId,
      statedMonthlyRevenueCents: demoBusiness.statedMonthlyRevenueCents,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: RENT,
      bankLinkId,
    });
    const approved = await api.post<ApplicationBody>(
      `/v1/underwriting/applications/${second.body.id}/submit`,
    );
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.decision!.approvedMonthlyLimitCents).toBe(RENT);

    const leaseA = await api.post<{ id: string }>('/v1/leases', demoLease(businessId));
    const leaseB = await api.post<{ id: string }>(
      '/v1/leases',
      demoLease(businessId, {
        landlordName: 'Second Space LLC',
        landlordPayout: {
          accountHolderName: 'Second Space LLC',
          routingNumber: '987654321',
          accountNumberLast4: '1111',
          providerToken: 'mock_landlord_second',
        },
      }),
    );
    const first = await api.post('/v1/rent-plans', {
      leaseId: leaseA.body.id,
      applicationId,
      installmentsPerMonth: 2,
    });
    expect(first.status).toBe(201);
    // $6,200 is committed. A first rung of $10,000 in total leaves $3,800.
    const over = await api.post<{ error: { code: string; details: { cap: string } } }>(
      '/v1/rent-plans',
      {
        leaseId: leaseB.body.id,
        applicationId: second.body.id,
        installmentsPerMonth: 2,
      },
    );
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('EXPOSURE_CAP_EXCEEDED');
    expect(over.body.error.details.cap).toBe('LADDER');
    expect(await h.db.rentPlan.count()).toBe(1);

    // A fresh decision made now already knows about the first plan and offers less.
    const third = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId,
      statedMonthlyRevenueCents: demoBusiness.statedMonthlyRevenueCents,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: RENT,
      bankLinkId,
    });
    const reduced = await api.post<ApplicationBody>(
      `/v1/underwriting/applications/${third.body.id}/submit`,
    );
    expect(reduced.body.decision!.approvedMonthlyLimitCents).toBe(380_000);
    expect(reduced.body.decision!.reasons[0]!.code).toBe('LIMIT_BELOW_REQUEST');
  });

  it('refuses a plan whose landlord account is the business own account', async () => {
    await fundPool(h.app, 100_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    const link = await h.db.bankLink.findFirstOrThrow({ where: { businessId } });
    const lease = await api.post<{ id: string }>(
      '/v1/leases',
      demoLease(businessId, {
        landlordPayout: {
          accountHolderName: 'Harbor View Properties LLC',
          routingNumber: '123456789',
          accountNumberLast4: '4321',
          providerToken: link.providerAccountToken,
        },
      }),
    );
    const res = await api.post<{ error: { code: string } }>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId,
      installmentsPerMonth: 2,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LANDLORD_ACCOUNT_MATCH');
  });
});

describe('audit log and append-only guards', () => {
  it('records plan creation and status changes with who did them', async () => {
    await fundPool(h.app, 25_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    const lease = await api.post<{ id: string }>('/v1/leases', demoLease(businessId));
    const plan = await api.post<{ id: string }>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId,
      installmentsPerMonth: 2,
    });
    await api.patch(`/v1/rent-plans/${plan.body.id}`, { installmentsPerMonth: 4 });
    await api.patch(`/v1/rent-plans/${plan.body.id}`, { status: 'PAUSED' });
    await api.patch(`/v1/rent-plans/${plan.body.id}`, { status: 'ACTIVE' });

    const events = await admin().get<
      Array<{
        eventType: string;
        actorType: string;
        actorId: string;
        payload: Record<string, unknown>;
      }>
    >(`/v1/admin/audit-events?subjectType=rent_plan&subjectId=${plan.body.id}`);
    expect(events.body.map((e) => e.eventType)).toEqual([
      'PLAN_CREATED',
      'PLAN_STATUS_CHANGED',
      'PLAN_STATUS_CHANGED',
    ]);
    expect(events.body.every((e) => e.actorType === 'user' && e.actorId === session.userId)).toBe(
      true,
    );
    expect(events.body[0]!.payload).toMatchObject({ monthlyRentCents: RENT, applicationId });
    expect(events.body[1]!.payload).toEqual({ from: 'ACTIVE', to: 'PAUSED' });
    expect(events.body[2]!.payload).toEqual({ from: 'PAUSED', to: 'ACTIVE' });
  });

  it('rejects any update or delete of an audit event', async () => {
    const { application } = await apply(await registerUser(h.app));
    const event = await h.db.auditEvent.findFirstOrThrow({
      where: { subjectType: 'application', subjectId: application.id },
    });
    await expect(
      h.db.auditEvent.update({ where: { id: event.id }, data: { eventType: 'TAMPERED' } }),
    ).rejects.toThrow(/append-only/);
    await expect(h.db.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(h.db.$executeRawUnsafe('DELETE FROM "AuditEvent"')).rejects.toThrow(/append-only/);
    await expect(
      h.db.$executeRawUnsafe(`UPDATE "AuditEvent" SET "actorId" = 'someone else'`),
    ).rejects.toThrow(/append-only/);
    const after = await h.db.auditEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(after).toEqual(event);
  });

  it('rejects any update or delete of ledger transactions and entries', async () => {
    await fundPool(h.app, 1_000_000);
    const entry = await h.db.ledgerEntry.findFirstOrThrow();
    const transaction = await h.db.ledgerTransaction.findFirstOrThrow();
    await expect(
      h.db.ledgerEntry.update({ where: { id: entry.id }, data: { amountCents: 1 } }),
    ).rejects.toThrow(/append-only/);
    await expect(h.db.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /append-only/,
    );
    await expect(
      h.db.ledgerTransaction.update({
        where: { id: transaction.id },
        data: { description: 'edited' },
      }),
    ).rejects.toThrow(/append-only/);
    // Deleting a transaction would cascade to its entries. Both guards refuse.
    await expect(h.db.ledgerTransaction.delete({ where: { id: transaction.id } })).rejects.toThrow(
      /append-only/,
    );
    expect(await h.db.ledgerEntry.findUniqueOrThrow({ where: { id: entry.id } })).toEqual(entry);
    // New postings still work, and the test reset (TRUNCATE) is not blocked by the triggers.
    await h.db.$transaction((tx) =>
      postTransaction(tx, {
        description: 'Test: more capital',
        entries: [
          { accountCode: ACCOUNTS.CAPITAL_POOL, direction: 'DEBIT', amountCents: 500 },
          { accountCode: ACCOUNTS.POOL_EQUITY, direction: 'CREDIT', amountCents: 500 },
        ],
      }),
    );
    await resetDb(h.db);
    expect(await h.db.ledgerEntry.count()).toBe(0);
    expect(await h.db.auditEvent.count()).toBe(0);
  });
});

describe('periodic re-underwriting', () => {
  /** First of the month `n` months before today. */
  function monthStart(n: number): IsoDate {
    const [y, m] = todayIso().split('-').map(Number) as [number, number, number];
    const total = y * 12 + (m - 1) - n;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
  }

  /** An approved business with a plan whose first rent date was two months ago. */
  async function runningPlan() {
    await fundPool(h.app, 25_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, bankLinkId, applicationId } = await approvedBusiness(h.app, session);
    const firstDue = monthStart(2);
    const lease = await api.post<{ id: string }>(
      '/v1/leases',
      demoLease(businessId, { startsOn: addDays(firstDue, -10) }),
    );
    const plan = await createRentPlan(ctx, {
      userId: session.userId,
      leaseId: lease.body.id,
      applicationId,
      installmentsPerMonth: 2,
      asOf: addDays(firstDue, -10),
    });
    return { api, businessId, bankLinkId, applicationId, planId: plan.id, firstDue };
  }

  const periodic = (applicationId: string) =>
    h.db.underwritingDecision.findMany({
      where: { applicationId, kind: 'PERIODIC_REVIEW' },
      orderBy: { reviewPeriod: 'asc' },
    });

  it('reviews a healthy plan once a month and leaves it alone', async () => {
    const { applicationId, planId, firstDue } = await runningPlan();
    const first = await reunderwriteJob(ctx, firstDue);
    expect(first.summary).toMatchObject({ plans: 1, reviewed: 1, frozen: 0, alreadyReviewed: 0 });
    // Same date again, and a later date in the same month: nothing more is written.
    const again = await reunderwriteJob(ctx, firstDue);
    const later = await reunderwriteJob(ctx, addDays(firstDue, 14));
    expect(again.summary).toMatchObject({ reviewed: 0, alreadyReviewed: 1 });
    expect(later.summary).toMatchObject({ reviewed: 0, alreadyReviewed: 1 });
    const reviews = await periodic(applicationId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      reviewPeriod: firstDue.slice(0, 7),
      policyVersion: POLICY_VERSION,
      supersededAt: null,
    });
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: planId } })).advanceFrozenAt,
    ).toBeNull();
    // The periodic review sits beside the origination decision. It does not replace it.
    const current = await h.db.underwritingDecision.findFirstOrThrow({
      where: { applicationId, ...CURRENT_DECISION },
    });
    expect(current.kind).toBe('ENGINE');
    expect(await h.db.jobRun.count({ where: { name: 'reunderwrite', ok: true } })).toBe(3);
  });

  it('freezes the next period of a deteriorated business and never interrupts a paid one', async () => {
    const { api, bankLinkId, applicationId, planId, firstDue } = await runningPlan();
    const secondDue = monthStart(1);

    // Month one: reviewed, landlord paid, first installment collected. The second period is
    // scheduled 30 days ahead.
    const one = await runAllJobs(ctx, firstDue);
    expect(one.reunderwrite.summary).toMatchObject({ reviewed: 1, frozen: 0 });
    expect(one.processPayouts.summary).toMatchObject({ paid: 1 });
    expect(one.collectInstallments.summary).toMatchObject({ paid: 1 });
    expect(await h.db.landlordPayout.count({ where: { rentPlanId: planId } })).toBe(2);

    // The business deteriorates: its account now shows repeated overdrafts.
    await h.db.bankLink.update({
      where: { id: bankLinkId },
      data: {
        providerItemId: encodeItemId(
          parseScenario('overdrafts_rev_48000_rent_6200'),
          'abcdef123456',
        ),
      },
    });

    // Month two, on the rent date. The review runs first and freezes the plan.
    const two = await runAllJobs(ctx, secondDue);
    expect(two.reunderwrite.summary).toMatchObject({ reviewed: 1, frozen: 1 });
    const plan = await h.db.rentPlan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('ACTIVE');
    expect(plan.advanceFrozenAt).not.toBeNull();
    expect(plan.advanceFrozenReason).toBeTruthy();
    expect(
      (await api.get<{ advanceFrozen: boolean }>(`/v1/rent-plans/${planId}`)).body.advanceFrozen,
    ).toBe(true);

    // The period already paid out is not interrupted: its second installment is collected.
    expect(two.collectInstallments.summary).toMatchObject({ paid: 1, failed: 0 });
    const installments = await h.db.installment.findMany({
      where: { rentPlanId: planId, periodMonth: firstDue.slice(0, 7) },
    });
    expect(installments.map((i) => i.status)).toEqual(['PAID', 'PAID']);

    // The next period is not paid, and no further period is generated.
    expect(two.processPayouts.summary).toMatchObject({ paid: 0 });
    expect(two.generatePeriods.summary).toMatchObject({ plans: 0, periodsCreated: 0 });
    const payouts = await h.db.landlordPayout.findMany({
      where: { rentPlanId: planId },
      orderBy: { scheduledFor: 'asc' },
    });
    expect(payouts.map((p) => [p.scheduledFor, p.status])).toEqual([
      [firstDue, 'PAID'],
      [secondDue, 'SCHEDULED'],
    ]);

    // Running the same date again changes nothing.
    const repeat = await runAllJobs(ctx, secondDue);
    expect(repeat.reunderwrite.summary).toMatchObject({
      reviewed: 0,
      alreadyReviewed: 1,
      frozen: 0,
    });
    expect(repeat.processPayouts.summary).toMatchObject({ paid: 0 });
    const reviews = await periodic(applicationId);
    expect(reviews.map((d) => d.reviewPeriod)).toEqual([
      firstDue.slice(0, 7),
      secondDue.slice(0, 7),
    ]);
    expect(reviews[1]!.outcome).toBe('DECLINED');
    expect(reviews[1]!.snapshot).toMatchObject({
      periodicReview: { planId, period: secondDue.slice(0, 7), watchReason: expect.any(String) },
    });

    await expect(auditTypes('rent_plan', planId)).resolves.toEqual([
      'PLAN_CREATED',
      'PLAN_ADVANCE_FROZEN',
    ]);
    // The applicant's own decision is untouched.
    const application = await api.get<ApplicationBody>(
      `/v1/underwriting/applications/${applicationId}`,
    );
    expect(application.body).toMatchObject({ status: 'APPROVED', decision: { kind: 'ENGINE' } });
  });

  it('does not review, or freeze, on a bank feed that has gone stale', async () => {
    const { applicationId, planId } = await runningPlan();
    // The sandbox bank has no transactions after today, so a review dated next month sees
    // weeks of silence. That is a stale feed, not a collapse in revenue.
    const future = addDays(todayIso(), 40);
    const res = await reunderwriteJob(ctx, future);
    expect(res.summary).toMatchObject({ plans: 1, reviewed: 1, unscored: 1, frozen: 0 });
    expect(await periodic(applicationId)).toEqual([]);
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: planId } })).advanceFrozenAt,
    ).toBeNull();
  });
});

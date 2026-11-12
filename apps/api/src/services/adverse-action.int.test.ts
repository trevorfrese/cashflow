import {
  addDays,
  AdverseActionNoticeView,
  DecisionExplanation,
  findJargon,
  OperatorApplicationDetail,
  type IsoDate,
} from '@cashflow/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { todayIso } from '../dates.ts';
import { NOTICE_POLICY } from '../adverse-action/policy.ts';
import {
  adminClient,
  client,
  createTestApp,
  demoBusiness,
  demoLease,
  fundPool,
  registerUser,
  resetDb,
  runJobsAsOf,
  type Session,
  type TestHarness,
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

const TODAY: IsoDate = todayIso();
const reviewer = () => adminClient(h.app, { role: 'reviewer', actor: 'pat@cashflow.example' });

interface AppBody {
  id: string;
  status: string;
  decision: {
    id: string;
    outcome: string;
    score: number | null;
    grade: string | null;
    approvedMonthlyLimitCents: number | null;
  } | null;
}

async function apply(
  session: Session,
  o: { token: string | null; rentCents: number; statedCents: number; legalName?: string },
) {
  const api = client(h.app, session);
  const business = await api.post<{ id: string }>('/v1/businesses', {
    ...demoBusiness,
    ...(o.legalName ? { legalName: o.legalName } : {}),
  });
  const link = o.token
    ? await api.post<{ id: string }>('/v1/bank-links', {
        businessId: business.body.id,
        publicToken: o.token,
      })
    : null;
  const created = await api.post<{ id: string }>('/v1/underwriting/applications', {
    businessId: business.body.id,
    statedMonthlyRevenueCents: o.statedCents,
    timeInBusinessMonths: 36,
    requestedMonthlyRentCents: o.rentCents,
    ...(link ? { bankLinkId: link.body.id } : {}),
  });
  const submitted = await api.post<AppBody>(
    `/v1/underwriting/applications/${created.body.id}/submit`,
  );
  return { api, businessId: business.body.id, application: submitted.body };
}

const declined = async () => {
  const r = await apply(await registerUser(h.app), {
    token: 'mock_overdrafts_rev_9000_rent_3500',
    rentCents: 350_000,
    statedCents: 900_000,
  });
  expect(r.application.status).toBe('DECLINED');
  return r;
};
const counterOffer = async (token = 'mock_healthy_rev_30000', legalName?: string) => {
  const r = await apply(await registerUser(h.app), {
    token,
    ...(legalName ? { legalName } : {}),
    rentCents: 600_000,
    statedCents: 3_000_000,
  });
  expect(r.application.status).toBe('APPROVED');
  expect(r.application.decision!.approvedMonthlyLimitCents).toBeLessThan(600_000);
  return r;
};
const incomplete = async () => {
  const r = await apply(await registerUser(h.app), {
    token: null,
    rentCents: 380_000,
    statedCents: 2_100_000,
  });
  expect(r.application.status).toBe('NEEDS_INFO');
  return r;
};

const notices = async (api: ReturnType<typeof client>, applicationId: string) => {
  const res = await api.get(`/v1/underwriting/applications/${applicationId}/notices`);
  expect(res.status).toBe(200);
  return z.array(AdverseActionNoticeView).parse(res.body);
};
const explanation = async (api: ReturnType<typeof client>, applicationId: string) => {
  const res = await api.get(`/v1/underwriting/applications/${applicationId}/explanation`);
  expect(res.status).toBe(200);
  return DecisionExplanation.parse(res.body);
};
const alerts = async (type: string) =>
  (
    await reviewer().get<{ items: Array<{ severity: string; subjectId: string; status: string }> }>(
      `/v1/admin/alerts?type=${type}`,
    )
  ).body.items;

describe('a decline', () => {
  it('stores its notice with the decision, and explains itself without the score', async () => {
    const { api, application } = await declined();
    // The decision and the notice were written together.
    const [notice] = await notices(api, application.id);
    expect(notice).toMatchObject({
      kind: 'DECLINE',
      decisionId: application.decision!.id,
      isAdverseAction: true,
      channel: 'IN_APP',
      actionOn: TODAY,
      deadlineOn: addDays(TODAY, NOTICE_POLICY.noticeDays),
      late: false,
    });
    expect(notice!.principalReasons.length).toBeGreaterThan(0);
    expect(notice!.principalReasons.length).toBeLessThanOrEqual(4);
    expect(notice!.principalReasons[0]!.code).toBe('EXCESSIVE_OVERDRAFTS');
    expect(notice!.text).toContain('Equal Credit Opportunity Act');
    expect(notice!.text).toContain('Federal Trade Commission');
    expect(notice!.text).toContain(notice!.principalReasons[0]!.text);
    const audit = await h.db.auditEvent.findMany({
      where: { subjectId: application.id, eventType: 'ADVERSE_ACTION_NOTICE_SENT' },
    });
    expect(audit).toHaveLength(1);

    // The applicant's decision carries no score on a decline.
    expect(application.decision).toMatchObject({ score: null, grade: null });
    const e = await explanation(api, application.id);
    expect(e).toMatchObject({ outcome: 'DECLINED', score: null, terms: null });
    expect(e.principalReasons.map((r) => r.code)).toEqual(
      notice!.principalReasons.map((r) => r.code),
    );
    expect(e.factors.length).toBeGreaterThan(5);
    expect(e.checks.find((c) => c.code === 'OVERDRAFTS')).toMatchObject({ passed: false });
    expect(e.dataSources).toEqual([expect.objectContaining({ kind: 'BANK', dataAsOf: TODAY })]);
    expect(e.notices).toEqual([expect.objectContaining({ id: notice!.id, kind: 'DECLINE' })]);
    // Nothing internal reaches the applicant.
    for (const text of [
      ...e.principalReasons.flatMap((r) => [r.title, r.text, r.guidance]),
      ...e.factors.flatMap((f) => [f.label, f.measures, f.detail]),
      ...e.checks.flatMap((c) => [c.label, c.detail]),
      e.headline,
      e.summary,
    ]) {
      expect(findJargon(text), text).toBeNull();
    }
    expect(JSON.stringify(e)).not.toMatch(/maxPoints|points|snapshot|referTrigger/);
  });

  it('keeps notices append only: the database refuses to change or remove one', async () => {
    const { application } = await declined();
    const row = await h.db.adverseActionNotice.findFirstOrThrow({
      where: { applicationId: application.id },
    });
    await expect(
      h.db.adverseActionNotice.update({ where: { id: row.id }, data: { text: 'edited' } }),
    ).rejects.toThrow(/append-only/);
    await expect(h.db.adverseActionNotice.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/,
    );
    // Deleting the business leaves the notice: there is no foreign key to cascade through.
    await h.db.business.delete({ where: { id: row.businessId } });
    expect(await h.db.adverseActionNotice.count({ where: { id: row.id } })).toBe(1);
  });

  it('is not given to another owner', async () => {
    const { application } = await declined();
    const other = client(h.app, await registerUser(h.app));
    expect(
      (await other.get(`/v1/underwriting/applications/${application.id}/notices`)).status,
    ).toBe(403);
    expect(
      (await other.get(`/v1/underwriting/applications/${application.id}/explanation`)).status,
    ).toBe(403);
  });
});

describe('a reviewer decline', () => {
  it('sends a notice from the reviewer catalog reasons, late if past 30 days', async () => {
    // Referred: the sandbox identity provider cannot match a tax id ending 0000.
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
      requestedMonthlyRentCents: 620_000,
      bankLinkId: link.body.id,
    });
    const submitted = await api.post<AppBody>(
      `/v1/underwriting/applications/${draft.body.id}/submit`,
    );
    expect(submitted.body.status).toBe('IN_REVIEW');
    // In review: no score, and what happens next.
    const waiting = await explanation(api, draft.body.id);
    expect(waiting).toMatchObject({ outcome: 'IN_REVIEW', score: null, principalReasons: [] });
    expect(waiting.nextSteps?.expectedBy).toBe(addDays(TODAY, 30));
    expect(await notices(api, draft.body.id)).toEqual([]);

    const res = await reviewer().post(`/v1/admin/applications/${draft.body.id}/review`, {
      decision: 'DECLINE',
      reasonCodes: ['OTHER'],
      principalReasonCodes: ['IDENTITY_NOT_VERIFIED', 'LEASE_NOT_VERIFIED'],
    });
    expect(res.status).toBe(200);
    const [notice] = await notices(api, draft.body.id);
    expect(notice!.principalReasons.map((r) => r.code)).toEqual([
      'IDENTITY_NOT_VERIFIED',
      'LEASE_NOT_VERIFIED',
    ]);
    expect(notice!.text).toContain('We could not verify the business details you gave us.');

    // The operator sees the same explanation and the notice with its full text.
    const detail = OperatorApplicationDetail.parse(
      (await reviewer().get(`/v1/admin/applications/${draft.body.id}`)).body,
    );
    expect(detail.notices).toEqual([
      expect.objectContaining({ id: notice!.id, text: notice!.text }),
    ]);
    expect(detail.explanation?.outcome).toBe('DECLINED');
    expect(detail.current?.principalReasons.map((r) => r.code)).toEqual([
      'IDENTITY_NOT_VERIFIED',
      'LEASE_NOT_VERIFIED',
    ]);
  });
});

describe('a counter offer', () => {
  it('shows the score and terms, and sends a notice only when the owner declines it', async () => {
    const { api, application } = await counterOffer();
    const e = await explanation(api, application.id);
    expect(e.outcome).toBe('COUNTER_OFFER');
    expect(e.score).not.toBeNull();
    expect(e.terms?.approvedMonthlyLimitCents).toBe(
      application.decision!.approvedMonthlyLimitCents,
    );
    expect(e.principalReasons[0]!.code).toBe('LIMIT_BELOW_REQUEST');
    expect(e.canDeclineOffer).toBe(true);
    expect(await notices(api, application.id)).toEqual([]);

    const declinedOffer = await api.post<{ id: string; kind: string; text: string }>(
      `/v1/underwriting/applications/${application.id}/decline-offer`,
    );
    expect(declinedOffer.status).toBe(200);
    expect(declinedOffer.body.kind).toBe('COUNTER_OFFER_NOT_ACCEPTED');
    expect(declinedOffer.body.text).toContain('You declined that offer');
    // Again: the same notice, not a second one.
    const again = await api.post<{ id: string }>(
      `/v1/underwriting/applications/${application.id}/decline-offer`,
    );
    expect(again.body.id).toBe(declinedOffer.body.id);
    expect((await explanation(api, application.id)).canDeclineOffer).toBe(false);
    // The job later finds it stored and adds nothing.
    await runJobsAsOf(h.app, addDays(TODAY, 40), 'adverse-action-notices');
    expect(await notices(api, application.id)).toHaveLength(1);
  });

  it('sends a notice when the offer expires unused, and none when a plan opens on it', async () => {
    await fundPool(h.app, 50_000_000);
    const expired = await counterOffer();
    const used = await counterOffer('mock_healthy_second_rev_30000', 'Second Chapter Books LLC');
    // A lease at the approved amount opens a plan: the offer was taken up.
    const lease = await used.api.post<{ id: string }>(
      '/v1/leases',
      demoLease(used.businessId, {
        monthlyRentCents: used.application.decision!.approvedMonthlyLimitCents,
      }),
    );
    const plan = await used.api.post('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId: used.application.id,
    });
    expect(plan.status, JSON.stringify(plan.body)).toBe(201);

    const open = addDays(TODAY, NOTICE_POLICY.counterOfferValidDays - 1);
    await runJobsAsOf(h.app, open, 'adverse-action-notices');
    expect(await notices(expired.api, expired.application.id)).toEqual([]);

    const expires = addDays(TODAY, NOTICE_POLICY.counterOfferValidDays);
    await runJobsAsOf(h.app, expires, 'adverse-action-notices');
    const [notice] = await notices(expired.api, expired.application.id);
    expect(notice).toMatchObject({
      kind: 'COUNTER_OFFER_NOT_ACCEPTED',
      actionOn: expires,
      deadlineOn: addDays(TODAY, NOTICE_POLICY.counterOfferNoticeDays),
      late: false,
    });
    expect(notice!.text).toContain('not taken up before it expired');
    expect(await notices(used.api, used.application.id)).toEqual([]);
  });
});

describe('an incomplete application', () => {
  it('gets a notice of incompleteness, then a closing notice if it stays incomplete', async () => {
    const { api, application } = await incomplete();
    const e = await explanation(api, application.id);
    expect(e).toMatchObject({ outcome: 'NEEDS_INFO', score: null });
    expect(e.requestedInformation.map((r) => r.code)).toEqual(['BANK_LINK_REQUIRED']);

    const ask = addDays(TODAY, NOTICE_POLICY.incompleteNoticeAfterDays);
    await runJobsAsOf(h.app, addDays(ask, -1), 'adverse-action-notices');
    expect(await notices(api, application.id)).toEqual([]);
    await runJobsAsOf(h.app, ask, 'adverse-action-notices');
    const [asked] = await notices(api, application.id);
    const respondBy = addDays(ask, NOTICE_POLICY.incompleteResponseDays);
    expect(asked).toMatchObject({
      kind: 'INCOMPLETE',
      isAdverseAction: false,
      respondBy,
      deadlineOn: addDays(TODAY, 30),
    });
    expect(asked!.text).toContain('Bank account needed');
    expect((await explanation(api, application.id)).nextSteps?.expectedBy).toBe(respondBy);

    // Running again changes nothing; past the date to respond, it is closed.
    await runJobsAsOf(h.app, respondBy, 'adverse-action-notices');
    expect(await notices(api, application.id)).toHaveLength(1);
    await runJobsAsOf(h.app, addDays(respondBy, 1), 'adverse-action-notices');
    const all = await notices(api, application.id);
    expect(all.map((n) => n.kind)).toEqual(['INCOMPLETE', 'INCOMPLETE_DECLINED']);
    expect(all[1]!.principalReasons.map((r) => r.code)).toEqual([
      'APPLICATION_INCOMPLETE',
      'BANK_LINK_REQUIRED',
    ]);
    expect(all[1]!.isAdverseAction).toBe(true);
  });

  it('sends nothing once the owner provides what was asked', async () => {
    const { api, application, businessId } = await incomplete();
    const link = await api.post<{ id: string }>('/v1/bank-links', {
      businessId,
      publicToken: 'mock_healthy_rev_21000_rent_3800',
    });
    const resubmitted = await api.post<AppBody>(
      `/v1/underwriting/applications/${application.id}/submit`,
      { bankLinkId: link.body.id },
    );
    expect(resubmitted.body.status).not.toBe('NEEDS_INFO');
    await runJobsAsOf(h.app, addDays(TODAY, 45), 'adverse-action-notices');
    const kinds = (await notices(api, application.id)).map((n) => n.kind);
    expect(kinds).not.toContain('INCOMPLETE');
  });
});

describe('monitoring', () => {
  it('alerts on a notice owed and missing, then on one delivered past its deadline', async () => {
    const { application } = await incomplete();
    // The notices job does not run: only the monitor does. The notice of incompleteness is
    // owed from day 10, so on day 11 it is missing.
    const day11 = addDays(TODAY, NOTICE_POLICY.incompleteNoticeAfterDays + 1);
    await runJobsAsOf(h.app, day11, 'monitor');
    expect(await alerts('compliance.adverse_action_notice_missing')).toMatchObject([
      { severity: 'HIGH', subjectId: application.id },
    ]);
    // Still missing past the 30 day deadline: critical.
    const day31 = addDays(TODAY, 31);
    await runJobsAsOf(h.app, day31, 'monitor');
    expect(await alerts('compliance.adverse_action_notice_missing')).toMatchObject([
      { severity: 'CRITICAL', subjectId: application.id },
    ]);
    // The job finally stores it, late. The missing alert resolves; a late one opens.
    await runJobsAsOf(h.app, day31, 'adverse-action-notices');
    await runJobsAsOf(h.app, day31, 'monitor');
    const missing = await alerts('compliance.adverse_action_notice_missing');
    expect(missing.every((a) => a.status === 'RESOLVED')).toBe(true);
    expect(await alerts('compliance.adverse_action_notice_late')).toMatchObject([
      { severity: 'HIGH', subjectId: application.id },
    ]);
  });

  it('finds a decline whose notice is missing', async () => {
    const { application } = await declined();
    // Simulate a lost notice: a second decline decision written without one.
    const current = await h.db.underwritingDecision.findFirstOrThrow({
      where: { applicationId: application.id },
    });
    await h.db.underwritingDecision.update({
      where: { id: current.id },
      data: { supersededAt: new Date() },
    });
    const { id: _id, supersededAt: _s, ...rest } = current;
    await h.db.underwritingDecision.create({
      data: {
        ...rest,
        reasons: rest.reasons as object,
        principalReasons: rest.principalReasons as object,
        cashFlow: rest.cashFlow as object,
        snapshot: rest.snapshot as object,
      },
    });
    await runJobsAsOf(h.app, addDays(TODAY, 2), 'monitor');
    expect(await alerts('compliance.adverse_action_notice_missing')).toMatchObject([
      { severity: 'HIGH', subjectId: application.id },
    ]);
  });
});

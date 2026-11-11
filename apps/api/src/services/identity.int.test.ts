import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

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

/**
 * Identity verification and sanctions screening, end to end against the sandbox identity
 * provider: what each outcome does to an application, what a hit does to a running plan,
 * and what the owner is and is not told.
 */

let h: TestHarness;

beforeAll(async () => {
  h = await createTestApp();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetDb(h.db);
  h.payments.reset();
});

const RENT = 620_000;
const HEALTHY = 'mock_healthy_rev_48000_rent_6200';

interface BusinessBody {
  id: string;
  taxIdLast4: string | null;
  owners: Array<{ id: string; fullName: string; ownershipBps: number }>;
  verification: { status: string; message: string | null };
}
interface ApplicationBody {
  id: string;
  status: string;
  decision: {
    outcome: string;
    approvedMonthlyLimitCents: number | null;
    reasons: Array<{ code: string; message: string }>;
  } | null;
}
interface HitBody {
  id: string;
  partyType: string;
  result: string;
  open: boolean;
  nameScreened: string;
  frozenRentPlanIds: string[];
  clearedBy: string | null;
}
type ErrorBody = { error: { code: string; message: string } };

const reviewer = (actor = 'pat@cashflow.example') =>
  adminClient(h.app, { role: 'reviewer', actor });

/** Create a business and submit an application on healthy bank data. */
async function apply(session: Session, business: Record<string, unknown> = {}, token = HEALTHY) {
  const api = client(h.app, session);
  const created = await api.post<BusinessBody>('/v1/businesses', { ...demoBusiness, ...business });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const link = await api.post<{ id: string }>('/v1/bank-links', {
    businessId: created.body.id,
    publicToken: token,
  });
  const draft = await api.post<{ id: string }>('/v1/underwriting/applications', {
    businessId: created.body.id,
    statedMonthlyRevenueCents: 4_800_000,
    timeInBusinessMonths: 36,
    requestedMonthlyRentCents: RENT,
    bankLinkId: link.body.id,
  });
  const submitted = await api.post<ApplicationBody>(
    `/v1/underwriting/applications/${draft.body.id}/submit`,
  );
  expect(submitted.status).toBe(200);
  const business2 = await api.get<BusinessBody>(`/v1/businesses/${created.body.id}`);
  return { api, business: business2.body, created: created.body, application: submitted.body };
}

const triggersOf = async (applicationId: string) => {
  const queue =
    await reviewer().get<Array<{ applicationId: string; referTriggers: string[] }>>(
      '/v1/admin/reviews',
    );
  return queue.body.find((q) => q.applicationId === applicationId)?.referTriggers ?? null;
};

const openHits = async (businessId: string) =>
  (await reviewer().get<HitBody[]>(`/v1/admin/screening/hits?businessId=${businessId}`)).body;

/** Words that must never reach an owner. */
const LEAK = /sanction|watchlist|screen|match|fraud|identity provider/i;

describe('business creation', () => {
  it('needs a tax id last 4 and at least one owner with a sane share', async () => {
    const api = client(h.app, await registerUser(h.app));
    const post = (body: Record<string, unknown>) =>
      api.post<ErrorBody>('/v1/businesses', { ...demoBusiness, ...body });
    expect((await post({ owners: [] })).status).toBe(400);
    expect((await post({ owners: undefined })).status).toBe(400);
    expect((await post({ taxIdLast4: '12345' })).status).toBe(400);
    expect((await post({ taxIdLast4: undefined })).status).toBe(400);
    expect(
      (await post({ owners: [{ fullName: 'Dana Rivera', title: 'Owner', ownershipBps: 0 }] }))
        .status,
    ).toBe(400);
    const tooMuch = await post({
      owners: [
        { fullName: 'Dana Rivera', title: 'Owner', ownershipBps: 6000 },
        { fullName: 'Lee Park', title: 'Partner', ownershipBps: 5000 },
      ],
    });
    expect(tooMuch.status).toBe(400);
    expect(await h.db.business.count()).toBe(0);
  });

  it('verifies and screens the business and its owners before it answers', async () => {
    const api = client(h.app, await registerUser(h.app));
    const res = await api.post<BusinessBody>('/v1/businesses', {
      ...demoBusiness,
      owners: [
        { fullName: 'Dana Rivera', title: 'Owner', ownershipBps: 6000 },
        { fullName: 'Lee Park', title: 'Partner', ownershipBps: 4000 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      taxIdLast4: '4821',
      verification: { status: 'VERIFIED', message: null },
    });
    expect(res.body.owners.map((o) => o.fullName)).toEqual(['Dana Rivera', 'Lee Park']);
    // Nothing beyond name, title and share comes back for an owner.
    expect(Object.keys(res.body.owners[0]!).sort()).toEqual([
      'fullName',
      'id',
      'ownershipBps',
      'title',
    ]);

    const row = await h.db.business.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { owners: true },
    });
    expect(row).toMatchObject({ verificationStatus: 'VERIFIED', verificationProvider: 'mock' });
    expect(row.verificationRef).toMatch(/^mock_kyb_/);
    expect(row.owners.every((o) => o.verificationStatus === 'VERIFIED')).toBe(true);
    const screenings = await h.db.screeningResult.findMany({ where: { businessId: row.id } });
    expect(screenings.map((s) => [s.partyType, s.result]).sort()).toEqual([
      ['BUSINESS', 'CLEAR'],
      ['OWNER', 'CLEAR'],
      ['OWNER', 'CLEAR'],
    ]);

    const identity = await reviewer().get<{ verificationStatus: string; owners: unknown[] }>(
      `/v1/admin/businesses/${row.id}/identity`,
    );
    expect(identity.body).toMatchObject({ verificationStatus: 'VERIFIED' });
    expect(identity.body.owners).toHaveLength(2);
  });

  it('checks again when identity fields change, and keeps an owner whose name did not', async () => {
    const api = client(h.app, await registerUser(h.app));
    const created = await api.post<BusinessBody>('/v1/businesses', demoBusiness);
    const ownerId = created.body.owners[0]!.id;
    const before = await h.db.screeningResult.count();

    // Revenue is not an identity field: nothing is rechecked.
    await api.patch(`/v1/businesses/${created.body.id}`, { statedMonthlyRevenueCents: 5_000_000 });
    expect(await h.db.screeningResult.count()).toBe(before);

    const patched = await api.patch<BusinessBody>(`/v1/businesses/${created.body.id}`, {
      taxIdLast4: '0000',
      owners: [
        { fullName: 'Dana Rivera', title: 'Managing member', ownershipBps: 5000 },
        { fullName: 'Lee Park', title: 'Partner', ownershipBps: 5000 },
      ],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.verification.status).toBe('UNDER_REVIEW');
    expect(patched.body.owners.find((o) => o.fullName === 'Dana Rivera')!.id).toBe(ownerId);
    expect(await h.db.screeningResult.count()).toBe(before + 3);
    // One current result per party: the earlier ones are superseded, not deleted.
    expect(
      await h.db.screeningResult.count({
        where: { supersededAt: null, businessId: created.body.id },
      }),
    ).toBe(3);
  });
});

describe('what verification and screening do to an application', () => {
  it('approves a verified business with clear screening', async () => {
    const { application, business } = await apply(await registerUser(h.app));
    expect(application.status).toBe('APPROVED');
    expect(business.verification.status).toBe('VERIFIED');
  });

  it('refers a business whose verification needs review, with a specific trigger', async () => {
    const { application, business } = await apply(await registerUser(h.app), {
      taxIdLast4: '0000',
    });
    expect(application.status).toBe('IN_REVIEW');
    expect(application.decision).toMatchObject({
      outcome: 'REFER',
      approvedMonthlyLimitCents: null,
    });
    expect(await triggersOf(application.id)).toEqual(['INTEGRITY:IDENTITY_NOT_VERIFIED']);
    expect(business.verification.status).toBe('UNDER_REVIEW');
    expect(business.verification.message).toMatch(/under review/i);
    expect(business.verification.message).not.toMatch(LEAK);
    expect(application.decision!.reasons[0]!.code).toBe('IN_REVIEW');
    expect(application.decision!.reasons[0]!.message).not.toMatch(LEAK);

    // A reviewer can approve it only by stating that they verified the identity.
    const url = `/v1/admin/applications/${application.id}/review`;
    const bare = await reviewer().post<ErrorBody>(url, { decision: 'APPROVE' });
    expect(bare.status).toBe(422);
    expect(bare.body.error.code).toBe('IDENTITY_NOT_VERIFIED');
    const ok = await reviewer().post<{ application: ApplicationBody }>(url, {
      decision: 'APPROVE',
      reasonCodes: ['IDENTITY_VERIFIED'],
      notes: 'EIN letter on file.',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.application.status).toBe('APPROVED');
    const row = await h.db.business.findUniqueOrThrow({ where: { id: business.id } });
    expect(row).toMatchObject({
      verificationStatus: 'VERIFIED',
      verificationReasons: ['MANUAL_REVIEW'],
    });
    const audit = await h.db.auditEvent.findMany({
      where: { eventType: 'IDENTITY_CHECKED', subjectId: business.id },
      orderBy: { at: 'asc' },
    });
    expect(audit.at(-1)).toMatchObject({ actorType: 'reviewer', actorId: 'pat@cashflow.example' });
  });

  it('declines a business whose verification failed, with a reason the owner can act on', async () => {
    const { application, business } = await apply(await registerUser(h.app), {
      legalName: 'Unverifiable Holdings LLC',
    });
    expect(application.status).toBe('DECLINED');
    expect(application.decision!.reasons[0]).toMatchObject({ code: 'IDENTITY_NOT_VERIFIED' });
    expect(application.decision!.reasons[0]!.message).toMatch(/contact support/i);
    expect(business.verification.status).toBe('UNDER_REVIEW');
  });

  it('declines when an owner cannot be verified', async () => {
    const { application } = await apply(await registerUser(h.app), {
      owners: [{ fullName: 'Pat Unverifiable', title: 'Owner', ownershipBps: 10_000 }],
    });
    expect(application.status).toBe('DECLINED');
    const row = await h.db.business.findFirstOrThrow();
    expect(row.verificationReasons).toEqual(['OWNER:IDENTITY_NOT_FOUND']);
  });

  it('refers a possible match, tells the owner only that the account is under review, and cannot be approved until the hit is cleared', async () => {
    const { application, business } = await apply(await registerUser(h.app), {
      owners: [{ fullName: 'Morgan Watchlist', title: 'Owner', ownershipBps: 10_000 }],
    });
    expect(application.status).toBe('IN_REVIEW');
    expect(await triggersOf(application.id)).toEqual(['INTEGRITY:SCREENING_POSSIBLE_MATCH']);
    expect(business.verification).toMatchObject({ status: 'UNDER_REVIEW' });
    expect(business.verification.message).not.toMatch(LEAK);
    for (const reason of application.decision!.reasons) expect(reason.message).not.toMatch(LEAK);

    const [hit] = await openHits(business.id);
    expect(hit).toMatchObject({ partyType: 'OWNER', result: 'POSSIBLE_MATCH', open: true });
    const url = `/v1/admin/applications/${application.id}/review`;
    const blocked = await reviewer().post<ErrorBody>(url, { decision: 'APPROVE' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('SCREENING_HIT_OPEN');

    const cleared = await reviewer().post<HitBody>(`/v1/admin/screening/${hit!.id}/clear`, {
      reason: 'Different date of birth and country on the list entry.',
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ open: false, clearedBy: 'pat@cashflow.example' });
    expect(await openHits(business.id)).toEqual([]);
    const audit = await h.db.auditEvent.findFirstOrThrow({
      where: { eventType: 'SCREENING_CLEARED' },
    });
    expect(audit).toMatchObject({ actorType: 'reviewer', actorId: 'pat@cashflow.example' });
    expect(audit.payload).toMatchObject({ reason: expect.stringContaining('date of birth') });

    const ok = await reviewer().post<{ application: ApplicationBody }>(url, {
      decision: 'APPROVE',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.application.status).toBe('APPROVED');
    // Cleared twice is refused.
    const again = await reviewer().post<ErrorBody>(`/v1/admin/screening/${hit!.id}/clear`, {
      reason: 'again',
    });
    expect(again.body.error.code).toBe('SCREENING_ALREADY_CLEARED');
  });

  it('holds a match in review, never declines on it, and lets only an admin clear it', async () => {
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const business = await api.post<BusinessBody>('/v1/businesses', demoBusiness);
    // The landlord, as payee, is screened when the lease is linked.
    const lease = await api.post<{ id: string }>(
      '/v1/leases',
      demoLease(business.body.id, { landlordName: 'Sanctioned Holdings Ltd' }),
    );
    expect(lease.status).toBe(201);
    const link = await api.post<{ id: string }>('/v1/bank-links', {
      businessId: business.body.id,
      publicToken: HEALTHY,
    });
    const draft = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId: business.body.id,
      statedMonthlyRevenueCents: 4_800_000,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: RENT,
      bankLinkId: link.body.id,
    });
    const submitted = await api.post<ApplicationBody>(
      `/v1/underwriting/applications/${draft.body.id}/submit`,
    );
    expect(submitted.body.status).toBe('IN_REVIEW');
    expect(await triggersOf(draft.body.id)).toEqual(['INTEGRITY:SCREENING_MATCH']);
    for (const reason of submitted.body.decision!.reasons) expect(reason.message).not.toMatch(LEAK);

    const [hit] = await openHits(business.body.id);
    expect(hit).toMatchObject({ partyType: 'LANDLORD', result: 'MATCH' });
    const refused = await reviewer().post<ErrorBody>(`/v1/admin/screening/${hit!.id}/clear`, {
      reason: 'Looks fine to me',
    });
    expect(refused.status).toBe(403);
    const cleared = await adminClient(h.app, { actor: 'chief@cashflow.example' }).post<HitBody>(
      `/v1/admin/screening/${hit!.id}/clear`,
      { reason: 'Confirmed with counsel: a different entity with the same name.' },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.body.clearedBy).toBe('chief@cashflow.example');
  });

  it('refers a business that predates verification instead of approving it', async () => {
    // A row as the migration leaves it: no tax id, no owners, never checked.
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const row = await h.db.business.create({
      data: {
        ownerUserId: session.userId,
        legalName: 'Old Mill Coffee LLC',
        industry: 'RESTAURANT',
        addressLine1: '1 Mill Rd',
        city: 'Portland',
        state: 'OR',
        postalCode: '97204',
        foundedOn: '2019-01-01',
        statedMonthlyRevenueCents: 4_800_000,
      },
    });
    const listed = await api.get<BusinessBody[]>('/v1/businesses');
    expect(listed.status).toBe(200);
    expect(listed.body[0]).toMatchObject({
      taxIdLast4: null,
      owners: [],
      verification: { status: 'NEEDS_INFO' },
    });
    const link = await api.post<{ id: string }>('/v1/bank-links', {
      businessId: row.id,
      publicToken: HEALTHY,
    });
    const draft = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId: row.id,
      statedMonthlyRevenueCents: 4_800_000,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: RENT,
      bankLinkId: link.body.id,
    });
    const submitted = await api.post<ApplicationBody>(
      `/v1/underwriting/applications/${draft.body.id}/submit`,
    );
    expect(submitted.body.status).toBe('IN_REVIEW');
    expect(await triggersOf(draft.body.id)).toEqual(['INTEGRITY:IDENTITY_NOT_VERIFIED']);
    const after = await h.db.business.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.verificationReasons.sort()).toEqual(['OWNERS_MISSING', 'TAX_ID_MISSING']);

    // Adding the missing details verifies it, and it can apply again.
    const fixed = await api.patch<BusinessBody>(`/v1/businesses/${row.id}`, {
      taxIdLast4: '4821',
      owners: [{ fullName: 'Dana Rivera', title: 'Owner', ownershipBps: 10_000 }],
    });
    expect(fixed.body.verification.status).toBe('VERIFIED');
  });
});

describe('a screening hit on a running plan', () => {
  it('freezes advances, holds the payout, and releases both when a reviewer clears it', async () => {
    await fundPool(h.app, 25_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    const due = soonDue();
    const lease = await api.post<{ id: string }>(
      '/v1/leases',
      demoLease(businessId, { dueDayOfMonth: due.dueDay }),
    );
    const plan = await api.post<{ id: string }>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId,
    });
    expect(plan.status).toBe(201);

    // A second owner is added whose name is a possible match.
    const patched = await api.patch<BusinessBody>(`/v1/businesses/${businessId}`, {
      owners: [
        { fullName: 'Dana Rivera', title: 'Owner', ownershipBps: 5000 },
        { fullName: 'Morgan Watchlist', title: 'Partner', ownershipBps: 5000 },
      ],
    });
    expect(patched.body.verification.status).toBe('UNDER_REVIEW');
    const frozen = await h.db.rentPlan.findUniqueOrThrow({ where: { id: plan.body.id } });
    expect(frozen.advanceFrozenReason).toBe('SCREENING_REVIEW');
    expect(frozen.advanceFrozenAt).not.toBeNull();

    await runJobsAsOf(h.app, due.date);
    const held = await api.get<{
      advanceFrozen: boolean;
      heldPayout: { status: string; heldReason: string; heldMessage: string } | null;
    }>(`/v1/rent-plans/${plan.body.id}`);
    expect(held.body.advanceFrozen).toBe(true);
    expect(held.body.heldPayout).toMatchObject({ status: 'HELD', heldReason: 'ADVANCE_FROZEN' });
    expect(held.body.heldPayout!.heldMessage).toMatch(/under review/i);
    expect(held.body.heldPayout!.heldMessage).not.toMatch(LEAK);
    expect(h.payments.calls.filter((c) => c.kind === 'payout')).toEqual([]);

    // The alert is open, and the freeze cannot be lifted around the hit.
    const [hit] = await openHits(businessId);
    expect(hit).toMatchObject({ partyType: 'OWNER', frozenRentPlanIds: [plan.body.id] });
    const alerts = await reviewer().get<{ items: Array<{ type: string; severity: string }> }>(
      '/v1/admin/alerts?type=fraud.screening_hit',
    );
    expect(alerts.body.items).toMatchObject([{ severity: 'HIGH' }]);
    const release = await reviewer().post<ErrorBody>(
      `/v1/admin/rent-plans/${plan.body.id}/release-freeze`,
      { reason: 'Owner called' },
    );
    expect(release.status).toBe(422);
    expect(release.body.error.code).toBe('SCREENING_HIT_OPEN');

    const cleared = await reviewer().post<HitBody>(`/v1/admin/screening/${hit!.id}/clear`, {
      reason: 'Not the listed person: different middle name and year of birth.',
    });
    expect(cleared.status).toBe(200);
    const released = await h.db.rentPlan.findUniqueOrThrow({ where: { id: plan.body.id } });
    expect(released).toMatchObject({ advanceFrozenAt: null, advanceFrozenReason: null });
    const events = await h.db.auditEvent.findMany({
      where: { subjectType: 'rent_plan', subjectId: plan.body.id },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['PLAN_ADVANCE_FROZEN', 'PAYOUT_HELD', 'PLAN_ADVANCE_RELEASED']),
    );
    expect(events.find((e) => e.eventType === 'PLAN_ADVANCE_RELEASED')).toMatchObject({
      actorType: 'reviewer',
      actorId: 'pat@cashflow.example',
    });

    // The next run pays the landlord and resolves the alert.
    await runJobsAsOf(h.app, due.date);
    const paid = await api.get<{ payouts: Array<{ status: string }>; advanceFrozen: boolean }>(
      `/v1/rent-plans/${plan.body.id}`,
    );
    expect(paid.body.payouts[0]!.status).toBe('PAID');
    const after = await reviewer().get<{ items: unknown[] }>(
      '/v1/admin/alerts?type=fraud.screening_hit',
    );
    expect(after.body.items).toEqual([]);

    // A month later the rescreen finds the same hit. The clearance carries forward: the plan
    // is not frozen again and nothing new is waiting for a reviewer.
    const later = new Date(`${due.date}T00:00:00.000Z`);
    later.setUTCDate(later.getUTCDate() + 31);
    const rescreen = await runJobsAsOf(h.app, later.toISOString().slice(0, 10), 'rescreen');
    expect(rescreen.rescreen).toMatchObject({ ok: true, summary: { hits: 0 } });
    expect(await openHits(businessId)).toEqual([]);
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: plan.body.id } })).advanceFrozenAt,
    ).toBeNull();
  });

  it('will not open a plan while a hit on the landlord is open', async () => {
    await fundPool(h.app, 25_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    const lease = await api.post<{ id: string }>(
      '/v1/leases',
      demoLease(businessId, { landlordName: 'Watchlist Realty Group' }),
    );
    const plan = await api.post<ErrorBody>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId,
    });
    expect(plan.status).toBe(422);
    expect(plan.body.error.code).toBe('ACCOUNT_UNDER_REVIEW');
    expect(plan.body.error.message).not.toMatch(LEAK);
  });
});

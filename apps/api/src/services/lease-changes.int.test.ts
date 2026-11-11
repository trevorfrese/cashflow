import { addDays, followingDueDate, type IsoDate } from '@cashflow/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../context.ts';
import { todayIso } from '../dates.ts';
import { ACCOUNTS, receivableCode } from '../ledger/accounts.ts';
import { accountBalance, trialBalance } from '../ledger/service.ts';
import {
  adminClient,
  approvedBusiness,
  client,
  createTestApp,
  demoLease,
  fundPool,
  registerUser,
  resetDb,
  runJobsAsOf,
  soonDue,
  type TestHarness,
} from '../test/helpers.ts';
import { createRentPlan } from './rent-plan.ts';

/**
 * Lease change control: a change to who a lease pays waits out a cooling-off period with
 * the payout held, a rent change follows the approval, and a returned payout can be sent
 * again once the landlord's details have been corrected.
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

const RENT = 620_000;
const TODAY = todayIso();
const COOLING_OFF_DAYS = 5;

const NEW_ACCOUNT = {
  accountHolderName: 'Harbor View Properties LLC',
  routingNumber: '021000021',
  accountNumberLast4: '9034',
  providerToken: 'mock_landlord_harbor_new_account',
};

interface LeaseBody {
  id: string;
  monthlyRentCents: number;
  landlordName: string;
  landlordPayout: { accountNumberLast4: string; routingNumber: string };
  propertyAddress: { line1: string };
  pendingChange: {
    id: string;
    status: string;
    fields: string[];
    effectiveOn: string;
    message: string;
  } | null;
  pendingRentIncrease: {
    rentPlanId: string;
    currentRentCents: number;
    requestedRentCents: number;
    message: string;
  } | null;
}
interface PlanDetail {
  monthlyRentCents: number;
  feeBps: number;
  applicationId: string;
  payouts: Array<{
    id: string;
    status: string;
    amountCents: number;
    scheduledFor: string;
    heldReason: string | null;
    heldMessage: string | null;
    returnCode: string | null;
  }>;
  heldPayout: { heldReason: string; heldMessage: string } | null;
}
interface AlertBody {
  id: string;
  type: string;
  severity: string;
  status: string;
  subjectId: string;
  disposition: string | null;
  detail: Record<string, unknown>;
}
type ErrorBody = { error: { code: string; message: string; details?: unknown } };

const reviewer = (actor = 'pat@cashflow.example') =>
  adminClient(h.app, { role: 'reviewer', actor });

const alertsOf = async (type: string, status = 'ACTIVE') =>
  (await reviewer().get<{ items: AlertBody[] }>(`/v1/admin/alerts?type=${type}&status=${status}`))
    .body.items;

const payoutTokens = () =>
  h.payments.calls
    .filter((c) => c.kind === 'payout')
    .map((c) => (c.input as { destinationToken: string }).destinationToken);

/** An approved business with a plan whose first rent date is today or in the next days. */
async function planDueSoon(leaseOverrides: Record<string, unknown> = {}) {
  await fundPool(h.app, 25_000_000);
  const session = await registerUser(h.app);
  const api = client(h.app, session);
  const { businessId, bankLinkId, applicationId } = await approvedBusiness(h.app, session);
  const due = soonDue(TODAY);
  const lease = await api.post<LeaseBody>(
    '/v1/leases',
    demoLease(businessId, { dueDayOfMonth: due.dueDay, ...leaseOverrides }),
  );
  expect(lease.status).toBe(201);
  const plan = await api.post<{ id: string }>('/v1/rent-plans', {
    leaseId: lease.body.id,
    applicationId,
  });
  expect(plan.status).toBe(201);
  const detail = () => api.get<PlanDetail>(`/v1/rent-plans/${plan.body.id}`).then((r) => r.body);
  return {
    session,
    api,
    businessId,
    bankLinkId,
    applicationId,
    leaseId: lease.body.id,
    planId: plan.body.id,
    due: due.date as IsoDate,
    detail,
  };
}

describe('a change to landlord payout details on a running plan', () => {
  it('waits out the cooling-off with the payout held and an alert open, then applies and pays the new account', async () => {
    const p = await planDueSoon();
    const patched = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      landlordPayout: NEW_ACCOUNT,
    });
    expect(patched.status).toBe(200);
    // Nothing has changed yet. The change is pending, and the owner is told until when.
    const effectiveOn = addDays(TODAY, COOLING_OFF_DAYS);
    expect(patched.body.landlordPayout.accountNumberLast4).toBe('4321');
    expect(patched.body.pendingChange).toMatchObject({
      status: 'PENDING',
      fields: ['landlordPayout'],
      effectiveOn,
    });
    expect(patched.body.pendingChange!.message).toContain(effectiveOn);
    expect(patched.body.pendingChange!.message).not.toMatch(/fraud|takeover|suspicious/i);
    const leaseRow = await h.db.lease.findUniqueOrThrow({ where: { id: p.leaseId } });
    expect(leaseRow.landlordPayoutToken).toBe('mock_landlord_harbor');

    // An audit event and an alert, at once, before any job has run.
    const requested = await h.db.auditEvent.findFirstOrThrow({
      where: { eventType: 'LEASE_CHANGE_REQUESTED', subjectId: p.leaseId },
    });
    expect(requested).toMatchObject({ actorType: 'user', actorId: p.session.userId });
    // The stored trail shows what changed and never the payout token.
    expect(JSON.stringify(requested.payload)).not.toContain('mock_landlord');
    expect(requested.payload).toMatchObject({
      previous: { landlordAccountNumberLast4: '4321', payoutTokenChanged: true },
      proposed: { landlordAccountNumberLast4: '9034' },
    });
    const [alert] = await alertsOf('fraud.landlord_change_pending');
    expect(alert).toMatchObject({ severity: 'HIGH', status: 'OPEN', subjectId: p.leaseId });
    // The proposed landlord was screened.
    const screening = await h.db.screeningResult.findFirstOrThrow({
      where: { leaseChangeId: patched.body.pendingChange!.id },
    });
    expect(screening).toMatchObject({ partyType: 'LANDLORD', result: 'CLEAR' });

    // A second change while one is pending is refused.
    const second = await p.api.patch<ErrorBody>(`/v1/leases/${p.leaseId}`, {
      landlordName: 'Someone Else LLC',
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('LEASE_CHANGE_PENDING');

    // Rent falls due inside the cooling-off: the payout is held, to either account.
    await runJobsAsOf(h.app, p.due);
    await runJobsAsOf(h.app, p.due);
    let detail = await p.detail();
    expect(detail.payouts[0]).toMatchObject({ status: 'HELD', heldReason: 'LEASE_CHANGE_PENDING' });
    expect(detail.heldPayout!.heldMessage).toMatch(/landlord's details were changed/i);
    expect(payoutTokens()).toEqual([]);
    expect(await alertsOf('fraud.landlord_change_pending')).toMatchObject([
      { id: alert!.id, severity: 'HIGH', detail: { heldPayouts: 1 } },
    ]);
    const queue = await reviewer().get<
      Array<{
        id: string;
        status: string;
        previous: Record<string, unknown>;
        proposed: Record<string, unknown>;
        affectedPayouts: Array<{ status: string }>;
        screening: { result: string; cleared: boolean };
      }>
    >('/v1/admin/lease-changes');
    expect(queue.body).toMatchObject([
      {
        status: 'PENDING',
        previous: { accountNumberLast4: '4321', payoutTokenChanged: true },
        proposed: {
          accountNumberLast4: '9034',
          routingNumber: '021000021',
          payoutTokenChanged: true,
        },
        affectedPayouts: [{ status: 'HELD' }],
        screening: { result: 'CLEAR', cleared: true },
      },
    ]);
    expect(JSON.stringify(queue.body)).not.toContain('mock_landlord');

    // The day before the period ends nothing moves.
    await runJobsAsOf(h.app, addDays(effectiveOn, -1));
    expect((await p.detail()).payouts[0]!.status).toBe('HELD');

    // On the day it ends the change applies and the payout goes to the new account.
    const run = await runJobsAsOf(h.app, effectiveOn);
    expect(run.leaseChanges).toMatchObject({ summary: { due: 1, applied: 1 } });
    detail = await p.detail();
    expect(detail.payouts[0]).toMatchObject({
      status: 'PAID',
      heldReason: null,
      heldMessage: null,
    });
    expect(payoutTokens()).toEqual([NEW_ACCOUNT.providerToken]);
    const after = await p.api.get<LeaseBody>(`/v1/leases/${p.leaseId}`);
    expect(after.body.pendingChange).toBeNull();
    expect(after.body.landlordPayout).toMatchObject({
      accountNumberLast4: '9034',
      routingNumber: '021000021',
    });
    const applied = await h.db.auditEvent.findFirstOrThrow({
      where: { eventType: 'LEASE_CHANGE_APPLIED', subjectId: p.leaseId },
    });
    expect(applied).toMatchObject({ actorType: 'job', actorId: 'lease-changes' });
    // The landlord is screened again as the payee of record.
    expect(
      await h.db.screeningResult.count({
        where: { partyType: 'LANDLORD', partyRef: p.leaseId, supersededAt: null },
      }),
    ).toBe(1);

    // The alert cleared on its own, and running the day again changes nothing.
    expect(await alertsOf('fraud.landlord_change_pending')).toEqual([]);
    const [resolved] = await alertsOf('fraud.landlord_change_pending', 'RESOLVED');
    expect(resolved).toMatchObject({ id: alert!.id, disposition: 'CONDITION_CLEARED' });
    await runJobsAsOf(h.app, effectiveOn);
    expect(payoutTokens()).toEqual([NEW_ACCOUNT.providerToken]);
    expect((await trialBalance(h.db)).balanced).toBe(true);
  });

  it('lets the owner cancel, after which rent goes to the account on file', async () => {
    const p = await planDueSoon();
    await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, { landlordPayout: NEW_ACCOUNT });

    // Someone else cannot cancel it.
    const stranger = client(h.app, await registerUser(h.app));
    expect((await stranger.post(`/v1/leases/${p.leaseId}/pending-change/cancel`)).status).toBe(403);

    const cancelled = await p.api.post<LeaseBody>(`/v1/leases/${p.leaseId}/pending-change/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.pendingChange).toBeNull();
    expect(cancelled.body.landlordPayout.accountNumberLast4).toBe('4321');
    expect(await h.db.auditEvent.count({ where: { eventType: 'LEASE_CHANGE_CANCELLED' } })).toBe(1);
    // Nothing left to cancel.
    expect((await p.api.post(`/v1/leases/${p.leaseId}/pending-change/cancel`)).status).toBe(404);

    await runJobsAsOf(h.app, p.due);
    expect((await p.detail()).payouts[0]!.status).toBe('PAID');
    expect(payoutTokens()).toEqual(['mock_landlord_harbor']);
    expect(await alertsOf('fraud.landlord_change_pending')).toEqual([]);
    // Long after the period would have ended, the change still has not applied.
    await runJobsAsOf(h.app, addDays(TODAY, COOLING_OFF_DAYS + 1), 'lease-changes');
    const row = await h.db.lease.findUniqueOrThrow({ where: { id: p.leaseId } });
    expect(row.landlordPayoutToken).toBe('mock_landlord_harbor');
  });

  it('applies early when a reviewer approves, and never when a reviewer rejects', async () => {
    const p = await planDueSoon();
    const first = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      landlordPayout: NEW_ACCOUNT,
    });
    const rejected = await reviewer().post<{ status: string; decidedBy: string }>(
      `/v1/admin/lease-changes/${first.body.pendingChange!.id}/decide`,
      { decision: 'REJECT', reason: 'Landlord says the account is not theirs.' },
    );
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'REJECTED', decidedBy: 'pat@cashflow.example' });
    expect(
      (await h.db.lease.findUniqueOrThrow({ where: { id: p.leaseId } })).landlordPayoutToken,
    ).toBe('mock_landlord_harbor');
    // Deciding it twice is refused.
    const again = await reviewer().post<ErrorBody>(
      `/v1/admin/lease-changes/${first.body.pendingChange!.id}/decide`,
      { decision: 'APPROVE', reason: 'Changed my mind' },
    );
    expect(again.body.error.code).toBe('LEASE_CHANGE_NOT_PENDING');

    const second = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      landlordPayout: NEW_ACCOUNT,
    });
    const approved = await reviewer('lee@cashflow.example').post<{ status: string }>(
      `/v1/admin/lease-changes/${second.body.pendingChange!.id}/decide`,
      { decision: 'APPROVE', reason: 'Called the landlord on the number in the lease.' },
    );
    expect(approved.body.status).toBe('APPLIED');
    const applied = await h.db.auditEvent.findFirstOrThrow({
      where: { eventType: 'LEASE_CHANGE_APPLIED' },
    });
    expect(applied).toMatchObject({ actorType: 'reviewer', actorId: 'lee@cashflow.example' });
    expect(applied.payload).toMatchObject({ early: true });

    // Applied shortly before a payout: that is watched until the payout has gone out.
    await runJobsAsOf(h.app, TODAY, 'monitor');
    expect(await alertsOf('fraud.landlord_change_before_payout')).toMatchObject([
      {
        severity: 'WARNING',
        subjectId: p.leaseId,
        detail: { approvedEarlyBy: 'lee@cashflow.example' },
      },
    ]);
    await runJobsAsOf(h.app, p.due);
    expect(payoutTokens()).toEqual([NEW_ACCOUNT.providerToken]);
    expect(await alertsOf('fraud.landlord_change_before_payout')).toEqual([]);
  });

  it('does not apply while the proposed landlord has an open screening hit', async () => {
    const p = await planDueSoon();
    const patched = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      landlordName: 'Watchlist Realty Group',
    });
    const changeId = patched.body.pendingChange!.id;
    // The current landlord is still the payee, so the plan is not frozen: the pending
    // change is what holds the payout.
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: p.planId } })).advanceFrozenAt,
    ).toBeNull();
    const approve = () =>
      reviewer().post<ErrorBody>(`/v1/admin/lease-changes/${changeId}/decide`, {
        decision: 'APPROVE',
        reason: 'Looks fine',
      });
    expect((await approve()).body.error.code).toBe('SCREENING_HIT_OPEN');

    const effectiveOn = addDays(TODAY, COOLING_OFF_DAYS);
    const run = await runJobsAsOf(h.app, effectiveOn, 'lease-changes');
    expect(run['lease-changes']).toMatchObject({ summary: { applied: 0, blockedByScreening: 1 } });
    expect((await h.db.lease.findUniqueOrThrow({ where: { id: p.leaseId } })).landlordName).toBe(
      'Harbor View Properties',
    );

    const hits = await reviewer().get<Array<{ id: string; leaseChangeId: string }>>(
      '/v1/admin/screening/hits',
    );
    expect(hits.body).toMatchObject([{ leaseChangeId: changeId }]);
    await reviewer().post(`/v1/admin/screening/${hits.body[0]!.id}/clear`, {
      reason: 'A common word in a company name, no list entry at this address.',
    });
    await runJobsAsOf(h.app, effectiveOn, 'lease-changes');
    expect((await h.db.lease.findUniqueOrThrow({ where: { id: p.leaseId } })).landlordName).toBe(
      'Watchlist Realty Group',
    );
    // The clearance carried over to the landlord as payee of record: the plan is not frozen.
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: p.planId } })).advanceFrozenAt,
    ).toBeNull();
  });

  it('applies at once when no plan is running, and for fields that do not decide who is paid', async () => {
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    // A different business and bank account from the ones `planDueSoon` uses below: the
    // same name and address, or the same account, under two users is referred.
    const { businessId } = await approvedBusiness(h.app, session, {
      bankToken: 'mock_healthy_rev_48000_rent_6200_other_account',
      business: {
        legalName: 'Second Street Bakery LLC',
        address: { line1: '9 Second St', city: 'Portland', state: 'OR', postalCode: '97204' },
      },
    });
    const lease = await api.post<LeaseBody>('/v1/leases', demoLease(businessId));
    const patched = await api.patch<LeaseBody>(`/v1/leases/${lease.body.id}`, {
      landlordName: 'Harbor View Holdings',
      landlordPayout: NEW_ACCOUNT,
    });
    expect(patched.body).toMatchObject({
      landlordName: 'Harbor View Holdings',
      pendingChange: null,
      landlordPayout: { accountNumberLast4: '9034' },
    });
    expect(await h.db.leaseChange.count()).toBe(0);
    expect(await h.db.auditEvent.count({ where: { eventType: 'LEASE_UPDATED' } })).toBe(1);

    const p = await planDueSoon();
    const address = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      propertyAddress: { line1: '500 Oak St', city: 'Portland', state: 'OR', postalCode: '97204' },
    });
    expect(address.body.propertyAddress.line1).toBe('500 Oak St');
    expect(address.body.pendingChange).toBeNull();
    // Sending back the details already on file is not a change.
    const same = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      landlordName: 'Harbor View Properties',
    });
    expect(same.body.pendingChange).toBeNull();
  });

  it('refuses a payout account that is the business own bank account', async () => {
    const p = await planDueSoon();
    const link = await h.db.bankLink.findUniqueOrThrow({ where: { id: p.bankLinkId } });
    const res = await p.api.patch<ErrorBody>(`/v1/leases/${p.leaseId}`, {
      landlordPayout: { ...NEW_ACCOUNT, providerToken: link.providerAccountToken },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LANDLORD_ACCOUNT_MATCH');
    expect(await h.db.leaseChange.count()).toBe(0);
  });
});

describe('a rent change on a running plan', () => {
  it('moves the plan and its unpaid periods to a lower rent', async () => {
    const p = await planDueSoon();
    const before = await p.detail();
    expect(before.payouts[0]).toMatchObject({ status: 'SCHEDULED', amountCents: RENT });

    const patched = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      monthlyRentCents: 500_000,
    });
    expect(patched.body).toMatchObject({ monthlyRentCents: 500_000, pendingRentIncrease: null });
    const after = await p.detail();
    expect(after.monthlyRentCents).toBe(500_000);
    expect(after.payouts[0]).toMatchObject({ status: 'SCHEDULED', amountCents: 500_000 });
    // Every period that has not been paid, and its installments, is at the new rent.
    for (const payout of after.payouts) {
      expect(payout.amountCents).toBe(500_000);
      const installments = await h.db.installment.findMany({ where: { payoutId: payout.id } });
      expect(installments).toHaveLength(2);
      expect(installments.reduce((sum, i) => sum + i.principalCents, 0)).toBe(500_000);
    }
    expect(await h.db.auditEvent.count({ where: { eventType: 'RENT_CHANGED' } })).toBe(1);

    await runJobsAsOf(h.app, p.due);
    expect((await p.detail()).payouts[0]).toMatchObject({ status: 'PAID', amountCents: 500_000 });
    expect(await accountBalance(h.db, receivableCode(p.businessId))).toBe(250_000);
  });

  it('leaves a period that has been paid at the rent it was paid at', async () => {
    const p = await planDueSoon();
    await runJobsAsOf(h.app, p.due);
    await p.api.patch(`/v1/leases/${p.leaseId}`, { monthlyRentCents: 500_000 });
    const detail = await p.detail();
    expect(detail.monthlyRentCents).toBe(500_000);
    expect(detail.payouts[0]).toMatchObject({ status: 'PAID', amountCents: RENT });
    // The next period is generated at the new rent.
    await runJobsAsOf(h.app, followingDueDate(p.due, Number(p.due.slice(8))));
    const next = (await p.detail()).payouts[1];
    expect(next).toMatchObject({ amountCents: 500_000 });
  });

  it('applies an increase the approval covers', async () => {
    // Approved for 6,200. The lease starts at 5,000 and goes to 6,000.
    const p = await planDueSoon({ monthlyRentCents: 500_000 });
    const patched = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      monthlyRentCents: 600_000,
    });
    expect(patched.body.pendingRentIncrease).toBeNull();
    const detail = await p.detail();
    expect(detail.monthlyRentCents).toBe(600_000);
    expect(detail.payouts[0]!.amountCents).toBe(600_000);
  });

  it('holds payouts on an increase over the approved limit until a new decision covers it', async () => {
    const p = await planDueSoon();
    const patched = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      monthlyRentCents: 660_000,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.monthlyRentCents).toBe(660_000);
    expect(patched.body.pendingRentIncrease).toMatchObject({
      rentPlanId: p.planId,
      currentRentCents: RENT,
      requestedRentCents: 660_000,
    });
    expect(patched.body.pendingRentIncrease!.message).toMatch(/apply/i);
    const pending = await h.db.auditEvent.findFirstOrThrow({
      where: { eventType: 'RENT_INCREASE_PENDING' },
    });
    expect(pending.payload).toMatchObject({
      reason: 'RENT_OVER_LIMIT',
      requestedRentCents: 660_000,
    });

    // The plan is unchanged, and nothing is fronted: a whole month's rent or nothing.
    let detail = await p.detail();
    expect(detail.monthlyRentCents).toBe(RENT);
    await runJobsAsOf(h.app, p.due);
    detail = await p.detail();
    expect(detail.payouts[0]).toMatchObject({
      status: 'HELD',
      heldReason: 'RENT_INCREASE_PENDING',
      amountCents: RENT,
    });
    expect(detail.heldPayout!.heldMessage).toMatch(/approved for/i);
    expect(payoutTokens()).toEqual([]);

    // A new application for the new rent. The plan waiting on it is left out of the
    // business's existing exposure, so it is judged as this lease at the higher rent.
    const draft = await p.api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId: p.businessId,
      statedMonthlyRevenueCents: 4_800_000,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: 660_000,
      bankLinkId: p.bankLinkId,
    });
    const decided = await p.api.post<{
      status: string;
      decision: { approvedMonthlyLimitCents: number; feeBps: number };
    }>(`/v1/underwriting/applications/${draft.body.id}/submit`);
    expect(decided.body.status).toBe('APPROVED');
    expect(decided.body.decision.approvedMonthlyLimitCents).toBe(660_000);

    detail = await p.detail();
    expect(detail).toMatchObject({ monthlyRentCents: 660_000, applicationId: draft.body.id });
    expect(detail.payouts[0]).toMatchObject({ status: 'HELD', amountCents: 660_000 });
    const lease = await p.api.get<LeaseBody>(`/v1/leases/${p.leaseId}`);
    expect(lease.body.pendingRentIncrease).toBeNull();

    // The held payout goes out on the next run, at the new rent.
    await runJobsAsOf(h.app, p.due);
    detail = await p.detail();
    expect(detail.payouts[0]).toMatchObject({ status: 'PAID', amountCents: 660_000 });
    expect((await trialBalance(h.db)).balanced).toBe(true);
  });

  it('clears a pending increase when the rent is put back', async () => {
    const p = await planDueSoon();
    await p.api.patch(`/v1/leases/${p.leaseId}`, { monthlyRentCents: 900_000 });
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: p.planId } })).pendingRentCents,
    ).toBe(900_000);
    const back = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      monthlyRentCents: RENT,
    });
    expect(back.body.pendingRentIncrease).toBeNull();
    await runJobsAsOf(h.app, p.due);
    expect((await p.detail()).payouts[0]).toMatchObject({ status: 'PAID', amountCents: RENT });
  });
});

describe('re-sending a returned landlord payout', () => {
  /** A plan whose first payout, five months ago, came back two days later as R03. */
  async function returnedPayout() {
    await fundPool(h.app, 25_000_000);
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    const [y, m] = TODAY.split('-').map(Number) as [number, number];
    const total = y * 12 + (m - 1) - 5;
    const d1 = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
    const lease = await api.post<LeaseBody>(
      '/v1/leases',
      demoLease(businessId, {
        startsOn: addDays(d1, -10),
        landlordPayout: {
          accountHolderName: 'Harbor View Properties LLC',
          routingNumber: '123456789',
          accountNumberLast4: '4321',
          providerToken: 'mock_landlord_return_r03',
        },
      }),
    );
    const plan = await createRentPlan(ctx, {
      userId: session.userId,
      leaseId: lease.body.id,
      applicationId,
      installmentsPerMonth: 2,
      asOf: addDays(d1, -10),
    });
    await runJobsAsOf(h.app, d1);
    await runJobsAsOf(h.app, addDays(d1, 2));
    const payout = await h.db.landlordPayout.findFirstOrThrow({ where: { rentPlanId: plan.id } });
    expect(payout).toMatchObject({ status: 'FAILED', returnCode: 'R03' });
    return { api, businessId, leaseId: lease.body.id, planId: plan.id, payoutId: payout.id, d1 };
  }

  it('is refused until corrected details have cleared the cooling-off, then pays the new account', async () => {
    const p = await returnedPayout();
    // The first installment was collected on the rent date, before the return: a credit.
    expect(await accountBalance(h.db, receivableCode(p.businessId))).toBe(-310_000);
    const pool = await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL);
    const resend = () =>
      reviewer().post<ErrorBody & { status?: string; returnCode?: string | null }>(
        `/v1/admin/payouts/${p.payoutId}/resend`,
        { reason: 'Landlord confirmed the new account by phone.' },
      );

    const notCorrected = await resend();
    expect(notCorrected.status).toBe(422);
    expect(notCorrected.body.error.code).toBe('LANDLORD_DETAILS_NOT_CORRECTED');

    // The owner corrects the account. It is a pending change like any other.
    const patched = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      landlordPayout: NEW_ACCOUNT,
    });
    expect(patched.body.pendingChange).not.toBeNull();
    const pending = await resend();
    expect(pending.status).toBe(422);
    expect(pending.body.error.code).toBe('LEASE_CHANGE_PENDING');

    await reviewer().post(`/v1/admin/lease-changes/${patched.body.pendingChange!.id}/decide`, {
      decision: 'APPROVE',
      reason: 'Voided check received from the landlord.',
    });
    const sent = await resend();
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'PAID', returnCode: null });
    expect(payoutTokens()).toEqual(['mock_landlord_return_r03', NEW_ACCOUNT.providerToken]);

    // The second send is its own posting. The credit is used up: the business owes the
    // installment that had been voided, and nothing else.
    const row = await h.db.landlordPayout.findUniqueOrThrow({ where: { id: p.payoutId } });
    expect(row.resendCount).toBe(1);
    expect(
      await h.db.ledgerTransaction.count({
        where: { idempotencyKey: `payout:${p.payoutId}:resend:1` },
      }),
    ).toBe(1);
    expect(await accountBalance(h.db, receivableCode(p.businessId))).toBe(310_000);
    expect(await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL)).toBe(pool - RENT);
    const installments = await h.db.installment.findMany({
      where: { payoutId: p.payoutId },
      orderBy: { sequence: 'asc' },
    });
    expect(installments.map((i) => i.status)).toEqual(['PAID', 'SCHEDULED']);
    expect(installments[1]!.dueDate >= TODAY).toBe(true);
    const audit = await h.db.auditEvent.findFirstOrThrow({ where: { eventType: 'PAYOUT_RESENT' } });
    expect(audit).toMatchObject({ actorType: 'reviewer', actorId: 'pat@cashflow.example' });
    expect(audit.payload).toMatchObject({ previousReturnCode: 'R03', installmentsRestored: 1 });

    // Sending it a second time is refused, the plan stays frozen until a reviewer releases
    // it, and the books agree with the installments.
    expect((await resend()).body.error.code).toBe('PAYOUT_NOT_RETURNED');
    expect(
      (await h.db.rentPlan.findUniqueOrThrow({ where: { id: p.planId } })).advanceFrozenReason,
    ).toBe('PAYOUT_RETURNED');
    expect((await trialBalance(h.db)).balanced).toBe(true);
    await runJobsAsOf(h.app, TODAY, 'monitor');
    expect(await alertsOf('books.receivable_mismatch')).toEqual([]);
  });

  it('reverses the right posting if the payout that was sent again comes back too', async () => {
    const p = await returnedPayout();
    const patched = await p.api.patch<LeaseBody>(`/v1/leases/${p.leaseId}`, {
      landlordPayout: NEW_ACCOUNT,
    });
    await reviewer().post(`/v1/admin/lease-changes/${patched.body.pendingChange!.id}/decide`, {
      decision: 'APPROVE',
      reason: 'Voided check received.',
    });
    const sent = await reviewer().post<{ providerRef: string }>(
      `/v1/admin/payouts/${p.payoutId}/resend`,
      { reason: 'Corrected account.' },
    );
    expect(sent.status).toBe(200);
    const pool = await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL);

    h.payments.scheduleReturn(sent.body.providerRef, 'R02', addDays(TODAY, 2));
    await runJobsAsOf(h.app, addDays(TODAY, 2), 'reconcile-payments');
    const row = await h.db.landlordPayout.findUniqueOrThrow({ where: { id: p.payoutId } });
    expect(row).toMatchObject({ status: 'FAILED', returnCode: 'R02', resendCount: 1 });
    expect(await accountBalance(h.db, ACCOUNTS.CAPITAL_POOL)).toBe(pool + RENT);
    expect(await accountBalance(h.db, receivableCode(p.businessId))).toBe(-310_000);
    expect(
      await h.db.ledgerTransaction.count({
        where: { idempotencyKey: `payout:${p.payoutId}:resend:1:return` },
      }),
    ).toBe(1);
    expect((await trialBalance(h.db)).balanced).toBe(true);
  });

  it('is refused for a payout that never came back', async () => {
    const p = await planDueSoon();
    await runJobsAsOf(h.app, p.due);
    const paid = await h.db.landlordPayout.findFirstOrThrow({ where: { rentPlanId: p.planId } });
    const res = await reviewer().post<ErrorBody>(`/v1/admin/payouts/${paid.id}/resend`, {
      reason: 'Why not',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYOUT_NOT_RETURNED');
  });
});

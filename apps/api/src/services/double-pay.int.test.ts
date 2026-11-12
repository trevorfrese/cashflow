import { addDays } from '@cashflow/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../context.ts';
import { runAllJobs } from '../jobs/index.ts';
import { processPayoutsJob } from '../jobs/process-payouts.ts';
import { trialBalance } from '../ledger/service.ts';
import {
  adminClient,
  approvedBusiness,
  client,
  createTestApp,
  demoLease,
  fundPool,
  registerUser,
  resetDb,
  soonDue,
  type TestHarness,
} from '../test/helpers.ts';
import { processPayout } from './payouts.ts';

/**
 * The double-pay hazard: a held landlord payout that is released must never pay the same
 * month twice, however many times it is released and however many payout runs reach it at
 * once. The guard is in the database: a partial unique index allows one SENT
 * `LandlordDisbursement` per lease and month, claimed before the provider is called, and the
 * payout row is locked for the transaction.
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

async function heldPayout() {
  await fundPool(h.app, 25_000_000);
  const session = await registerUser(h.app);
  const api = client(h.app, session);
  const { businessId, applicationId } = await approvedBusiness(h.app, session);
  const { dueDay, date } = soonDue();
  const lease = await api.post<{ id: string }>(
    '/v1/leases',
    demoLease(businessId, { dueDayOfMonth: dueDay }),
  );
  const plan = await api.post<{ id: string }>('/v1/rent-plans', {
    leaseId: lease.body.id,
    applicationId,
    installmentsPerMonth: 2,
  });
  expect(plan.status).toBe(201);
  // A reviewer freezes the plan before the due date, so the payout is held when it falls due.
  await h.db.rentPlan.update({
    where: { id: plan.body.id },
    data: { advanceFrozenAt: new Date(), advanceFrozenReason: 'PERIODIC_REVIEW' },
  });
  await runAllJobs(ctx, date);
  const payout = await h.db.landlordPayout.findFirstOrThrow({
    where: { rentPlanId: plan.body.id },
  });
  expect(payout).toMatchObject({ status: 'HELD', heldReason: 'ADVANCE_FROZEN' });
  return {
    planId: plan.body.id,
    leaseId: lease.body.id,
    payout,
    date,
    businessId,
    session,
    applicationId,
  };
}

const landlordPayoutCalls = () => h.payments.calls.filter((c) => c.kind === 'payout');

describe('double-pay hazard', () => {
  it('a payout released twice and run twice, at once and again, pays once and posts once', async () => {
    const { planId, payout, date } = await heldPayout();
    const admin = adminClient(h.app);

    // Released, and released again: the second is refused, nothing is undone.
    const first = await admin.post(`/v1/admin/rent-plans/${planId}/release-freeze`, {
      reason: 'reviewed',
    });
    expect(first.status).toBe(200);
    const second = await admin.post(`/v1/admin/rent-plans/${planId}/release-freeze`, {
      reason: 'reviewed again',
    });
    expect(second.status).toBe(422);

    // Two payout runs reach the payout at the same moment, then two more one after another.
    const releasedOn = addDays(date, 1);
    const concurrent = await Promise.all([
      processPayout(ctx, payout.id, releasedOn),
      processPayout(ctx, payout.id, releasedOn),
    ]);
    expect(concurrent.sort()).toEqual(['paid', 'skipped']);
    for (let i = 0; i < 2; i++) {
      const run = await processPayoutsJob(ctx, releasedOn);
      expect(run.ok).toBe(true);
    }
    await runAllJobs(ctx, releasedOn);

    expect(landlordPayoutCalls()).toHaveLength(1);
    const postings = await h.db.ledgerTransaction.findMany({
      where: { referenceType: 'landlord_payout', referenceId: payout.id },
    });
    expect(postings).toHaveLength(1);
    expect(postings[0]!.idempotencyKey).toBe(`payout:${payout.id}`);
    const disbursements = await h.db.landlordDisbursement.findMany();
    expect(disbursements).toMatchObject([
      { sourceId: payout.id, periodMonth: payout.periodMonth, status: 'SENT' },
    ]);
    const paid = await h.db.landlordPayout.findUniqueOrThrow({ where: { id: payout.id } });
    expect(paid.status).toBe('PAID');
    expect((await trialBalance(h.db)).balanced).toBe(true);
  });

  it('a second plan on the same lease cannot pay the same month, and the database refuses a second payment row', async () => {
    const { planId, leaseId, payout, date, businessId, session, applicationId } =
      await heldPayout();
    await adminClient(h.app).post(`/v1/admin/rent-plans/${planId}/release-freeze`, {
      reason: 'reviewed',
    });
    await runAllJobs(ctx, addDays(date, 1));
    expect(landlordPayoutCalls()).toHaveLength(1);

    // A paused plan holds the lease: the API will not open another plan on it.
    await h.db.rentPlan.update({ where: { id: planId }, data: { status: 'PAUSED' } });
    const refused = await client(h.app, session).post('/v1/rent-plans', {
      leaseId,
      applicationId,
      installmentsPerMonth: 2,
    });
    expect(refused.status).toBe(409);

    // Written around the API: a second plan with a payout for the same month.
    const twin = await h.db.rentPlan.create({
      data: {
        businessId,
        leaseId,
        applicationId,
        feeBps: 200,
        monthlyRentCents: payout.amountCents,
        dueDayOfMonth: 1,
        payouts: {
          create: {
            periodMonth: payout.periodMonth,
            amountCents: payout.amountCents,
            scheduledFor: payout.scheduledFor,
          },
        },
      },
      include: { payouts: true },
    });
    const outcome = await processPayout(ctx, twin.payouts[0]!.id, addDays(date, 1));
    expect(outcome).toBe('cancelled');
    expect(landlordPayoutCalls()).toHaveLength(1);
    const cancelled = await h.db.landlordPayout.findUniqueOrThrow({
      where: { id: twin.payouts[0]!.id },
    });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', heldReason: 'PERIOD_ALREADY_PAID' });
    expect(
      await h.db.auditEvent.count({ where: { eventType: 'DUPLICATE_PAYOUT_PREVENTED' } }),
    ).toBe(1);

    // The index itself: a second SENT row for the lease and month is rejected.
    await expect(
      h.db.landlordDisbursement.create({
        data: {
          leaseId,
          periodMonth: payout.periodMonth,
          rentPlanId: twin.id,
          kind: 'FINANCED',
          sourceId: twin.payouts[0]!.id,
          idempotencyKey: 'manual-second-send',
          amountCents: payout.amountCents,
          effectiveDate: date,
        },
      }),
    ).rejects.toThrow();
    expect((await trialBalance(h.db)).balanced).toBe(true);
  });
});

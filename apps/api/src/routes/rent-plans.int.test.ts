import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  approvedBusiness,
  client,
  createTestApp,
  demoLease,
  registerUser,
  resetDb,
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

describe('rent plan settings', () => {
  it('changes the cadence, pauses and resumes, and stays private to the owner', async () => {
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const { businessId, applicationId } = await approvedBusiness(h.app, session);
    const lease = await api.post<{ id: string }>('/v1/leases', demoLease(businessId));
    const plan = await api.post<{ id: string; installmentsPerMonth: number }>('/v1/rent-plans', {
      leaseId: lease.body.id,
      applicationId,
      installmentsPerMonth: 2,
    });
    expect(plan.status).toBe(201);

    const four = await api.patch<{ installmentsPerMonth: number; status: string }>(
      `/v1/rent-plans/${plan.body.id}`,
      { installmentsPerMonth: 4 },
    );
    expect(four.status).toBe(200);
    expect(four.body.installmentsPerMonth).toBe(4);
    expect(four.body.status).toBe('ACTIVE');

    const paused = await api.patch<{ status: string }>(`/v1/rent-plans/${plan.body.id}`, {
      status: 'PAUSED',
    });
    expect(paused.body.status).toBe('PAUSED');
    const detail = await api.get<{ status: string; installmentsPerMonth: number }>(
      `/v1/rent-plans/${plan.body.id}`,
    );
    expect(detail.body.status).toBe('PAUSED');
    expect(detail.body.installmentsPerMonth).toBe(4);

    const resumed = await api.patch<{ status: string }>(`/v1/rent-plans/${plan.body.id}`, {
      status: 'ACTIVE',
    });
    expect(resumed.body.status).toBe('ACTIVE');

    const stranger = client(h.app, await registerUser(h.app));
    const denied = await stranger.patch(`/v1/rent-plans/${plan.body.id}`, { status: 'PAUSED' });
    expect(denied.status).toBe(403);

    const bad = await api.patch<{ error: { code: string } }>(`/v1/rent-plans/${plan.body.id}`, {
      installmentsPerMonth: 7,
    });
    expect(bad.status).toBe(400);
  });
});

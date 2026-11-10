import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  client,
  createTestApp,
  demoBusiness,
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

describe('underwriting', () => {
  it('needs info without a bank link, then approves once one is attached', async () => {
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const business = await api.post<{ id: string; status: string }>('/v1/businesses', demoBusiness);
    expect(business.status).toBe(201);
    expect(business.body.status).toBe('ONBOARDING');

    const application = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId: business.body.id,
      statedMonthlyRevenueCents: 4_800_000,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: 620_000,
    });
    const needsInfo = await api.post<{
      status: string;
      decision: { reasons: Array<{ code: string }> };
    }>(`/v1/underwriting/applications/${application.body.id}/submit`);
    expect(needsInfo.body.status).toBe('NEEDS_INFO');
    expect(needsInfo.body.decision.reasons[0]?.code).toBe('BANK_LINK_REQUIRED');

    const link = await api.post<{ id: string; institutionName: string }>('/v1/bank-links', {
      businessId: business.body.id,
      publicToken: 'mock_public_token',
    });
    expect(link.status).toBe(201);
    expect(link.body.institutionName).toBeTruthy();

    const approved = await api.post<{
      status: string;
      decision: { feeBps: number; approvedMonthlyLimitCents: number };
    }>(`/v1/underwriting/applications/${application.body.id}/submit`, { bankLinkId: link.body.id });
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.decision.feeBps).toBe(250);
    expect(approved.body.decision.approvedMonthlyLimitCents).toBe(1_200_000);

    const refreshed = await api.get<{ status: string }>(`/v1/businesses/${business.body.id}`);
    expect(refreshed.body.status).toBe('ACTIVE');

    const again = await api.post<{ error: { code: string } }>(
      `/v1/underwriting/applications/${application.body.id}/submit`,
    );
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('APPLICATION_FINAL');
  });

  it('declines a young business with reasons', async () => {
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const business = await api.post<{ id: string }>('/v1/businesses', demoBusiness);
    const link = await api.post<{ id: string }>('/v1/bank-links', {
      businessId: business.body.id,
      publicToken: 'mock_low_balance',
    });
    const application = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId: business.body.id,
      statedMonthlyRevenueCents: 1_000_000,
      timeInBusinessMonths: 6,
      requestedMonthlyRentCents: 400_000,
      bankLinkId: link.body.id,
    });
    const declined = await api.post<{
      status: string;
      decision: { reasons: Array<{ code: string }> };
    }>(`/v1/underwriting/applications/${application.body.id}/submit`);
    expect(declined.body.status).toBe('DECLINED');
    expect(declined.body.decision.reasons.map((r) => r.code).sort()).toEqual([
      'LOW_BALANCE',
      'RENT_TO_REVENUE',
      'TIME_IN_BUSINESS',
    ]);
  });

  it('keeps businesses private to their owner', async () => {
    const owner = await registerUser(h.app);
    const other = await registerUser(h.app);
    const business = await client(h.app, owner).post<{ id: string }>(
      '/v1/businesses',
      demoBusiness,
    );
    const res = await client(h.app, other).get(`/v1/businesses/${business.body.id}`);
    expect(res.status).toBe(403);
    const list = await client(h.app, other).get<unknown[]>('/v1/businesses');
    expect(list.body).toEqual([]);
  });
});

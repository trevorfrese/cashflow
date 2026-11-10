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
      publicToken: 'mock_healthy_rev_48000_rent_6200',
    });
    expect(link.status).toBe(201);
    expect(link.body.institutionName).toBeTruthy();

    const approved = await api.post<{
      status: string;
      decision: {
        feeBps: number;
        approvedMonthlyLimitCents: number;
        score: number;
        grade: string;
        reasons: Array<{ code: string; impact: string }>;
        cashFlow: { monthsOfHistory: number; verifiedMonthlyRevenueCents: number };
      };
    }>(`/v1/underwriting/applications/${application.body.id}/submit`, { bankLinkId: link.body.id });
    expect(approved.body.status).toBe('APPROVED');
    expect(['A', 'B']).toContain(approved.body.decision.grade);
    expect(approved.body.decision.score).toBeGreaterThanOrEqual(68);
    expect([150, 200]).toContain(approved.body.decision.feeBps);
    expect(approved.body.decision.approvedMonthlyLimitCents).toBeGreaterThanOrEqual(620_000);
    expect(approved.body.decision.cashFlow.monthsOfHistory).toBeGreaterThanOrEqual(11);
    // Verified revenue tracks the pinned $48,000 a month within 15%.
    expect(approved.body.decision.cashFlow.verifiedMonthlyRevenueCents).toBeGreaterThan(4_080_000);
    expect(approved.body.decision.cashFlow.verifiedMonthlyRevenueCents).toBeLessThan(5_520_000);
    expect(approved.body.decision.reasons[0]?.code).toBe('APPROVED');

    const refreshed = await api.get<{ status: string }>(`/v1/businesses/${business.body.id}`);
    expect(refreshed.body.status).toBe('ACTIVE');

    const again = await api.post<{ error: { code: string } }>(
      `/v1/underwriting/applications/${application.body.id}/submit`,
    );
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('APPLICATION_FINAL');
  });

  it('declines an account with repeated overdrafts and explains why', async () => {
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const business = await api.post<{ id: string }>('/v1/businesses', demoBusiness);
    const link = await api.post<{ id: string }>('/v1/bank-links', {
      businessId: business.body.id,
      publicToken: 'mock_overdrafts_rev_9000_rent_3500',
    });
    const application = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId: business.body.id,
      statedMonthlyRevenueCents: 900_000,
      timeInBusinessMonths: 7,
      requestedMonthlyRentCents: 350_000,
      bankLinkId: link.body.id,
    });
    const declined = await api.post<{
      status: string;
      decision: { score: number; reasons: Array<{ code: string; impact: string }> };
    }>(`/v1/underwriting/applications/${application.body.id}/submit`);
    expect(declined.body.status).toBe('DECLINED');
    const codes = declined.body.decision.reasons.map((r) => r.code);
    expect(codes).toContain('EXCESSIVE_OVERDRAFTS');
    expect(codes).toContain('RENT_TO_REVENUE');
    expect(
      declined.body.decision.reasons.every((r) =>
        ['POSITIVE', 'NEGATIVE', 'INFO'].includes(r.impact),
      ),
    ).toBe(true);
  });

  it('asks for more information when stated revenue is far above verified revenue', async () => {
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const business = await api.post<{ id: string }>('/v1/businesses', demoBusiness);
    const link = await api.post<{ id: string }>('/v1/bank-links', {
      businessId: business.body.id,
      publicToken: 'mock_healthy_rev_20000',
    });
    const application = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId: business.body.id,
      statedMonthlyRevenueCents: 6_000_000,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: 400_000,
      bankLinkId: link.body.id,
    });
    const res = await api.post<{ status: string; decision: { reasons: Array<{ code: string }> } }>(
      `/v1/underwriting/applications/${application.body.id}/submit`,
    );
    expect(res.body.status).toBe('NEEDS_INFO');
    expect(res.body.decision.reasons[0]?.code).toBe('REVENUE_MISMATCH');
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

describe('commerce links', () => {
  it('connects a point of sale, feeds it into the decision, and stays private to the owner', async () => {
    const session = await registerUser(h.app);
    const api = client(h.app, session);
    const business = await api.post<{ id: string }>('/v1/businesses', demoBusiness);

    const token = await api.post<{ linkToken: string; provider: string }>(
      '/v1/commerce-links/link-token',
      { businessId: business.body.id, platform: 'SQUARE' },
    );
    expect(token.status).toBe(200);
    expect(token.body.provider).toBe('mock');

    const link = await api.post<{ id: string; platform: string; locationName: string }>(
      '/v1/commerce-links',
      { businessId: business.body.id, platform: 'SQUARE', publicToken: 'healthy_sales_48000' },
    );
    expect(link.status).toBe(201);
    expect(link.body.platform).toBe('SQUARE');
    expect(link.body.locationName).toContain('Square');

    const listed = await api.get<Array<{ id: string }>>(
      `/v1/businesses/${business.body.id}/commerce-links`,
    );
    expect(listed.body.map((l) => l.id)).toEqual([link.body.id]);

    const bank = await api.post<{ id: string }>('/v1/bank-links', {
      businessId: business.body.id,
      publicToken: 'mock_healthy_rev_48000_rent_6200',
    });
    const application = await api.post<{ id: string; commerceLinkId: string }>(
      '/v1/underwriting/applications',
      {
        businessId: business.body.id,
        statedMonthlyRevenueCents: 4_800_000,
        timeInBusinessMonths: 36,
        requestedMonthlyRentCents: 620_000,
        bankLinkId: bank.body.id,
        commerceLinkId: link.body.id,
      },
    );
    expect(application.body.commerceLinkId).toBe(link.body.id);
    const decided = await api.post<{
      status: string;
      decision: {
        reasons: Array<{ code: string; message: string }>;
        cashFlow: { commerce: { platform: string; monthsOfHistory: number } | null };
      };
    }>(`/v1/underwriting/applications/${application.body.id}/submit`);
    expect(decided.body.status).toBe('APPROVED');
    expect(decided.body.decision.cashFlow.commerce?.platform).toBe('SQUARE');
    expect(decided.body.decision.cashFlow.commerce?.monthsOfHistory).toBeGreaterThanOrEqual(11);
    expect(decided.body.decision.reasons.find((r) => r.code === 'DATA_DEPTH')?.message).toContain(
      'Square',
    );

    const stranger = client(h.app, await registerUser(h.app, { email: 'stranger@example.com' }));
    const denied = await stranger.get(`/v1/businesses/${business.body.id}/commerce-links`);
    expect(denied.status).toBe(403);
    const failed = await api.post<{ error: { code: string } }>('/v1/commerce-links', {
      businessId: business.body.id,
      platform: 'TOAST',
      publicToken: 'please_fail',
    });
    expect(failed.status).toBe(422);
    expect(failed.body.error.code).toBe('COMMERCE_LINK_FAILED');
  });
});

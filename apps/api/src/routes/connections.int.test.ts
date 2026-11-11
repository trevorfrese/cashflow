import type {
  Connection,
  ConnectionList,
  OperatorConnections,
  SeatInvitation,
  StartOAuthResponse,
  VeracityAssessment,
} from '@cashflow/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { verifySnapshot } from '../services/snapshots.ts';
import {
  adminClient,
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

/** Every token the database holds for any connection, decrypted, to look for in responses. */
async function storedTokens(): Promise<string[]> {
  const out: string[] = [];
  for (const b of await h.db.bankLink.findMany()) {
    if (b.accessTokenEnc) {
      out.push(
        b.accessTokenEnc,
        h.providers.vault.decrypt(b.accessTokenEnc, `business:${b.businessId}`),
      );
    }
  }
  for (const c of await h.db.commerceLink.findMany()) {
    for (const sealed of [c.accessTokenEnc, c.refreshTokenEnc]) {
      if (sealed) out.push(sealed, h.providers.vault.decrypt(sealed, `business:${c.businessId}`));
    }
  }
  return out;
}

async function owner() {
  const session = await registerUser(h.app);
  const api = client(h.app, session);
  const business = await api.post<{ id: string }>('/v1/businesses', demoBusiness);
  const bank = await api.post<{ id: string }>('/v1/bank-links', {
    businessId: business.body.id,
    publicToken: 'mock_healthy_rev_48000_rent_6200',
  });
  return { session, api, businessId: business.body.id, bankId: bank.body.id };
}

/** The app's OAuth round trip against the sandbox platform. */
async function connectSquare(
  api: ReturnType<typeof client>,
  businessId: string,
  scenario = 'healthy_sales_48000',
) {
  const started = await api.post<StartOAuthResponse>('/v1/connections/oauth/start', {
    businessId,
    platform: 'SQUARE',
    redirectUri: 'cashflow://connect/callback',
  });
  expect(started.status).toBe(200);
  const approved = await api.post<{ redirectUrl: string; code: string; state: string }>(
    '/v1/connections/oauth/mock-authorize',
    { state: started.body.state, scenario },
  );
  expect(approved.status).toBe(200);
  const url = new URL(approved.body.redirectUrl);
  return api.post<Connection>('/v1/connections/oauth/callback', {
    state: url.searchParams.get('state'),
    code: url.searchParams.get('code'),
  });
}

describe('direct OAuth connections', () => {
  it('connects through the sandbox consent page, records provenance, and never returns a token', async () => {
    const { api, businessId } = await owner();
    const started = await api.post<StartOAuthResponse>('/v1/connections/oauth/start', {
      businessId,
      platform: 'SQUARE',
    });
    expect(started.body).toMatchObject({ accessMethod: 'DIRECT_OAUTH', sandbox: true });
    expect(started.body.scopes).toEqual(expect.arrayContaining(['PAYMENTS_READ', 'PAYOUTS_READ']));
    expect(started.body.scopes.some((s) => /WRITE/.test(s))).toBe(false);
    expect(started.body.authorizationUrl).toContain('code_challenge=');

    const connected = await connectSquare(api, businessId);
    expect(connected.status).toBe(201);
    expect(connected.body).toMatchObject({
      kind: 'COMMERCE',
      platform: 'SQUARE',
      accessMethod: 'DIRECT_OAUTH',
      health: 'HEALTHY',
      trustTier: 'HIGH',
    });
    expect(connected.body.methodDescription).toContain(
      "approved read-only access on Square's site",
    );

    // Provenance from the platform, a sealed token, a snapshot with a verifiable hash.
    const row = await h.db.commerceLink.findUniqueOrThrow({ where: { id: connected.body.id } });
    expect(row.legalName).toBe('Blue Door Bakery LLC');
    expect(row.accessTokenEnc).toMatch(/^v1\.sandbox\./);
    const snapshots = await h.db.dataSnapshot.findMany({ where: { commerceLinkId: row.id } });
    expect(snapshots).toHaveLength(1);
    expect(verifySnapshot(snapshots[0]!)).toBe(true);

    // A code can be exchanged once.
    const again = await api.post('/v1/connections/oauth/callback', {
      state: started.body.state,
      code: 'mock_code.x',
    });
    expect(again.status).toBe(422);

    const list = await api.get<ConnectionList>(`/v1/businesses/${businessId}/connections`);
    expect(list.body.connections.map((c) => c.kind)).toEqual(['BANK', 'COMMERCE']);
    const tokens = await storedTokens();
    expect(tokens.length).toBeGreaterThan(2);
    const everything = JSON.stringify([list.body, connected.body, started.body]);
    for (const t of tokens) expect(everything).not.toContain(t);
    // Not in the audit trail either.
    const audit = JSON.stringify(await h.db.auditEvent.findMany());
    for (const t of tokens) expect(audit).not.toContain(t);
    expect(audit).toContain('CONSENT_GRANTED');
    expect(audit).toContain('DATA_PULLED');
  });

  it('records a declined consent and connects nothing', async () => {
    const { api, businessId } = await owner();
    const started = await api.post<StartOAuthResponse>('/v1/connections/oauth/start', {
      businessId,
      platform: 'SHOPIFY',
    });
    const declined = await api.post<{ redirectUrl: string; error: string }>(
      '/v1/connections/oauth/mock-authorize',
      {
        state: started.body.state,
        approve: false,
      },
    );
    expect(declined.body.error).toBe('access_denied');
    const res = await api.post<{ error: { code: string } }>('/v1/connections/oauth/callback', {
      state: started.body.state,
      error: 'access_denied',
    });
    expect(res.body.error.code).toBe('ACCESS_NOT_APPROVED');
    expect(await h.db.commerceLink.count()).toBe(0);
  });

  it('sends Toast to a seat, not OAuth', async () => {
    const { api, businessId } = await owner();
    const res = await api.post<{ error: { code: string } }>('/v1/connections/oauth/start', {
      businessId,
      platform: 'TOAST',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SEAT_REQUIRED');
  });

  it('feeds the decision through snapshots and stores their hashes on it', async () => {
    const { api, businessId, bankId } = await owner();
    const pos = await connectSquare(api, businessId);
    const app = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId,
      statedMonthlyRevenueCents: 4_800_000,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: 620_000,
      bankLinkId: bankId,
      commerceLinkId: pos.body.id,
    });
    const decided = await api.post<{ status: string }>(
      `/v1/underwriting/applications/${app.body.id}/submit`,
    );
    expect(decided.body.status).toBe('APPROVED');
    const decision = await h.db.underwritingDecision.findFirstOrThrow({
      where: { applicationId: app.body.id },
    });
    const veracity = (decision.snapshot as unknown as { veracity: VeracityAssessment }).veracity;
    expect(veracity.overall.outcome).toBe('CLEAR');
    expect(veracity.overall.independentlyVerifiedSources).toBe(2);
    const ids = veracity.snapshots.map((s) => s.id);
    const stored = await h.db.dataSnapshot.findMany({ where: { id: { in: ids } } });
    expect(stored.map((s) => s.contentHash).sort()).toEqual(
      veracity.snapshots.map((s) => s.contentHash).sort(),
    );
    expect(stored.every(verifySnapshot)).toBe(true);
    // Snapshots are append only.
    await expect(
      h.db.dataSnapshot.update({ where: { id: ids[0]! }, data: { reason: 'X' } }),
    ).rejects.toThrow();
    await expect(h.db.dataSnapshot.delete({ where: { id: ids[0]! } })).rejects.toThrow();

    // The operator sees findings, identity and snapshots; still no token.
    const ops = await adminClient(h.app, { role: 'reviewer' }).get<OperatorConnections>(
      `/v1/admin/applications/${app.body.id}/connections`,
    );
    expect(ops.status).toBe(200);
    expect(ops.body.assessment!.veracity.reconciliation[0]!.matchedShareByAmountBps).toBe(10_000);
    const square = ops.body.connections.find((c) => c.kind === 'COMMERCE')!;
    expect(square.identity.legalName).toBe('Blue Door Bakery LLC');
    expect(square.snapshots.length).toBeGreaterThan(0);
    expect(square.snapshots[0]!.hashPrefix).toHaveLength(12);
    expect(square.hasStoredToken).toBe(true);
    for (const t of await storedTokens()) expect(JSON.stringify(ops.body)).not.toContain(t);
  });

  it('asks the owner to connect the account sales are paid into', async () => {
    const { api, businessId, bankId } = await owner();
    const pos = await connectSquare(api, businessId, 'healthy_sales_48000_payout_elsewhere');
    const app = await api.post<{ id: string }>('/v1/underwriting/applications', {
      businessId,
      statedMonthlyRevenueCents: 4_800_000,
      timeInBusinessMonths: 36,
      requestedMonthlyRentCents: 620_000,
      bankLinkId: bankId,
      commerceLinkId: pos.body.id,
    });
    const decided = await api.post<{
      status: string;
      decision: { reasons: Array<{ code: string; message: string }> };
    }>(`/v1/underwriting/applications/${app.body.id}/submit`);
    expect(decided.body.status).toBe('NEEDS_INFO');
    expect(decided.body.decision.reasons[0]).toMatchObject({
      code: 'PAYOUT_ACCOUNT_NOT_CONNECTED',
    });
    const list = await api.get<ConnectionList>(`/v1/businesses/${businessId}/connections`);
    const square = list.body.connections.find((c) => c.kind === 'COMMERCE')!;
    expect(square.actions.map((a) => a.code)).toEqual(['CONNECT_PAYOUT_ACCOUNT']);
    expect(square.checks).toContainEqual({
      label: 'Sales are paid into a connected account',
      ok: false,
    });
  });
});

describe('delegated seats', () => {
  it("issues CashFlow's own service user, checks the seat, and pulls through it", async () => {
    const { api, businessId } = await owner();
    const invited = await api.post<SeatInvitation>('/v1/connections/seats', {
      businessId,
      platform: 'TOAST',
    });
    expect(invited.status).toBe(201);
    expect(invited.body.serviceUserEmail).toMatch(/cashflow/);
    expect(invited.body.connection).toMatchObject({
      accessMethod: 'DELEGATED_SEAT',
      health: 'PENDING',
      status: 'PENDING',
    });
    expect(invited.body.steps.join(' ')).not.toMatch(/password/i);

    const checked = await api.post<Connection>(
      `/v1/connections/${invited.body.connection.id}/verify-seat`,
    );
    expect(checked.body).toMatchObject({
      status: 'LINKED',
      health: 'HEALTHY',
      trustTier: 'MEDIUM',
    });
    expect(checked.body.methodDescription).toContain('read-only reports user');
    const row = await h.db.commerceLink.findUniqueOrThrow({ where: { id: checked.body.id } });
    expect(row.accessTokenEnc).toBeNull();
    expect(await h.db.dataSnapshot.count({ where: { commerceLinkId: row.id } })).toBe(1);
  });

  it('fails closed when the report pull fails, and stays pending while the seat is inactive', async () => {
    const { api, businessId } = await owner();
    const inactive = await api.post<SeatInvitation>('/v1/connections/seats', {
      businessId,
      platform: 'TOAST',
      scenario: 'healthy_seat_inactive',
    });
    const stillPending = await api.post<Connection>(
      `/v1/connections/${inactive.body.connection.id}/verify-seat`,
    );
    expect(stillPending.body.status).toBe('PENDING');

    const failing = await api.post<SeatInvitation>('/v1/connections/seats', {
      businessId,
      platform: 'TOAST',
      scenario: 'healthy_seat_layout_changed',
    });
    const failed = await api.post<Connection>(
      `/v1/connections/${failing.body.connection.id}/verify-seat`,
    );
    expect(failed.body.health).toBe('ERROR');
    expect(failed.body.actions.map((a) => a.code)).toEqual(['RECONNECT']);
    expect(
      await h.db.dataSnapshot.count({ where: { commerceLinkId: failing.body.connection.id } }),
    ).toBe(0);
  });
});

describe('access', () => {
  it("one owner cannot see or touch another owner's connections", async () => {
    const a = await owner();
    const pos = await connectSquare(a.api, a.businessId);
    const stranger = client(h.app, await registerUser(h.app, { email: 'stranger@example.com' }));
    for (const res of [
      await stranger.get(`/v1/businesses/${a.businessId}/connections`),
      await stranger.get(`/v1/connections/${pos.body.id}`),
      await stranger.post(`/v1/connections/${pos.body.id}/disconnect`),
      await stranger.post(`/v1/connections/${a.bankId}/disconnect`),
      await stranger.post(`/v1/connections/${pos.body.id}/verify-seat`),
      await stranger.post('/v1/connections/oauth/start', {
        businessId: a.businessId,
        platform: 'SQUARE',
      }),
      await stranger.post('/v1/connections/seats', { businessId: a.businessId, platform: 'TOAST' }),
    ]) {
      expect(res.status).toBe(403);
    }
    // Nor finish an authorization someone else started.
    const started = await a.api.post<StartOAuthResponse>('/v1/connections/oauth/start', {
      businessId: a.businessId,
      platform: 'SQUARE',
    });
    expect(
      (await stranger.post('/v1/connections/oauth/mock-authorize', { state: started.body.state }))
        .status,
    ).toBe(403);
    expect(
      (
        await stranger.post('/v1/connections/oauth/callback', {
          state: started.body.state,
          code: 'x',
        })
      ).status,
    ).toBe(403);
    expect((await client(h.app).get(`/v1/businesses/${a.businessId}/connections`)).status).toBe(
      401,
    );
  });

  it('disconnect revokes, deletes the tokens, and keeps the evidence', async () => {
    const { api, businessId } = await owner();
    const pos = await connectSquare(api, businessId);
    const res = await api.post<Connection>(`/v1/connections/${pos.body.id}/disconnect`);
    expect(res.body).toMatchObject({
      status: 'DISCONNECTED',
      health: 'REVOKED',
      trustTier: 'NONE',
    });
    const row = await h.db.commerceLink.findUniqueOrThrow({ where: { id: pos.body.id } });
    expect([row.accessTokenEnc, row.refreshTokenEnc]).toEqual([null, null]);
    expect(await h.db.dataSnapshot.count({ where: { commerceLinkId: pos.body.id } })).toBe(1);
    expect(await h.db.auditEvent.count({ where: { eventType: 'CONNECTION_REVOKED' } })).toBe(1);
  });
});

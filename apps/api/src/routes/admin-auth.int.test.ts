import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import {
  adminClient,
  client,
  createTestApp,
  registerUser,
  resetDb,
  TEST_ACTOR,
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

type ErrorBody = { error: { code: string; message: string } };

/** Every operator route, with a body that would be valid. */
const ROUTES: Array<{
  method: 'get' | 'post';
  url: string;
  body?: unknown;
  role: 'reviewer' | 'admin';
}> = [
  { method: 'get', url: '/v1/admin/whoami', role: 'reviewer' },
  { method: 'post', url: '/v1/admin/jobs/run', body: { asOf: '2026-01-01' }, role: 'admin' },
  { method: 'post', url: '/v1/admin/capital/fund', body: { amountCents: 100 }, role: 'admin' },
  {
    method: 'post',
    url: '/v1/admin/circuit-breaker/reset',
    body: { reason: 'because' },
    role: 'admin',
  },
  { method: 'get', url: '/v1/admin/ledger/trial-balance', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/ledger/accounts', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/capital', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/delinquency', role: 'reviewer' },
  {
    method: 'get',
    url: '/v1/admin/audit-events?subjectType=business&subjectId=x',
    role: 'reviewer',
  },
  { method: 'get', url: '/v1/admin/circuit-breaker', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/monitoring/summary', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/businesses/x/identity', role: 'reviewer' },
  // Console read routes (routes/admin-console.ts).
  { method: 'get', url: '/v1/admin/businesses', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/businesses/x', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/businesses/x/rent-plans', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/businesses/x/connections', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/applications/x', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/applications/x/connections', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/audit-log', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/portfolio', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/policy', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/policy/evaluation', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/reviews', role: 'reviewer' },
  {
    method: 'post',
    url: '/v1/admin/applications/x/review',
    body: { decision: 'DECLINE', reasonCodes: ['OTHER'], principalReasonCodes: ['CASH_BUFFER'] },
    role: 'reviewer',
  },
  {
    method: 'post',
    url: '/v1/admin/rent-plans/x/release-freeze',
    body: { reason: 'because' },
    role: 'reviewer',
  },
  {
    method: 'post',
    url: '/v1/admin/payouts/x/resend',
    body: { reason: 'because' },
    role: 'reviewer',
  },
  { method: 'get', url: '/v1/admin/alerts', role: 'reviewer' },
  { method: 'get', url: '/v1/admin/alerts/x', role: 'reviewer' },
  { method: 'post', url: '/v1/admin/alerts/x/acknowledge', body: {}, role: 'reviewer' },
  {
    method: 'post',
    url: '/v1/admin/alerts/x/resolve',
    body: { disposition: 'NO_ACTION', notes: 'because' },
    role: 'reviewer',
  },
  { method: 'get', url: '/v1/admin/lease-changes', role: 'reviewer' },
  {
    method: 'post',
    url: '/v1/admin/lease-changes/x/decide',
    body: { decision: 'REJECT', reason: 'because' },
    role: 'reviewer',
  },
  { method: 'get', url: '/v1/admin/screening/hits', role: 'reviewer' },
  {
    method: 'post',
    url: '/v1/admin/screening/x/clear',
    body: { reason: 'because' },
    role: 'reviewer',
  },
];

const call = (
  api: ReturnType<typeof client>,
  route: (typeof ROUTES)[number],
): Promise<{ status: number; body: ErrorBody }> =>
  route.method === 'get'
    ? api.get<ErrorBody>(route.url)
    : api.post<ErrorBody>(route.url, route.body);

describe('operator route access control', () => {
  it('covers every route the admin plugin registers', () => {
    // The OpenAPI document lists every registered route. A new operator route has to be
    // added to ROUTES above, or this fails.
    const paths = (
      h.app as unknown as { swagger: () => { paths: Record<string, object> } }
    ).swagger().paths;
    const registered = Object.entries(paths)
      .filter(([path]) => path.startsWith('/v1/admin/'))
      .flatMap(([path, methods]) => Object.keys(methods).map((m) => `${m} ${path}`))
      .sort();
    const covered = ROUTES.map(
      (r) =>
        `${r.method} ${r.url.split('?')[0]!.replace('/x/', '/{id}/').replace(/\/x$/, '/{id}')}`,
    ).sort();
    expect(covered).toEqual(registered);
  });

  it('refuses every route without a token, with a wrong token, and with an owner session', async () => {
    const session = await registerUser(h.app);
    const wrong = client(h.app, undefined, {
      authorization: `Bearer ${'z'.repeat(48)}`,
      'x-admin-actor': TEST_ACTOR,
    });
    const owner = client(h.app, session, { 'x-admin-actor': TEST_ACTOR });
    for (const route of ROUTES) {
      for (const api of [client(h.app), wrong, owner]) {
        const res = await call(api, route);
        expect(res.status, `${route.method} ${route.url}`).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHORIZED');
      }
    }
  });

  it('requires the X-Admin-Actor header on every route, for both roles', async () => {
    for (const role of ['admin', 'reviewer'] as const) {
      const token = role === 'admin' ? process.env.ADMIN_API_TOKEN : process.env.REVIEWER_API_TOKEN;
      const noActor = client(h.app, undefined, { authorization: `Bearer ${token}` });
      const blank = client(h.app, undefined, {
        authorization: `Bearer ${token}`,
        'x-admin-actor': ' ',
      });
      for (const route of ROUTES) {
        for (const api of [noActor, blank]) {
          const res = await call(api, route);
          expect(res.status, `${role} ${route.method} ${route.url}`).toBe(400);
          expect(res.body.error.code).toBe('ACTOR_REQUIRED');
        }
      }
    }
  });

  it('forbids a reviewer on admin only routes and lets it through everywhere else', async () => {
    const reviewer = adminClient(h.app, { role: 'reviewer' });
    for (const route of ROUTES) {
      const res = await call(reviewer, route);
      if (route.role === 'admin') {
        expect(res.status, `${route.method} ${route.url}`).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      } else {
        // Past access control: the handler ran. 200, or 404/422 for the placeholder id.
        expect([200, 404, 422], `${route.method} ${route.url}`).toContain(res.status);
      }
    }
    // Nothing a reviewer was refused took effect.
    expect(await h.db.ledgerTransaction.count()).toBe(0);
    expect(await h.db.jobRun.count()).toBe(0);
  });

  it('lets an admin do everything a reviewer can', async () => {
    const admin = adminClient(h.app);
    for (const route of ROUTES) {
      const res = await call(admin, route);
      expect([200, 404, 422], `${route.method} ${route.url}`).toContain(res.status);
    }
  });

  it('takes the acting identity from the token and the header, and audits it', async () => {
    const who = await adminClient(h.app, { role: 'reviewer', actor: 'pat@cashflow.example' }).get(
      '/v1/admin/whoami',
    );
    expect(who.body).toEqual({ role: 'reviewer', actor: 'pat@cashflow.example' });

    const funded = await adminClient(h.app, { actor: 'lee@cashflow.example' }).post(
      '/v1/admin/capital/fund',
      // A body cannot say who is acting. Unknown fields are dropped.
      { amountCents: 5_000_000, actor: 'mallory', reviewer: 'mallory' },
    );
    expect(funded.status).toBe(200);
    const events = await h.db.auditEvent.findMany({ where: { eventType: 'POOL_FUNDED' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: 'admin', actorId: 'lee@cashflow.example' });
    expect(events[0]!.payload).toMatchObject({ amountCents: 5_000_000 });
  });

  it('does not mount the routes at all when ENABLE_ADMIN is off', async () => {
    const config = loadConfig({ ...process.env, ENABLE_ADMIN: 'false' });
    const app = await buildApp({ config, db: h.db, providers: h.providers, logger: false });
    await app.ready();
    try {
      const res = await adminClient(app).get('/v1/admin/whoami');
      expect(res.status).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('shows the identity provider in /health', async () => {
    const res = await client(h.app).get<{ providers: Record<string, string> }>('/health');
    expect(res.body.providers.identity).toBe('mock');
  });
});

describe('rate limiting', () => {
  let limited: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig({
      ...process.env,
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_MAX: '8',
      RATE_LIMIT_AUTH_MAX: '3',
      // Lockout would get there first on repeated bad passwords. It is tested below.
      LOGIN_MAX_FAILURES: '0',
    });
    limited = await buildApp({ config, db: h.db, providers: h.providers, logger: false });
    await limited.ready();
  });
  afterAll(async () => {
    await limited.close();
  });

  it('limits login attempts from one address, tighter than other routes', async () => {
    const attempt = () =>
      client(limited).post<ErrorBody>('/v1/auth/login', {
        email: 'nobody@example.com',
        password: 'wrong-password',
      });
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    // Register and refresh have their own counters.
    const refresh = await client(limited).post('/v1/auth/refresh', { refreshToken: 'nope' });
    expect(refresh.status).toBe(401);
  });

  it('applies a global default to everything else, and leaves /health alone', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++)
      statuses.push((await client(limited).get('/v1/businesses')).status);
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
    expect(statuses.at(-1)).toBe(429);
    for (let i = 0; i < 12; i++) {
      expect((await client(limited).get('/health')).status).toBe(200);
    }
  });

  it('is off in the test configuration, so the suites are not throttled', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await client(h.app).post('/v1/auth/login', {
        email: 'nobody@example.com',
        password: 'wrong-password',
      });
      expect(res.status).toBe(401);
    }
  });
});

describe('login lockout', () => {
  const login = (email: string, password: string) =>
    client(h.app).post<ErrorBody & { tokens?: unknown }>('/v1/auth/login', { email, password });

  it('locks an account after five wrong passwords in a row and audits it', async () => {
    const session = await registerUser(h.app, { email: 'locked@example.com' });
    for (let i = 0; i < 4; i++) {
      expect((await login('locked@example.com', 'wrong')).status).toBe(401);
    }
    const fifth = await login('locked@example.com', 'wrong');
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('LOGIN_LOCKED');

    // The right password does not get in while the lock holds.
    const right = await login('locked@example.com', 'a-long-test-password');
    expect(right.status).toBe(429);
    expect(right.body.error.code).toBe('LOGIN_LOCKED');

    const events = await h.db.auditEvent.findMany({ where: { eventType: 'LOGIN_LOCKED' } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ subjectType: 'user', subjectId: session.userId });
    expect(events[0]!.payload).toMatchObject({ failures: 5, severity: 'warning' });

    // When the lock has run out the account works again and the count starts from zero.
    await h.db.user.update({
      where: { id: session.userId },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    expect((await login('locked@example.com', 'a-long-test-password')).status).toBe(200);
    const user = await h.db.user.findUniqueOrThrow({ where: { id: session.userId } });
    expect(user).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });

  it('resets the count on a successful sign in, and never locks an unknown email', async () => {
    await registerUser(h.app, { email: 'careful@example.com' });
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) {
        expect((await login('careful@example.com', 'wrong')).status).toBe(401);
      }
      expect((await login('careful@example.com', 'a-long-test-password')).status).toBe(200);
    }
    for (let i = 0; i < 8; i++) {
      expect((await login('nobody@example.com', 'wrong')).status).toBe(401);
    }
    expect(await h.db.auditEvent.count({ where: { eventType: 'LOGIN_LOCKED' } })).toBe(0);
  });
});

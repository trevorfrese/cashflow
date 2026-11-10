import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { client, createTestApp, registerUser, resetDb, type TestHarness } from '../test/helpers.ts';

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

describe('auth', () => {
  it('registers, returns tokens, and serves /me', async () => {
    const session = await registerUser(h.app, { email: 'Owner@Example.com' });
    const me = await client(h.app, session).get<{ email: string }>('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('owner@example.com'); // normalized
  });

  it('rejects duplicate emails and weak passwords', async () => {
    await registerUser(h.app, { email: 'dup@example.com' });
    const dup = await client(h.app).post('/v1/auth/register', {
      email: 'dup@example.com',
      password: 'a-long-test-password',
      fullName: 'Dup',
    });
    expect(dup.status).toBe(409);

    const weak = await client(h.app).post<{ error: { code: string } }>('/v1/auth/register', {
      email: 'weak@example.com',
      password: 'short',
      fullName: 'Weak',
    });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('logs in with the right password only', async () => {
    await registerUser(h.app, { email: 'login@example.com' });
    const bad = await client(h.app).post('/v1/auth/login', {
      email: 'login@example.com',
      password: 'nope',
    });
    expect(bad.status).toBe(401);
    const unknown = await client(h.app).post('/v1/auth/login', {
      email: 'nobody@example.com',
      password: 'nope',
    });
    expect(unknown.status).toBe(401);
    const ok = await client(h.app).post<{ tokens: { accessToken: string } }>('/v1/auth/login', {
      email: 'login@example.com',
      password: 'a-long-test-password',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.tokens.accessToken).toBeTruthy();
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const session = await registerUser(h.app);
    const first = await client(h.app).post<{ refreshToken: string }>('/v1/auth/refresh', {
      refreshToken: session.refreshToken,
    });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(session.refreshToken);

    const reuse = await client(h.app).post('/v1/auth/refresh', {
      refreshToken: session.refreshToken,
    });
    expect(reuse.status).toBe(401);

    const logout = await client(h.app).post('/v1/auth/logout', {
      refreshToken: first.body.refreshToken,
    });
    expect(logout.status).toBe(204);
    const afterLogout = await client(h.app).post('/v1/auth/refresh', {
      refreshToken: first.body.refreshToken,
    });
    expect(afterLogout.status).toBe(401);
  });

  it('requires a token for protected routes', async () => {
    const res = await client(h.app).get('/v1/businesses');
    expect(res.status).toBe(401);
  });
});

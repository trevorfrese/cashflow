import { describe, expect, it, vi } from 'vitest';

import { loadEnv, type OpsEnv } from './env';
import { proxy, signIn, signOut, whoAmI, type Deps } from './handlers';
import { sealSession, SESSION_COOKIE, unsealSession, type Session } from './session';

const SECRET = 'a-test-secret-of-at-least-thirty-two-chars';
const TOKEN = 'operator-token-0123456789abcdef0123456789';
const ORIGIN = 'http://localhost:3200';
const env: OpsEnv = { apiUrl: 'http://api.test:4000', sessionSecret: SECRET, allowedOrigins: [] };

type Upstream = (url: string, init: RequestInit) => Response | Promise<Response>;

function deps(upstream: Upstream, overrides: Partial<OpsEnv> = {}) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    upstream(String(url), init ?? {}),
  );
  const d: Deps = { env: { ...env, ...overrides }, fetch: fetchMock as unknown as typeof fetch };
  return { d, fetchMock };
}

const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      host: 'localhost:3200',
      origin: ORIGIN,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function cookieFor(overrides: Partial<Session> = {}) {
  const session: Session = {
    token: TOKEN,
    actor: 'pat@cashflow.example',
    role: 'reviewer',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
  return `${SESSION_COOKIE}=${sealSession(session, SECRET)}`;
}

/** Everything a response exposes: status line aside, its headers and its body. */
async function exposed(res: Response) {
  return `${JSON.stringify([...res.headers.entries()])}\n${await res.clone().text()}`;
}

describe('loadEnv', () => {
  it('defaults the API to localhost:4000 and refuses a short secret', () => {
    expect(loadEnv({})).toEqual({
      apiUrl: 'http://localhost:4000',
      sessionSecret: null,
      allowedOrigins: [],
    });
    expect(loadEnv({ OPS_SESSION_SECRET: 'short' }).sessionSecret).toBeNull();
    expect(
      loadEnv({
        CASHFLOW_API_URL: 'http://127.0.0.1:4001/',
        OPS_SESSION_SECRET: SECRET,
        OPS_ALLOWED_ORIGINS: 'https://a.example/, https://b.example',
      }),
    ).toEqual({
      apiUrl: 'http://127.0.0.1:4001',
      sessionSecret: SECRET,
      allowedOrigins: ['https://a.example', 'https://b.example'],
    });
  });
});

describe('sign in', () => {
  it('verifies with whoami, sets the sealed cookie, and never returns the token', async () => {
    const { d, fetchMock } = deps(() => ok({ role: 'admin', actor: 'lee@cashflow.example' }));
    const res = await signIn(
      post('/api/session', { token: ` ${TOKEN} `, actor: ' lee@cashflow.example ' }),
      d,
    );
    expect(res.status).toBe(200);
    const body = (await res.clone().json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['actor', 'expiresAt', 'role']);
    expect(body).toMatchObject({ role: 'admin', actor: 'lee@cashflow.example' });
    expect(await exposed(res)).not.toContain(TOKEN);

    // The API was asked with the token and the name the operator typed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test:4000/v1/admin/whoami');
    expect(init?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'x-admin-actor': 'lee@cashflow.example',
    });

    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Secure');
    const sealed = cookie.split(';')[0]!.slice(SESSION_COOKIE.length + 1);
    expect(unsealSession(sealed, SECRET)).toMatchObject({
      token: TOKEN,
      actor: 'lee@cashflow.example',
      role: 'admin',
    });
  });

  it('marks the cookie Secure when the console is not on localhost', async () => {
    const { d } = deps(() => ok({ role: 'reviewer', actor: 'pat' }));
    const res = await signIn(
      new Request('https://ops.internal.example/api/session', {
        method: 'POST',
        headers: {
          host: 'ops.internal.example',
          origin: 'https://ops.internal.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token: TOKEN, actor: 'pat' }),
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('; Secure');
  });

  it('takes the role from the API, not from the request', async () => {
    const { d } = deps(() => ok({ role: 'reviewer', actor: 'pat@cashflow.example' }));
    const res = await signIn(
      post('/api/session', { token: TOKEN, actor: 'pat@cashflow.example', role: 'admin' }),
      d,
    );
    expect(await res.json()).toMatchObject({ role: 'reviewer' });
  });

  it('refuses a wrong token without setting a cookie', async () => {
    const { d } = deps(() => ok({ error: { code: 'UNAUTHORIZED', message: 'no' } }, 401));
    const res = await signIn(post('/api/session', { token: 'wrong-token', actor: 'pat' }), d);
    expect(res.status).toBe(401);
    expect(await res.clone().json()).toMatchObject({ error: { code: 'INVALID_TOKEN' } });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await exposed(res)).not.toContain('wrong-token');
  });

  it('validates the form before calling the API', async () => {
    const { d, fetchMock } = deps(() => ok({}));
    for (const body of [
      { token: '', actor: 'pat' },
      { token: TOKEN, actor: 'p' },
      { token: TOKEN },
      null,
    ]) {
      const res = await signIn(post('/api/session', body), d);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a request from another origin before reading it', async () => {
    const { d, fetchMock } = deps(() => ok({ role: 'admin', actor: 'x' }));
    const res = await signIn(
      post('/api/session', { token: TOKEN, actor: 'pat' }, { origin: 'https://evil.example' }),
      d,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says what is wrong when there is no secret, the API is down, or admin routes are off', async () => {
    const none = deps(() => ok({}), { sessionSecret: null });
    const noSecret = await signIn(post('/api/session', { token: TOKEN, actor: 'pat' }), none.d);
    expect(noSecret.status).toBe(500);
    expect(await noSecret.json()).toMatchObject({ error: { code: 'OPS_SECRET_MISSING' } });
    expect(none.fetchMock).not.toHaveBeenCalled();

    const down = deps(() => {
      throw new TypeError('fetch failed');
    });
    const unreachable = await signIn(post('/api/session', { token: TOKEN, actor: 'pat' }), down.d);
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toMatchObject({ error: { code: 'API_UNREACHABLE' } });

    const off = deps(() => ok({ error: { code: 'NOT_FOUND' } }, 404));
    const disabled = await signIn(post('/api/session', { token: TOKEN, actor: 'pat' }), off.d);
    expect(disabled.status).toBe(502);
    expect(await disabled.json()).toMatchObject({ error: { code: 'ADMIN_ROUTES_OFF' } });

    const odd = deps(() => ok({ role: 'owner', actor: 'pat' }));
    const shape = await signIn(post('/api/session', { token: TOKEN, actor: 'pat' }), odd.d);
    expect(shape.status).toBe(502);
    expect(shape.headers.get('set-cookie')).toBeNull();
  });
});

describe('session and sign out', () => {
  it('reports who is signed in, without the token', async () => {
    const { d } = deps(() => ok({}));
    const res = whoAmI(
      new Request(`${ORIGIN}/api/session`, { headers: { cookie: cookieFor({ role: 'admin' }) } }),
      d,
    );
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toMatchObject({
      role: 'admin',
      actor: 'pat@cashflow.example',
    });
    expect(await exposed(res)).not.toContain(TOKEN);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is 401 with no cookie, a forged cookie, or an expired one', async () => {
    const { d } = deps(() => ok({}));
    const cookies = [
      undefined,
      `${SESSION_COOKIE}=v1.forged.value.here`,
      cookieFor({ expiresAt: Math.floor(Date.now() / 1000) - 1 }),
    ];
    for (const cookie of cookies) {
      const res = whoAmI(
        new Request(`${ORIGIN}/api/session`, { headers: cookie ? { cookie } : {} }),
        d,
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
    }
  });

  it('clears the cookie on sign out, and only for a same origin request', async () => {
    const { d } = deps(() => ok({}));
    const out = signOut(
      new Request(`${ORIGIN}/api/session`, {
        method: 'DELETE',
        headers: { host: 'localhost:3200', origin: ORIGIN, cookie: cookieFor() },
      }),
      d,
    );
    expect(out.status).toBe(200);
    const cookie = out.headers.get('set-cookie')!;
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');

    const foreign = signOut(
      new Request(`${ORIGIN}/api/session`, {
        method: 'DELETE',
        headers: { host: 'localhost:3200', origin: 'https://evil.example', cookie: cookieFor() },
      }),
      d,
    );
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get('set-cookie')).toBeNull();
  });
});

describe('proxy', () => {
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, { headers: { host: 'localhost:3200', ...headers } });

  it('attaches the token and the actor server side and passes the answer through', async () => {
    const { d, fetchMock } = deps(() => ok({ items: [{ id: 'a1' }], nextCursor: null }));
    const res = await proxy(
      get('/api/admin/alerts?status=OPEN&limit=5', { cookie: `theme=dark; ${cookieFor()}` }),
      ['alerts'],
      d,
    );
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toEqual({ items: [{ id: 'a1' }], nextCursor: null });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await exposed(res)).not.toContain(TOKEN);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test:4000/v1/admin/alerts?status=OPEN&limit=5');
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      'x-admin-actor': 'pat@cashflow.example',
      accept: 'application/json',
    });
    // The browser's cookies are not sent on to the API.
    expect(JSON.stringify(init?.headers)).not.toContain('theme=dark');
    expect(JSON.stringify(init?.headers)).not.toContain(SESSION_COOKIE);
  });

  it('ignores an Authorization or actor header sent by the browser', async () => {
    const { d, fetchMock } = deps(() => ok([]));
    await proxy(
      get('/api/admin/reviews', {
        cookie: cookieFor(),
        authorization: 'Bearer something-else',
        'x-admin-actor': 'mallory',
      }),
      ['reviews'],
      d,
    );
    expect(fetchMock.mock.calls[0]![1]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'x-admin-actor': 'pat@cashflow.example',
    });
  });

  it('forwards a POST body and passes an API refusal through with its code', async () => {
    const refusal = {
      error: {
        code: 'SCREENING_HIT_OPEN',
        message: 'Clear it first',
        details: { screeningIds: ['s1'] },
      },
    };
    const { d, fetchMock } = deps(() => ok(refusal, 422));
    const res = await proxy(
      post(
        '/api/admin/applications/app1/review',
        { decision: 'APPROVE', reasonCodes: [] },
        { cookie: cookieFor() },
      ),
      ['applications', 'app1', 'review'],
      d,
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(refusal);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://api.test:4000/v1/admin/applications/app1/review');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ decision: 'APPROVE', reasonCodes: [] }));
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
  });

  it('refuses a state-changing request from another origin, or with none stated', async () => {
    const { d, fetchMock } = deps(() => ok({}));
    for (const headers of [
      { origin: 'https://evil.example', cookie: cookieFor() },
      { origin: 'null', cookie: cookieFor() },
    ]) {
      const res = await proxy(
        post('/api/admin/alerts/a1/resolve', { disposition: 'NO_ACTION', notes: 'x' }, headers),
        ['alerts', 'a1', 'resolve'],
        d,
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
    }
    const bare = new Request(`${ORIGIN}/api/admin/alerts/a1/resolve`, {
      method: 'POST',
      headers: { host: 'localhost:3200', 'content-type': 'application/json', cookie: cookieFor() },
      body: '{}',
    });
    expect((await proxy(bare, ['alerts', 'a1', 'resolve'], d)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('needs a session, and removes a cookie that no longer opens', async () => {
    const { d, fetchMock } = deps(() => ok({}));
    const none = await proxy(get('/api/admin/alerts'), ['alerts'], d);
    expect(none.status).toBe(401);
    expect(await none.json()).toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
    expect(none.headers.get('set-cookie')).toBeNull();

    const stale = await proxy(
      get('/api/admin/alerts', { cookie: `${SESSION_COOKIE}=v1.not.a.session` }),
      ['alerts'],
      d,
    );
    expect(stale.status).toBe(401);
    expect(stale.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends the session when the API no longer accepts the token', async () => {
    const { d } = deps(() =>
      ok({ error: { code: 'UNAUTHORIZED', message: 'Invalid operator token' } }, 401),
    );
    const res = await proxy(get('/api/admin/alerts', { cookie: cookieFor() }), ['alerts'], d);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'SESSION_REQUIRED' } });
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('passes a role refusal through: the API decides what a reviewer may do', async () => {
    const { d } = deps(() => ok({ error: { code: 'FORBIDDEN', message: 'needs admin' } }, 403));
    const res = await proxy(
      post('/api/admin/circuit-breaker/reset', { reason: 'checked' }, { cookie: cookieFor() }),
      ['circuit-breaker', 'reset'],
      d,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('does not forward a route that is not on the list', async () => {
    const { d, fetchMock } = deps(() => ok({}));
    const fund = await proxy(
      post('/api/admin/capital/fund', { amountCents: 1 }, { cookie: cookieFor({ role: 'admin' }) }),
      ['capital', 'fund'],
      d,
    );
    expect(fund.status).toBe(404);
    expect(await fund.json()).toMatchObject({ error: { code: 'NOT_PROXIED' } });
    const escape = await proxy(
      get('/api/admin/alerts/..%2F..', { cookie: cookieFor() }),
      ['alerts', '../..'],
      d,
    );
    expect(escape.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a POST without a JSON body, and reports an API that is down', async () => {
    const { d, fetchMock } = deps(() => ok({}));
    const form = new Request(`${ORIGIN}/api/admin/alerts/a1/acknowledge`, {
      method: 'POST',
      headers: {
        host: 'localhost:3200',
        origin: ORIGIN,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieFor(),
      },
      body: 'notes=x',
    });
    expect((await proxy(form, ['alerts', 'a1', 'acknowledge'], d)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const down = deps(() => {
      throw new TypeError('fetch failed');
    });
    const res = await proxy(get('/api/admin/alerts', { cookie: cookieFor() }), ['alerts'], down.d);
    expect(res.status).toBe(502);
    const body = await res.clone().json();
    expect(body).toMatchObject({ error: { code: 'API_UNREACHABLE' } });
    expect(await exposed(res)).not.toContain(TOKEN);
  });
});

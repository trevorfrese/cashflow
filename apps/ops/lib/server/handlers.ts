import { AdminIdentity } from '@cashflow/shared';
import { z } from 'zod';

import { isSameOrigin, needsOriginCheck } from './csrf';
import type { OpsEnv } from './env';
import { upstreamPath } from './routes';
import {
  clearedSessionCookie,
  readSessionCookie,
  requestHost,
  sealSession,
  SESSION_TTL_SECONDS,
  sessionCookie,
  sessionFromRequest,
  toPublicSession,
  type Session,
} from './session';

/**
 * The console's server side: sign in, sign out, and the proxy to the API. Written against
 * the web `Request` and `Response` types with the environment and `fetch` passed in, so the
 * route files are one line each and everything here runs under a unit test.
 *
 * The rule the whole module keeps: the operator token goes from the sign-in form to the
 * sealed cookie to the `Authorization` header of an upstream request, and nowhere else. No
 * response body or header built here contains it.
 */

export interface Deps {
  env: OpsEnv;
  fetch: typeof fetch;
  /** Milliseconds since the epoch. Injected for tests. */
  now?: () => number;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function error(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json(status, { error: { code, message } }, headers);
}

const CSRF_REFUSAL = () =>
  error(403, 'CSRF_REJECTED', 'This request did not come from the console and was refused.');

const NO_SECRET = () =>
  error(
    500,
    'OPS_SECRET_MISSING',
    'The console has no session secret. Set OPS_SESSION_SECRET (32 characters or more) in apps/ops/.env.local and restart it.',
  );

const UNREACHABLE = (env: OpsEnv) =>
  error(502, 'API_UNREACHABLE', `The CashFlow API at ${env.apiUrl} did not answer. Is it running?`);

/** A person's name or email, as the API requires it in X-Admin-Actor. */
const SignInRequest = z.object({
  token: z.string().trim().min(1, 'Enter the operator token').max(512),
  actor: z
    .string()
    .trim()
    .regex(/^[\x20-\x7E]{2,120}$/, 'Enter your name or email (2 to 120 plain characters)'),
});

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(request: Request): Promise<unknown | undefined> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return undefined;
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * POST /api/session. Checks the token and name with the API's `whoami`, and on success
 * sets the sealed session cookie. The response says who and which role, never the token.
 */
export async function signIn(request: Request, deps: Deps): Promise<Response> {
  if (!isSameOrigin(request, deps.env.allowedOrigins)) return CSRF_REFUSAL();
  if (!deps.env.sessionSecret) return NO_SECRET();
  const parsed = SignInRequest.safeParse(await readJson(request));
  if (!parsed.success) {
    return error(400, 'VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'Invalid sign in');
  }
  const { token, actor } = parsed.data;

  let upstream: Response;
  try {
    upstream = await deps.fetch(`${deps.env.apiUrl}/v1/admin/whoami`, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-admin-actor': actor,
        accept: 'application/json',
      },
      cache: 'no-store',
    });
  } catch {
    return UNREACHABLE(deps.env);
  }
  if (upstream.status === 401) {
    return error(401, 'INVALID_TOKEN', 'That token was not accepted. Check it and try again.');
  }
  if (upstream.status === 404) {
    return error(
      502,
      'ADMIN_ROUTES_OFF',
      'The API does not have operator routes enabled. Start it with ENABLE_ADMIN=true.',
    );
  }
  if (!upstream.ok) {
    return error(502, 'SIGN_IN_FAILED', `The API refused the sign in (status ${upstream.status}).`);
  }
  const identity = AdminIdentity.safeParse(await upstream.json().catch(() => null));
  if (!identity.success) {
    return error(502, 'SIGN_IN_FAILED', 'The API answered in a shape the console did not expect.');
  }

  const now = (deps.now ?? Date.now)();
  const session: Session = {
    token,
    actor: identity.data.actor,
    role: identity.data.role,
    expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
  return json(200, toPublicSession(session), {
    'set-cookie': sessionCookie(sealSession(session, deps.env.sessionSecret), requestHost(request)),
  });
}

/** GET /api/session. Who is signed in, for the page shell. */
export function whoAmI(request: Request, deps: Deps): Response {
  const session = sessionFromRequest(request, deps.env.sessionSecret);
  if (!session) return error(401, 'SESSION_REQUIRED', 'Sign in to use the console.');
  return json(200, toPublicSession(session));
}

/** DELETE /api/session. Clears the cookie whether or not it held a session. */
export function signOut(request: Request, deps: Deps): Response {
  if (!isSameOrigin(request, deps.env.allowedOrigins)) return CSRF_REFUSAL();
  return json(200, { ok: true }, { 'set-cookie': clearedSessionCookie(requestHost(request)) });
}

/**
 * GET or POST /api/admin/<path>. Forwards an allowlisted request to the API with the
 * session's bearer token and actor attached, and passes the status and JSON body back.
 * Request cookies and headers are not forwarded, and upstream headers are not passed back.
 */
export async function proxy(
  request: Request,
  segments: readonly string[],
  deps: Deps,
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (needsOriginCheck(method) && !isSameOrigin(request, deps.env.allowedOrigins)) {
    return CSRF_REFUSAL();
  }
  const host = requestHost(request);
  const session = sessionFromRequest(request, deps.env.sessionSecret);
  if (!session) {
    // A cookie that no longer opens (expired, another secret) is removed on the way out.
    const stale = readSessionCookie(request.headers.get('cookie')) !== null;
    return error(
      401,
      'SESSION_REQUIRED',
      'Sign in to use the console.',
      stale ? { 'set-cookie': clearedSessionCookie(host) } : {},
    );
  }
  const path = upstreamPath(method, segments);
  if (!path) return error(404, 'NOT_PROXIED', 'The console does not reach that API route.');

  let body: string | undefined;
  if (method === 'POST') {
    const parsed = await readJson(request);
    if (parsed === undefined) {
      return error(400, 'VALIDATION_ERROR', 'Send a JSON body with content-type application/json.');
    }
    body = JSON.stringify(parsed);
  }

  let upstream: Response;
  try {
    upstream = await deps.fetch(`${deps.env.apiUrl}${path}${new URL(request.url).search}`, {
      method,
      headers: {
        authorization: `Bearer ${session.token}`,
        'x-admin-actor': session.actor,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body,
      cache: 'no-store',
    });
  } catch {
    return UNREACHABLE(deps.env);
  }
  if (upstream.status === 401) {
    // The token stopped working (rotated, or the API restarted with another one).
    return error(401, 'SESSION_REQUIRED', 'Your session is no longer valid. Sign in again.', {
      'set-cookie': clearedSessionCookie(host),
    });
  }
  const text = await upstream.text();
  // A status that cannot carry a body (204, 304) is passed on as an empty 200.
  const status = upstream.status === 204 || upstream.status === 304 ? 200 : upstream.status;
  return new Response(text.length > 0 ? text : 'null', { status, headers: JSON_HEADERS });
}

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type { AdminRole } from '@cashflow/shared';

/**
 * The console session.
 *
 * Signing in hands the server an operator token and the operator's name. The server checks
 * them with the API, then keeps them in one cookie, encrypted with AES-256-GCM under a key
 * derived from OPS_SESSION_SECRET. The cookie is httpOnly, so page scripts cannot read it,
 * and encrypted, so a copy of the cookie jar does not give up the token itself. There is no
 * server-side session store: the console is one process on a staff machine, and a stateless
 * sealed cookie survives a restart.
 *
 * Encrypted rather than only signed, because the payload is a credential: a signature
 * would stop tampering but leave the token readable to anything that can see the cookie.
 */

export const SESSION_COOKIE = 'cashflow_ops_session';
/** Twelve hours: one working day. After that the operator signs in again. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface Session {
  /** The operator bearer token. Server-side only: never put this in a response body. */
  token: string;
  /** The person acting, sent to the API as X-Admin-Actor. */
  actor: string;
  role: AdminRole;
  /** Unix seconds after which the session is no longer accepted. */
  expiresAt: number;
}

/** What the browser is allowed to know about the session. */
export interface PublicSession {
  actor: string;
  role: AdminRole;
  expiresAt: string;
}

export function toPublicSession(session: Session): PublicSession {
  return {
    actor: session.actor,
    role: session.role,
    expiresAt: new Date(session.expiresAt * 1000).toISOString(),
  };
}

const VERSION = 'v1';

function keyFor(secret: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', secret, 'cashflow-ops-session', `session-cookie-${VERSION}`, 32),
  );
}

const b64 = (b: Buffer) => b.toString('base64url');

/** Encrypt a session into a cookie value: `v1.<iv>.<ciphertext>.<tag>`. */
export function sealSession(session: Session, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return [VERSION, b64(iv), b64(body), b64(cipher.getAuthTag())].join('.');
}

/**
 * Decrypt a cookie value. Null for anything that is not a session this secret sealed and
 * that has not expired: a tampered value, another secret, a wrong shape, an old session.
 */
export function unsealSession(
  value: string | null | undefined,
  secret: string,
  now: number = Date.now(),
): Session | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const iv = Buffer.from(parts[1]!, 'base64url');
    const tag = Buffer.from(parts[3]!, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), iv);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([
      decipher.update(Buffer.from(parts[2]!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(text) as Partial<Session>;
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.actor !== 'string' ||
      (parsed.role !== 'reviewer' && parsed.role !== 'admin') ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    if (parsed.expiresAt * 1000 <= now) return null;
    return {
      token: parsed.token,
      actor: parsed.actor,
      role: parsed.role,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

/** True for the names a browser treats as the local machine, where plain http is expected. */
export function isLocalHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const name = host
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
  return (
    name === 'localhost' || name === '127.0.0.1' || name === '::1' || name.endsWith('.localhost')
  );
}

/** The `Host` the request was made to. */
export function requestHost(request: Request): string {
  return request.headers.get('host') ?? new URL(request.url).host;
}

/**
 * `Set-Cookie` for a sealed session. httpOnly and SameSite=Strict always; Secure unless the
 * console is being used on localhost, where there is no TLS.
 */
export function sessionCookie(value: string, host: string, maxAge = SESSION_TTL_SECONDS): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(isLocalHost(host) ? [] : ['Secure']),
  ].join('; ');
}

/** `Set-Cookie` that removes the session. Same attributes, empty value, already expired. */
export function clearedSessionCookie(host: string): string {
  return `${sessionCookie('', host, 0)}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

/** The raw session cookie value from a `Cookie` header. */
export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/** The session a request carries, or null. */
export function sessionFromRequest(request: Request, secret: string | null): Session | null {
  if (!secret) return null;
  return unsealSession(readSessionCookie(request.headers.get('cookie')), secret);
}

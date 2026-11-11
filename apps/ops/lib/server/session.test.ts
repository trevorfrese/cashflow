import { describe, expect, it } from 'vitest';

import {
  clearedSessionCookie,
  isLocalHost,
  readSessionCookie,
  sealSession,
  SESSION_COOKIE,
  sessionCookie,
  sessionFromRequest,
  toPublicSession,
  unsealSession,
  type Session,
} from './session';

const SECRET = 'a-test-secret-of-at-least-thirty-two-chars';
const TOKEN = 'operator-token-0123456789abcdef0123456789';
const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);
const session: Session = {
  token: TOKEN,
  actor: 'pat@cashflow.example',
  role: 'reviewer',
  expiresAt: Math.floor(NOW / 1000) + 3600,
};

describe('sealed session', () => {
  it('round trips under the same secret', () => {
    const sealed = sealSession(session, SECRET);
    expect(unsealSession(sealed, SECRET, NOW)).toEqual(session);
  });

  it('does not contain the token, the actor, or the role in readable form', () => {
    const sealed = sealSession(session, SECRET);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain('pat@cashflow.example');
    for (const part of sealed.split('.').slice(1)) {
      const decoded = Buffer.from(part, 'base64url').toString('utf8');
      expect(decoded).not.toContain(TOKEN);
      expect(decoded).not.toContain('reviewer');
    }
  });

  it('seals to a different value every time', () => {
    expect(sealSession(session, SECRET)).not.toBe(sealSession(session, SECRET));
  });

  it('refuses another secret, a tampered value, and a wrong shape', () => {
    const sealed = sealSession(session, SECRET);
    expect(unsealSession(sealed, 'another-secret-of-at-least-thirty-two-ch', NOW)).toBeNull();
    const parts = sealed.split('.');
    const body = Buffer.from(parts[2]!, 'base64url');
    body[0] = body[0]! ^ 1;
    const tampered = [parts[0], parts[1], body.toString('base64url'), parts[3]].join('.');
    expect(unsealSession(tampered, SECRET, NOW)).toBeNull();
    expect(unsealSession(sealed.replace(/^v1/, 'v2'), SECRET, NOW)).toBeNull();
    expect(unsealSession('not-a-session', SECRET, NOW)).toBeNull();
    expect(unsealSession('', SECRET, NOW)).toBeNull();
    expect(unsealSession(null, SECRET, NOW)).toBeNull();
    expect(unsealSession('v1.a.b.c', SECRET, NOW)).toBeNull();
  });

  it('refuses an expired session and a payload that is not a session', () => {
    const sealed = sealSession(session, SECRET);
    expect(unsealSession(sealed, SECRET, session.expiresAt * 1000)).toBeNull();
    expect(unsealSession(sealed, SECRET, session.expiresAt * 1000 - 1)).not.toBeNull();
    const wrongRole = sealSession({ ...session, role: 'owner' as 'admin' }, SECRET);
    expect(unsealSession(wrongRole, SECRET, NOW)).toBeNull();
  });

  it('gives the browser the actor, role, and expiry, and not the token', () => {
    const view = toPublicSession(session);
    expect(view).toEqual({
      actor: 'pat@cashflow.example',
      role: 'reviewer',
      expiresAt: '2026-11-11T10:00:00.000Z',
    });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
  });
});

describe('session cookie', () => {
  it('is httpOnly and SameSite=Strict, and not Secure on localhost', () => {
    for (const host of ['localhost:3200', '127.0.0.1:3200', '[::1]:3200', 'ops.localhost']) {
      const cookie = sessionCookie('abc', host);
      expect(cookie).toBe(
        `${SESSION_COOKIE}=abc; Path=/; Max-Age=43200; HttpOnly; SameSite=Strict`,
      );
    }
  });

  it('is Secure anywhere else', () => {
    for (const host of ['ops.internal.example', '10.0.0.5:3200', 'localhost.evil.example']) {
      expect(sessionCookie('abc', host)).toMatch(/; HttpOnly; SameSite=Strict; Secure$/);
    }
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('LOCALHOST:3200')).toBe(true);
    expect(isLocalHost('notlocalhost')).toBe(false);
    expect(isLocalHost(null)).toBe(false);
  });

  it('clears with an empty value that has already expired', () => {
    const cookie = clearedSessionCookie('localhost:3200');
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('is read back out of a Cookie header among others', () => {
    expect(readSessionCookie(`theme=dark; ${SESSION_COOKIE}=v1.a.b.c; other=1`)).toBe('v1.a.b.c');
    expect(readSessionCookie('theme=dark')).toBeNull();
    expect(readSessionCookie(`x${SESSION_COOKIE}=nope`)).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
    expect(readSessionCookie(null)).toBeNull();
  });

  it('resolves a request to its session, and to nothing without a secret', () => {
    const sealed = sealSession(
      { ...session, expiresAt: Math.floor(Date.now() / 1000) + 60 },
      SECRET,
    );
    const request = new Request('http://localhost:3200/api/session', {
      headers: { cookie: `${SESSION_COOKIE}=${sealed}` },
    });
    expect(sessionFromRequest(request, SECRET)?.actor).toBe('pat@cashflow.example');
    expect(sessionFromRequest(request, null)).toBeNull();
    expect(sessionFromRequest(new Request('http://localhost:3200/'), SECRET)).toBeNull();
  });
});

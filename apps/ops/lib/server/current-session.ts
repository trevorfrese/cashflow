import { cookies } from 'next/headers';

import { loadEnv } from './env';
import { SESSION_COOKIE, unsealSession, type Session } from './session';

/**
 * The session of the request being rendered, for server components. Null when there is no
 * valid session cookie. The route handlers read the cookie from the request themselves.
 */
export async function currentSession(): Promise<Session | null> {
  const secret = loadEnv().sessionSecret;
  if (!secret) return null;
  const store = await cookies();
  return unsealSession(store.get(SESSION_COOKIE)?.value, secret);
}

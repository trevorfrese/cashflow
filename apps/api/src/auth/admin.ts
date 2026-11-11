import { createHash, timingSafeEqual } from 'node:crypto';

import type { AdminIdentity, AdminRole } from '@cashflow/shared';
import type { FastifyRequest } from 'fastify';

import type { Config } from '../config.ts';
import { AppError, badRequest, forbidden, unauthorized } from '../errors.ts';

/**
 * Access control for the operator routes.
 *
 * Two roles, each a bearer token from the environment:
 *
 *   reviewer  works the queues (reviews, alerts, lease changes, screening hits, freezes,
 *             re-sending a returned payout) and reads the book.
 *   admin     everything a reviewer can, plus what moves money or changes controls: funding
 *             the pool, running jobs, resetting the circuit breaker, clearing a confirmed
 *             screening match.
 *
 * A token says what role is calling. It does not say who: tokens are shared by a team. So
 * every request must also name the person in the `X-Admin-Actor` header, and that name plus
 * the token's role is the identity written to the audit log. Nothing in a request body can
 * set it.
 *
 * This is deliberately small. It is enough to make the routes safe to enable and the audit
 * trail honest about role, and it is not a user directory: the actor header is asserted by
 * the caller, not proven. Per person credentials (SSO) are the production answer.
 */

export const ADMIN_ACTOR_HEADER = 'x-admin-actor';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireRole` on operator routes. */
    adminIdentity?: AdminIdentity;
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Compare two secrets in constant time. Both are hashed first so the comparison runs over
 * equal lengths whatever was sent, and the length of the real token does not leak.
 */
export function tokensEqual(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** The role a bearer token carries, or null. Every configured token is always compared. */
export function roleForToken(
  token: string,
  config: Pick<Config, 'ADMIN_API_TOKEN' | 'REVIEWER_API_TOKEN'>,
): AdminRole | null {
  const isAdmin = config.ADMIN_API_TOKEN ? tokensEqual(token, config.ADMIN_API_TOKEN) : false;
  const isReviewer = config.REVIEWER_API_TOKEN
    ? tokensEqual(token, config.REVIEWER_API_TOKEN)
    : false;
  return isAdmin ? 'admin' : isReviewer ? 'reviewer' : null;
}

/** A person's name or email: printable, no control characters, 2 to 120 long. */
const ACTOR = /^[\x20-\x7E]{2,120}$/;

export function authenticateAdmin(
  request: FastifyRequest,
  config: Pick<Config, 'ADMIN_API_TOKEN' | 'REVIEWER_API_TOKEN'>,
): AdminIdentity {
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  if (!match) throw unauthorized('Operator routes need a bearer token');
  const role = roleForToken(match[1]!.trim(), config);
  if (!role) throw unauthorized('Invalid operator token');
  const raw = request.headers[ADMIN_ACTOR_HEADER];
  const actor = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!actor || !ACTOR.test(actor)) {
    throw badRequest(
      'ACTOR_REQUIRED',
      'Operator requests must name the person acting in the X-Admin-Actor header',
    );
  }
  return { role, actor };
}

/**
 * A preHandler that lets `reviewer` and `admin` through for 'reviewer', and only `admin` for
 * 'admin'. The resolved identity is on `request.adminIdentity`.
 */
export function requireRole(config: Config, minimum: AdminRole) {
  return async (request: FastifyRequest) => {
    const identity = authenticateAdmin(request, config);
    if (minimum === 'admin' && identity.role !== 'admin') {
      throw forbidden('This action needs the admin role');
    }
    request.adminIdentity = identity;
  };
}

/** The identity `requireRole` resolved. Throws if the route forgot the preHandler. */
export function adminIdentity(request: FastifyRequest): AdminIdentity {
  if (!request.adminIdentity) {
    throw new AppError(500, 'INTERNAL', 'Operator route is missing its role check');
  }
  return request.adminIdentity;
}

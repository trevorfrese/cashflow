import {
  ApiError,
  DevAdvanceRequest,
  DevAdvanceResult,
  DevClock,
  DevFeed,
  DevOverview,
  DevPersonaList,
  DevResetResult,
  DevSession,
  addDays,
} from '@cashflow/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { issueRefreshToken } from '../auth/tokens.ts';
import { todayIso } from '../dates.ts';
import {
  advanceClock,
  clearDevClock,
  loadDevClock,
  nextEventFor,
  readDevClock,
} from '../dev/clock.ts';
import { PERSONA_PASSWORD } from '../dev/personas.ts';
import {
  ensurePersonaUser,
  feed,
  landingFor,
  listPersonas,
  overview,
  personaView,
  requirePersona,
  resetEverything,
  resetPersona,
  withDevLock,
} from '../dev/service.ts';
import { AppError, unprocessable } from '../errors.ts';
import type { User } from '../generated/prisma/client.ts';
import { toUser } from '../serializers.ts';

const KeyParams = z.object({ key: z.string().min(1).max(64) });

/** Loopback and private network addresses: this machine, or a phone on the same network. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (v4 === '::1' || v4 === 'localhost') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(v4);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    );
  }
  const lower = v4.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

/**
 * Keeps "today" in step with the database for the whole API: reads the simulated date when
 * the server starts and again, at most every two seconds, as requests arrive, so a job run
 * from the CLI or the operator console moves the clock here too. Puts the wall clock back
 * when the app closes. Called by `buildApp` only when dev tools are on.
 */
export function installDevClock(app: FastifyInstance): void {
  const { db } = app.ctx;
  const CLOCK_TTL_MS = 2000;
  let loadedAt = 0;
  app.addHook('onReady', async () => {
    await loadDevClock(db);
    loadedAt = Date.now();
  });
  app.addHook('onRequest', async () => {
    if (Date.now() - loadedAt < CLOCK_TTL_MS) return;
    loadedAt = Date.now();
    await loadDevClock(db);
  });
  app.addHook('onClose', async () => {
    clearDevClock();
  });
}

/**
 * Dev tools. Registered by `buildApp` only when `ENABLE_DEV_TOOLS=true`, which `loadConfig`
 * refuses when `NODE_ENV=production`. These routes take no credentials: they hand out
 * sessions for the persona accounts, move the simulated clock, and rebuild the demo data.
 * As a second line of defence they answer 404 to any caller that is not on this machine or
 * a private network.
 */
export async function devRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, config } = app.ctx;

  const guard = async (request: FastifyRequest) => {
    if (!isPrivateAddress(request.ip)) {
      throw new AppError(404, 'NOT_FOUND', `Route ${request.method} ${request.url} not found`);
    }
    // Always current for the dev tools themselves, whatever the hook below last saw.
    await loadDevClock(db);
  };
  // First thing on every dev route, before the body is even validated. This plugin is
  // encapsulated, so the hook covers these routes and no others.
  app.addHook('onRequest', guard);
  // Dev tools poll (the dev home page refreshes every few seconds) and must not eat the
  // rate limit budget of the app under test.
  const open = { config: { rateLimit: false as const } };

  const sessionFor = async (user: User, key: string) => {
    const persona = requirePersona(key);
    const accessToken = app.jwt.sign({ sub: user.id, email: user.email });
    const refreshToken = await issueRefreshToken(db, user.id, config.REFRESH_TOKEN_TTL_DAYS);
    return {
      user: toUser(user),
      tokens: { accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS },
      persona: await personaView(db, persona),
      landing: await landingFor(db, persona, user.id),
    };
  };

  r.get(
    '/dev/personas',
    { ...open, schema: { tags: ['dev'], response: { 200: DevPersonaList } } },
    async () => ({
      clock: readDevClock(),
      password: PERSONA_PASSWORD,
      personas: await listPersonas(db),
    }),
  );

  // Sign in as a persona. The same session shape as POST /v1/auth/login.
  r.post(
    '/dev/personas/:key/session',
    {
      ...open,
      schema: {
        tags: ['dev'],
        params: KeyParams,
        response: { 200: DevSession, 404: ApiError, 409: ApiError },
      },
    },
    async (request) => {
      const persona = requirePersona(request.params.key);
      const user = await ensurePersonaUser(app.ctx, persona);
      return sessionFor(user, persona.key);
    },
  );

  // Rebuild one persona as a new account, and sign in as it.
  r.post(
    '/dev/personas/:key/reset',
    {
      ...open,
      schema: {
        tags: ['dev'],
        params: KeyParams,
        response: { 200: DevSession, 404: ApiError, 409: ApiError },
      },
    },
    async (request) => {
      const persona = requirePersona(request.params.key);
      const user = await withDevLock('persona reset', () => resetPersona(app.ctx, persona));
      return sessionFor(user, persona.key);
    },
  );

  r.get(
    '/dev/clock',
    { ...open, schema: { tags: ['dev'], response: { 200: DevClock } } },
    async () => readDevClock(),
  );

  // Move the clock forward, running every job for each day crossed.
  r.post(
    '/dev/clock/advance',
    {
      ...open,
      schema: {
        tags: ['dev'],
        body: DevAdvanceRequest,
        response: { 200: DevAdvanceResult, 404: ApiError, 409: ApiError, 422: ApiError },
      },
    },
    async (request) =>
      withDevLock('clock advance', async () => {
        const today = todayIso();
        const { days, toDate, toNextEventFor } = request.body;
        if (days !== undefined) return advanceClock(app.ctx, addDays(today, days));
        if (toDate !== undefined) return advanceClock(app.ctx, toDate);
        const persona = requirePersona(toNextEventFor!);
        const user = await ensurePersonaUser(app.ctx, persona);
        const event = await nextEventFor(db, user.id, today);
        if (!event) {
          throw unprocessable(
            'NO_UPCOMING_EVENT',
            `Nothing is scheduled to happen to ${persona.title}. Advance by days instead`,
          );
        }
        return advanceClock(app.ctx, event.date, event);
      }),
  );

  // Wipe everything and rebuild every persona as of the real date.
  r.post(
    '/dev/reset',
    { ...open, schema: { tags: ['dev'], response: { 200: DevResetResult, 409: ApiError } } },
    async () => withDevLock('full reset', () => resetEverything(app.ctx)),
  );

  r.get(
    '/dev/overview',
    { ...open, schema: { tags: ['dev'], response: { 200: DevOverview } } },
    async () => overview(app.ctx),
  );

  r.get('/dev/feed', { ...open, schema: { tags: ['dev'], response: { 200: DevFeed } } }, async () =>
    feed(db),
  );
}

import type {
  DevAdvanceResult,
  DevClock,
  DevFeed,
  DevOverview,
  DevPersonaList,
  DevResetResult,
  DevSession,
} from '@cashflow/shared';
import { addDays } from '@cashflow/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../config.ts';
import { devClockAhead, todayIso } from '../dates.ts';
import { PERSONAS } from '../dev/personas.ts';
import {
  adminClient,
  client,
  createTestApp,
  demoLease,
  resetDb,
  runJobsAsOf,
  type Session,
  type TestHarness,
} from '../test/helpers.ts';

const wall = () => new Date().toISOString().slice(0, 10);

const DEV_PATHS: Array<['GET' | 'POST', string]> = [
  ['GET', '/v1/dev/personas'],
  ['POST', '/v1/dev/personas/active-plan/session'],
  ['POST', '/v1/dev/personas/declined/reset'],
  ['GET', '/v1/dev/clock'],
  ['POST', '/v1/dev/clock/advance'],
  ['POST', '/v1/dev/reset'],
  ['GET', '/v1/dev/overview'],
  ['GET', '/v1/dev/feed'],
];

describe('dev tools off (the default)', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createTestApp();
    await resetDb(h.db);
  });
  afterAll(async () => {
    await h.close();
  });

  it('is off in the configuration the suites run with', () => {
    expect(h.app.ctx.config.ENABLE_DEV_TOOLS).toBe(false);
  });

  it('does not register any dev route: each is a plain 404, not a 401 or 403', async () => {
    for (const [method, url] of DEV_PATHS) {
      const res = await h.app.inject({
        method,
        url,
        ...(method === 'POST'
          ? {
              payload: JSON.stringify({ days: 1 }),
              headers: { 'content-type': 'application/json' },
            }
          : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json().error.code).toBe('NOT_FOUND');
    }
    const routes = h.app.printRoutes({ commonPrefix: false });
    expect(routes).not.toContain('/v1/dev');
  });

  it('is not unlocked by an operator token either', async () => {
    const res = await adminClient(h.app).get('/v1/dev/personas');
    expect(res.status).toBe(404);
  });

  it('leaves the clock on the wall clock even after jobs ran for a future date', async () => {
    await runJobsAsOf(h.app, addDays(wall(), 5));
    // A request after the run: with dev tools on this is where the clock would move.
    await client(h.app).get('/health');
    expect(devClockAhead()).toBeNull();
    expect(todayIso()).toBe(wall());
  });

  it('cannot be turned on in production', () => {
    expect(() =>
      loadConfig({ ...process.env, NODE_ENV: 'production', ENABLE_DEV_TOOLS: 'true' }),
    ).toThrow(/Refusing to start: ENABLE_DEV_TOOLS=true with NODE_ENV=production/);
  });
});

describe('dev tools on', () => {
  let h: TestHarness;
  let dev: ReturnType<typeof client>;
  let seeded: DevResetResult;

  const signInAs = async (key: string): Promise<{ session: Session; body: DevSession }> => {
    const res = await dev.post<DevSession>(`/v1/dev/personas/${key}/session`);
    expect(res.status, `session for ${key}: ${JSON.stringify(res.body)}`).toBe(200);
    return {
      body: res.body,
      session: {
        accessToken: res.body.tokens.accessToken,
        refreshToken: res.body.tokens.refreshToken,
        userId: res.body.user.id,
      },
    };
  };
  const personas = async () => (await dev.get<DevPersonaList>('/v1/dev/personas')).body;
  const stateOf = async (key: string) => (await personas()).personas.find((p) => p.key === key)!;
  const ledgerEntries = () => h.db.ledgerEntry.count();
  const trialBalance = async () =>
    (
      await adminClient(h.app).get<{
        balanced: boolean;
        totalDebitsCents: number;
        totalCreditsCents: number;
      }>('/v1/admin/ledger/trial-balance')
    ).body;

  beforeAll(async () => {
    h = await createTestApp({ ENABLE_DEV_TOOLS: 'true' });
    dev = client(h.app);
    const res = await dev.post<DevResetResult>('/v1/dev/reset');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    seeded = res.body;
  }, 120_000);
  afterAll(async () => {
    await h.close();
  });

  it('seeds every persona in the state it is for', () => {
    expect(seeded.clock).toEqual({ today: wall(), wallToday: wall(), aheadDays: 0 });
    expect(seeded.personas.map((p) => p.key)).toEqual(PERSONAS.map((p) => p.key));
    const label = Object.fromEntries(seeded.personas.map((p) => [p.key, p.state.label]));
    expect(label).toEqual({
      'active-plan': 'Active plan, current',
      delinquent: 'Delinquent, payout held',
      'charged-off': 'Written off, plan closed',
      'landlord-change': 'Active plan, payout held',
      'pass-through': 'Pass-through plan, current',
      'pass-through-missed': 'Pass-through, last month missed',
      'graduation-offer': 'Pass-through, graduation offered',
      'pass-through-offer': 'Declined, free plan available',
      declined: 'Declined',
      'needs-info': 'Needs info',
      'manual-review': 'In review',
      'identity-review': 'In review',
      'counter-offer': 'Approved below the lease rent',
      'fresh-approved': 'Nothing created yet',
      'fresh-declined': 'Nothing created yet',
      'fresh-referred': 'Nothing created yet',
      'fresh-counter-offer': 'Nothing created yet',
      'payout-account': 'Active plan, current',
      'ownership-review': 'In review',
      'toast-seat': 'Business set up, not applied',
      'fresh-payout-elsewhere': 'Nothing created yet',
      'fresh-ownership': 'Nothing created yet',
      'fresh-toast': 'Nothing created yet',
    });
    for (const p of seeded.personas) {
      expect(p.state.exists).toBe(true);
      // Everything but replayed history can be rebuilt on its own.
      expect(p.resettable, p.key).toBe(
        p.group === 'FRESH' ||
          p.section === 'Decisions' ||
          p.section === 'Data connections' ||
          p.key === 'pass-through-offer',
      );
      expect(p.walkthrough === null).toBe(p.group !== 'FRESH');
    }
  });

  it('signs in as every persona with a normal session, and its screens load', async () => {
    for (const persona of PERSONAS) {
      const { session, body } = await signInAs(persona.key);
      expect(body.persona.key).toBe(persona.key);
      expect(body.user.email).toBe(persona.email);
      expect(body.tokens.expiresIn).toBeGreaterThan(0);
      const api = client(h.app, session);
      const me = await api.get<{ email: string }>('/v1/me');
      expect(me.status).toBe(200);
      expect(me.body.email).toBe(persona.email);

      const businesses = await api.get<Array<{ id: string }>>('/v1/businesses');
      expect(businesses.status).toBe(200);
      expect(businesses.body.length).toBe(persona.group === 'FRESH' ? 0 : 1);
      expect(body.landing.screen).toBe(
        persona.group === 'FRESH' ? 'BUSINESS_NEW' : persona.landing,
      );
      if (body.landing.screen === 'APPLICATION') {
        const application = await api.get(
          `/v1/underwriting/applications/${body.landing.applicationId}`,
        );
        expect(application.status).toBe(200);
      }
      for (const business of businesses.body) {
        for (const path of ['applications', 'leases', 'rent-plans', 'bank-links']) {
          const res = await api.get(`/v1/businesses/${business.id}/${path}`);
          expect(res.status, `${persona.key} ${path}`).toBe(200);
        }
        const plans = await api.get<Array<{ id: string }>>(
          `/v1/businesses/${business.id}/rent-plans`,
        );
        for (const plan of plans.body) {
          for (const path of ['', '/installments', '/payouts', '/repayments']) {
            const res = await api.get(`/v1/rent-plans/${plan.id}${path}`);
            expect(res.status, `${persona.key} plan${path}`).toBe(200);
          }
        }
      }
      // The refresh token is a real one.
      const refreshed = await client(h.app).post('/v1/auth/refresh', {
        refreshToken: session.refreshToken,
      });
      expect(refreshed.status).toBe(200);
    }
  });

  it('gives each persona the demo password as well', async () => {
    const list = await personas();
    const res = await client(h.app).post('/v1/auth/login', {
      email: 'delinquent@cashflow.local',
      password: list.password,
    });
    expect(res.status).toBe(200);
  });

  it('refuses a persona it does not know, with the list of the ones it does', async () => {
    const res = await dev.post<{ error: { code: string; message: string } }>(
      '/v1/dev/personas/nobody/session',
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PERSONA_NOT_FOUND');
    expect(res.body.error.message).toContain('active-plan');
  });

  it('answers 404 to a caller that is not on a private network', async () => {
    for (const [method, url] of DEV_PATHS) {
      const res = await h.app.inject({ method, url, remoteAddress: '8.8.8.8' });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/dev/clock',
      remoteAddress: '192.168.1.44',
    });
    expect(res.statusCode).toBe(200);
  });

  describe('fresh applicants', () => {
    /** Walks the preset over HTTP exactly as the app does and returns the decided application. */
    const walk = async (key: string) => {
      const { session, body } = await signInAs(key);
      const w = body.persona.walkthrough!;
      const api = client(h.app, session);
      const business = await api.post<{ id: string }>('/v1/businesses', w.business);
      expect(business.status, JSON.stringify(business.body)).toBe(201);
      const bank = await api.post<{ id: string }>('/v1/bank-links', {
        businessId: business.body.id,
        publicToken: w.bankPublicToken,
      });
      expect(bank.status, JSON.stringify(bank.body)).toBe(201);
      // The point of sale, the way the app connects it: a seat for Toast, OAuth otherwise.
      let commerceLinkId: string | undefined;
      if (w.pos) {
        if (w.pos.platform === 'TOAST') {
          const seat = await api.post<{ connection: { id: string } }>('/v1/connections/seats', {
            businessId: business.body.id,
            platform: w.pos.platform,
            scenario: w.pos.scenario,
          });
          const checked = await api.post<{ id: string; status: string }>(
            `/v1/connections/${seat.body.connection.id}/verify-seat`,
          );
          expect(checked.body.status, JSON.stringify(checked.body)).toBe('LINKED');
          commerceLinkId = checked.body.id;
        } else {
          const started = await api.post<{ state: string }>('/v1/connections/oauth/start', {
            businessId: business.body.id,
            platform: w.pos.platform,
          });
          const approved = await api.post<{ code: string }>(
            '/v1/connections/oauth/mock-authorize',
            {
              state: started.body.state,
              scenario: w.pos.scenario,
            },
          );
          const linked = await api.post<{ id: string }>('/v1/connections/oauth/callback', {
            state: started.body.state,
            code: approved.body.code,
          });
          expect(linked.status, JSON.stringify(linked.body)).toBe(201);
          commerceLinkId = linked.body.id;
        }
      }
      const application = await api.post<{ id: string }>('/v1/underwriting/applications', {
        businessId: business.body.id,
        statedMonthlyRevenueCents: w.business.statedMonthlyRevenueCents,
        timeInBusinessMonths: w.timeInBusinessMonths,
        requestedMonthlyRentCents: w.requestedMonthlyRentCents,
        bankLinkId: bank.body.id,
        ...(commerceLinkId ? { commerceLinkId } : {}),
      });
      const decided = await api.post<{
        id: string;
        status: string;
        decision: {
          approvedMonthlyLimitCents: number | null;
          reasons: Array<{ code: string }>;
        } | null;
      }>(`/v1/underwriting/applications/${application.body.id}/submit`);
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      return { api, session, w, businessId: business.body.id, application: decided.body };
    };

    it('approved: the preset is approved for the rent it asks for', async () => {
      const { application, w } = await walk('fresh-approved');
      expect(application.status).toBe('APPROVED');
      expect(application.decision!.approvedMonthlyLimitCents).toBeGreaterThanOrEqual(
        w.requestedMonthlyRentCents,
      );
      expect((await stateOf('fresh-approved')).state.label).toBe('Approved, no lease yet');
    });

    it('declined: the preset is declined for overdrafts', async () => {
      const { application } = await walk('fresh-declined');
      expect(application.status).toBe('DECLINED');
      expect(application.decision!.reasons.map((r) => r.code)).toContain('EXCESSIVE_OVERDRAFTS');
    });

    it('referred: the preset goes to manual review', async () => {
      const { application } = await walk('fresh-referred');
      expect(application.status).toBe('IN_REVIEW');
    });

    it('payout elsewhere: the preset is asked to connect the payout account', async () => {
      const { application } = await walk('fresh-payout-elsewhere');
      expect(application.status).toBe('NEEDS_INFO');
      expect(application.decision!.reasons.map((r) => r.code)).toEqual([
        'PAYOUT_ACCOUNT_NOT_CONNECTED',
      ]);
    });

    it("ownership: the preset with another business's account goes to manual review", async () => {
      const { application } = await walk('fresh-ownership');
      expect(application.status).toBe('IN_REVIEW');
    });

    it('toast: the preset connects through a seat and is approved', async () => {
      const { application, w } = await walk('fresh-toast');
      expect(application.status).toBe('APPROVED');
      expect(application.decision!.approvedMonthlyLimitCents).toBeGreaterThanOrEqual(
        w.requestedMonthlyRentCents,
      );
    });

    it('counter offer: the preset is approved for less than it asked for', async () => {
      const { application, w, api, businessId } = await walk('fresh-counter-offer');
      expect(application.status).toBe('APPROVED');
      const limit = application.decision!.approvedMonthlyLimitCents!;
      expect(limit).toBeLessThan(w.requestedMonthlyRentCents);
      expect(application.decision!.reasons.map((r) => r.code)).toContain('LIMIT_BELOW_REQUEST');
      // The product funds a whole lease or nothing: the lease at the requested rent is refused.
      const lease = await api.post<{ id: string }>(
        '/v1/leases',
        demoLease(businessId, {
          monthlyRentCents: w.requestedMonthlyRentCents,
          landlordPayout: {
            accountHolderName: 'Lombard Street Holdings LLC',
            routingNumber: '123456789',
            accountNumberLast4: '7711',
            providerToken: 'mock_landlord_lombard',
          },
        }),
      );
      expect(lease.status).toBe(201);
      const plan = await api.post<{ error: { code: string } }>('/v1/rent-plans', {
        leaseId: lease.body.id,
        applicationId: application.id,
        installmentsPerMonth: 2,
      });
      expect(plan.status).toBe(422);
      expect(plan.body.error.code).toBe('RENT_OVER_LIMIT');
    });
  });

  describe('the seeded counter offer', () => {
    it('cannot start a plan on its lease', async () => {
      const { session } = await signInAs('counter-offer');
      const api = client(h.app, session);
      const [business] = (await api.get<Array<{ id: string }>>('/v1/businesses')).body;
      const [lease] = (
        await api.get<Array<{ id: string }>>(`/v1/businesses/${business!.id}/leases`)
      ).body;
      const [application] = (
        await api.get<Array<{ id: string }>>(`/v1/businesses/${business!.id}/applications`)
      ).body;
      const plan = await api.post<{ error: { code: string } }>('/v1/rent-plans', {
        leaseId: lease!.id,
        applicationId: application!.id,
        installmentsPerMonth: 2,
      });
      expect(plan.status).toBe(422);
      expect(plan.body.error.code).toBe('RENT_OVER_LIMIT');
    });
  });

  describe('reset this persona', () => {
    it('rebuilds only that account, with new ids, and deletes nothing from the ledger', async () => {
      const before = await signInAs('declined');
      const others = Object.fromEntries(
        (await h.db.user.findMany({ where: { email: { not: 'declined@cashflow.local' } } })).map(
          (u) => [u.email, u.id],
        ),
      );
      const businessesBefore = await h.db.business.count();
      const entriesBefore = await ledgerEntries();
      const transactionsBefore = await h.db.ledgerTransaction.count();
      const tbBefore = await trialBalance();

      const res = await dev.post<DevSession>('/v1/dev/personas/declined/reset');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.user.email).toBe('declined@cashflow.local');
      expect(res.body.user.id).not.toBe(before.session.userId);
      expect(res.body.persona.state.label).toBe('Declined');
      expect(res.body.landing.screen).toBe('APPLICATION');

      // The old account never had a plan, so it had no ledger postings and is gone.
      expect(await h.db.user.findUnique({ where: { id: before.session.userId } })).toBeNull();
      expect(await h.db.business.count()).toBe(businessesBefore);
      const after = Object.fromEntries(
        (await h.db.user.findMany({ where: { email: { not: 'declined@cashflow.local' } } })).map(
          (u) => [u.email, u.id],
        ),
      );
      expect(after).toEqual(others);
      expect(await ledgerEntries()).toBe(entriesBefore);
      expect(await h.db.ledgerTransaction.count()).toBe(transactionsBefore);
      const tbAfter = await trialBalance();
      expect(tbAfter.balanced).toBe(true);
      expect(tbAfter.totalDebitsCents).toBe(tbBefore.totalDebitsCents);

      // The old session is dead: its user no longer exists.
      const me = await client(h.app, before.session).get('/v1/me');
      expect(me.status).toBe(401);
    });

    it('archives an account that opened a plan, because ledger rows cannot be deleted', async () => {
      // fresh-approved was walked to an approval above. Give it a lease and a plan: opening
      // a plan is what gives a business its place in the ledger.
      const { session } = await signInAs('fresh-approved');
      const api = client(h.app, session);
      const [business] = (await api.get<Array<{ id: string }>>('/v1/businesses')).body;
      const [application] = (
        await api.get<Array<{ id: string }>>(`/v1/businesses/${business!.id}/applications`)
      ).body;
      const today = todayIso();
      const dueDay = Math.min(28, Number(today.slice(8, 10)));
      const lease = await api.post<{ id: string }>(
        '/v1/leases',
        demoLease(business!.id, {
          monthlyRentCents: 520_000,
          dueDayOfMonth: dueDay,
          startsOn: addDays(today, -40),
          landlordPayout: {
            accountHolderName: 'Foster Road Properties LLC',
            routingNumber: '123456789',
            accountNumberLast4: '2468',
            providerToken: 'mock_landlord_foster',
          },
        }),
      );
      expect(lease.status, JSON.stringify(lease.body)).toBe(201);
      const plan = await api.post<{ id: string }>('/v1/rent-plans', {
        leaseId: lease.body.id,
        applicationId: application!.id,
        installmentsPerMonth: 2,
      });
      expect(plan.status, JSON.stringify(plan.body)).toBe(201);
      expect((await stateOf('fresh-approved')).state.label).toBe('Active plan, current');
      const entriesBefore = await ledgerEntries();

      const res = await dev.post<DevSession>('/v1/dev/personas/fresh-approved/reset');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.user.id).not.toBe(session.userId);
      expect(res.body.persona.state.label).toBe('Nothing created yet');
      expect(res.body.landing.screen).toBe('BUSINESS_NEW');

      const old = await h.db.user.findUniqueOrThrow({ where: { id: session.userId } });
      expect(old.email).toMatch(/^archived-.+-fresh-approved@cashflow\.local$/);
      const oldPlan = await h.db.rentPlan.findUniqueOrThrow({ where: { id: plan.body.id } });
      expect(oldPlan.status).toBe('CLOSED');
      expect(oldPlan.closedReason).toBe('DEV_ARCHIVED');
      const oldBusiness = await h.db.business.findUniqueOrThrow({ where: { id: business!.id } });
      expect(oldBusiness.legalName).toContain('(archived');
      expect(await ledgerEntries()).toBeGreaterThanOrEqual(entriesBefore);
      expect((await trialBalance()).balanced).toBe(true);
      // The old login cannot refresh.
      const refreshed = await client(h.app).post('/v1/auth/refresh', {
        refreshToken: session.refreshToken,
      });
      expect(refreshed.status).toBe(401);

      // The same preset is approved again for the new account: the archived business does
      // not trip the duplicate bank account or duplicate identity checks.
      const w = res.body.persona.walkthrough!;
      const again = client(h.app, {
        accessToken: res.body.tokens.accessToken,
        refreshToken: res.body.tokens.refreshToken,
        userId: res.body.user.id,
      });
      const b = await again.post<{ id: string }>('/v1/businesses', w.business);
      const bank = await again.post<{ id: string }>('/v1/bank-links', {
        businessId: b.body.id,
        publicToken: w.bankPublicToken,
      });
      const draft = await again.post<{ id: string }>('/v1/underwriting/applications', {
        businessId: b.body.id,
        statedMonthlyRevenueCents: w.business.statedMonthlyRevenueCents,
        timeInBusinessMonths: w.timeInBusinessMonths,
        requestedMonthlyRentCents: w.requestedMonthlyRentCents,
        bankLinkId: bank.body.id,
      });
      const decided = await again.post<{ status: string }>(
        `/v1/underwriting/applications/${draft.body.id}/submit`,
      );
      expect(decided.body.status).toBe('APPROVED');
    });

    it('refuses a persona whose state is replayed ledger history, and says what to do', async () => {
      for (const key of [
        'active-plan',
        'delinquent',
        'charged-off',
        'landlord-change',
        'pass-through',
        'pass-through-missed',
        'graduation-offer',
      ]) {
        const res = await dev.post<{ error: { code: string; message: string } }>(
          `/v1/dev/personas/${key}/reset`,
        );
        expect(res.status, key).toBe(409);
        expect(res.body.error.code).toBe('PERSONA_NEEDS_FULL_RESET');
        expect(res.body.error.message).toContain('POST /v1/dev/reset');
      }
    });
  });

  describe('the simulated clock', () => {
    it('starts on the real date', async () => {
      const clock = await dev.get<DevClock>('/v1/dev/clock');
      expect(clock.status).toBe(200);
      expect(clock.body).toEqual({ today: wall(), wallToday: wall(), aheadDays: 0 });
    });

    it('validates the request', async () => {
      expect((await dev.post('/v1/dev/clock/advance', {})).status).toBe(400);
      expect((await dev.post('/v1/dev/clock/advance', { days: 0 })).status).toBe(400);
      expect((await dev.post('/v1/dev/clock/advance', { days: 121 })).status).toBe(400);
      expect((await dev.post('/v1/dev/clock/advance', { days: 1, toDate: wall() })).status).toBe(
        400,
      );
      const back = await dev.post<{ error: { code: string } }>('/v1/dev/clock/advance', {
        toDate: addDays(wall(), -1),
      });
      expect(back.status).toBe(422);
      expect(back.body.error.code).toBe('CLOCK_ONLY_FORWARD');
      const unknown = await dev.post('/v1/dev/clock/advance', { toNextEventFor: 'nobody' });
      expect(unknown.status).toBe(404);
    });

    it('advances a day at a time, runs every job for each day, and moves today everywhere', async () => {
      const { session } = await signInAs('delinquent');
      const api = client(h.app, session);
      const [business] = (await api.get<Array<{ id: string }>>('/v1/businesses')).body;
      const planOf = async () =>
        (
          await api.get<Array<{ id: string; daysPastDue: number }>>(
            `/v1/businesses/${business!.id}/rent-plans`,
          )
        ).body[0]!;
      const before = await planOf();
      expect(before.daysPastDue).toBeGreaterThan(0);

      const res = await dev.post<DevAdvanceResult>('/v1/dev/clock/advance', { days: 2 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.from).toBe(wall());
      expect(res.body.to).toBe(addDays(wall(), 2));
      expect(res.body.days).toBe(2);
      expect(res.body.clock).toEqual({
        today: addDays(wall(), 2),
        wallToday: wall(),
        aheadDays: 2,
      });
      expect(res.body.jobFailures).toEqual([]);
      expect(res.body.changes.length).toBeGreaterThan(0);

      // Every job ran once for each day crossed.
      for (const day of [addDays(wall(), 1), addDays(wall(), 2)]) {
        const runs = await h.db.jobRun.findMany({ where: { asOf: day } });
        expect(runs.length, day).toBe(12);
        expect(runs.every((r) => r.ok)).toBe(true);
      }

      // One source of truth: the process clock, the dev route, and an owner-facing derived
      // field all agree on the new date.
      expect(todayIso()).toBe(addDays(wall(), 2));
      expect((await dev.get<DevClock>('/v1/dev/clock')).body.today).toBe(addDays(wall(), 2));
      const after = await planOf();
      expect(after.daysPastDue).toBe(before.daysPastDue + 2);
    });

    it('advances to the next event for a persona and reports what changed', async () => {
      const next = (await stateOf('active-plan')).nextEvent;
      expect(next).not.toBeNull();
      expect(next!.date > todayIso()).toBe(true);
      const res = await dev.post<DevAdvanceResult>('/v1/dev/clock/advance', {
        toNextEventFor: 'active-plan',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.to).toBe(next!.date);
      expect(res.body.event).toEqual(next);
      expect(res.body.clock.today).toBe(next!.date);

      // Keep going until the bakery's next landlord payout has been made and collected on.
      let paid = res.body.summary.payoutsPaid;
      let collected = res.body.summary.installmentsCollected;
      for (let i = 0; i < 6 && (paid === 0 || collected === 0); i++) {
        const step = await dev.post<DevAdvanceResult>('/v1/dev/clock/advance', {
          toNextEventFor: 'active-plan',
        });
        expect(step.status, JSON.stringify(step.body)).toBe(200);
        paid += step.body.summary.payoutsPaid;
        collected += step.body.summary.installmentsCollected;
      }
      expect(paid).toBeGreaterThan(0);
      expect(collected).toBeGreaterThan(0);
      expect((await trialBalance()).balanced).toBe(true);
    });

    it('follows a job run made outside the dev routes', async () => {
      const target = addDays(todayIso(), 1);
      await runJobsAsOf(h.app, target);
      expect((await dev.get<DevClock>('/v1/dev/clock')).body.today).toBe(target);
    });
  });

  describe('the dev home feeds', () => {
    it('shows the system at a glance', async () => {
      const res = await dev.get<DevOverview>('/v1/dev/overview');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.environment.nodeEnv).toBe('test');
      expect(res.body.environment.providers.payments).toBe('mock');
      expect(res.body.counts.businesses).toBeGreaterThanOrEqual(9);
      expect(res.body.counts.plans).toBeGreaterThanOrEqual(4);
      expect(Object.keys(res.body.counts.plansByStanding)).toContain('CHARGED_OFF');
      expect(res.body.ledger.balanced).toBe(true);
      expect(res.body.ledger.totalDebitsCents).toBe(res.body.ledger.totalCreditsCents);
    });

    it('lists what just happened, newest first, and changes nothing', async () => {
      const entries = await ledgerEntries();
      const audits = await h.db.auditEvent.count();
      const res = await dev.get<DevFeed>('/v1/dev/feed');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.jobRuns.length).toBe(30);
      expect(res.body.jobRuns[0]!.asOf).toBe(todayIso());
      expect(res.body.auditEvents.length).toBeGreaterThan(0);
      expect(res.body.alerts.length).toBeGreaterThan(0);
      expect(await ledgerEntries()).toBe(entries);
      expect(await h.db.auditEvent.count()).toBe(audits);
    });
  });

  describe('reset everything', () => {
    it('rebuilds the demo data and puts the clock back on the real date', async () => {
      expect((await dev.get<DevClock>('/v1/dev/clock')).body.aheadDays).toBeGreaterThan(0);
      const res = await dev.post<DevResetResult>('/v1/dev/reset');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.clock).toEqual({ today: wall(), wallToday: wall(), aheadDays: 0 });
      expect(todayIso()).toBe(wall());
      expect(res.body.personas.find((p) => p.key === 'fresh-approved')!.state.label).toBe(
        'Nothing created yet',
      );
      // Archived accounts are gone with everything else.
      expect(await h.db.user.count({ where: { email: { startsWith: 'archived-' } } })).toBe(0);
      expect(await h.db.user.count()).toBe(PERSONAS.length);
      expect((await trialBalance()).balanced).toBe(true);
    }, 120_000);
  });
});

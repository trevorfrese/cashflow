/**
 * Dev tools: personas as accounts, per-persona and full resets, and the read models behind
 * the dev menu and the dev home page. Reached only through `src/routes/dev.ts`, which is
 * registered only with `ENABLE_DEV_TOOLS=true`.
 */
import type {
  DevFeed,
  DevLandingScreen,
  DevOverview,
  DevPersona,
  DevPersonaState,
} from '@cashflow/shared';
import type { IsoDate } from '@cashflow/shared';

import { hashPassword } from '../auth/password.ts';
import type { AppContext } from '../context.ts';
import { clockNow, todayIso } from '../dates.ts';
import type { Db } from '../db.ts';
import { AppError, conflict } from '../errors.ts';
import type { User } from '../generated/prisma/client.ts';
import { monitorJob } from '../jobs/monitor.ts';
import { JOB_NAMES } from '../jobs/index.ts';
import { ACCOUNTS } from '../ledger/accounts.ts';
import { accountBalance, receivablesBalance, trialBalance } from '../ledger/service.ts';
import { recordAudit } from '../services/audit.ts';
import { currentDecision } from '../services/decisions.ts';
import { passThroughOffer } from '../services/pass-through.ts';
import { clearDevClock, loadDevClock, nextEventFor, readDevClock } from './clock.ts';
import { PERSONA_PASSWORD, PERSONAS, personaByKey, type PersonaDefinition } from './personas.ts';
import { seedDemoData } from './seed.ts';

// ---- One reset or clock advance at a time ----

let busy: string | null = null;

/** Runs `fn` unless another reset or clock advance is in flight, which is a 409. */
export async function withDevLock<T>(what: string, fn: () => Promise<T>): Promise<T> {
  if (busy) {
    throw conflict('DEV_BUSY', `Wait for the ${busy} that is running to finish, then try again`);
  }
  busy = what;
  try {
    return await fn();
  } finally {
    busy = null;
  }
}

// ---- Persona state ----

export interface PersonaFacts {
  exists: boolean;
  businessName: string | null;
  applicationStatus: string | null;
  approvedLimitCents: number | null;
  leaseRentCents: number | null;
  plan: { status: string; delinquencyStatus: string; kind?: string } | null;
  heldPayout: boolean;
  /** Pass-through plans: the latest finished month was missed. */
  passThroughMissed?: boolean;
  /** An open graduation offer from a pass-through plan. */
  graduationOffered?: boolean;
  /** A declined application that is offered a pass-through plan, with no plan yet. */
  passThroughAvailable?: boolean;
}

/** A short label and a tone for where an account stands. Pure: see the unit test. */
export function describePersonaState(facts: PersonaFacts): DevPersonaState {
  const base = { exists: facts.exists, businessName: facts.businessName };
  if (!facts.exists) return { ...base, label: 'Not created yet', tone: 'neutral' };
  if (facts.businessName === null) return { ...base, label: 'Nothing created yet', tone: 'info' };
  const held = facts.heldPayout ? ', payout held' : '';
  if (facts.plan?.kind === 'PASS_THROUGH' && facts.plan.status !== 'CLOSED') {
    if (facts.graduationOffered) {
      return { ...base, label: 'Pass-through, graduation offered', tone: 'gold' };
    }
    if (facts.passThroughMissed) {
      return { ...base, label: 'Pass-through, last month missed', tone: 'late' };
    }
    return { ...base, label: 'Pass-through plan, current', tone: 'paid' };
  }
  if (facts.plan) {
    const { status, delinquencyStatus } = facts.plan;
    if (delinquencyStatus === 'CHARGED_OFF') {
      return { ...base, label: 'Written off, plan closed', tone: 'late' };
    }
    if (status === 'CLOSED') return { ...base, label: 'Plan closed', tone: 'neutral' };
    if (delinquencyStatus === 'DEFAULT')
      return { ...base, label: `In default${held}`, tone: 'late' };
    if (delinquencyStatus === 'DELINQUENT') {
      return { ...base, label: `Delinquent${held}`, tone: 'late' };
    }
    if (delinquencyStatus === 'GRACE')
      return { ...base, label: `Past due, in grace${held}`, tone: 'due' };
    if (status === 'PAUSED') return { ...base, label: `Plan paused${held}`, tone: 'due' };
    return facts.heldPayout
      ? { ...base, label: 'Active plan, payout held', tone: 'due' }
      : { ...base, label: 'Active plan, current', tone: 'paid' };
  }
  switch (facts.applicationStatus) {
    case 'APPROVED':
      if (facts.leaseRentCents === null)
        return { ...base, label: 'Approved, no lease yet', tone: 'paid' };
      return facts.approvedLimitCents !== null && facts.leaseRentCents > facts.approvedLimitCents
        ? { ...base, label: 'Approved below the lease rent', tone: 'due' }
        : { ...base, label: 'Lease linked, no plan yet', tone: 'paid' };
    case 'DECLINED':
      return facts.passThroughAvailable && facts.leaseRentCents !== null
        ? { ...base, label: 'Declined, free plan available', tone: 'due' }
        : { ...base, label: 'Declined', tone: 'late' };
    case 'NEEDS_INFO':
      return { ...base, label: 'Needs info', tone: 'gold' };
    case 'IN_REVIEW':
      return { ...base, label: 'In review', tone: 'due' };
    default:
      return { ...base, label: 'Business set up, not applied', tone: 'info' };
  }
}

async function personaFacts(db: Db, user: User | null): Promise<PersonaFacts> {
  const none: PersonaFacts = {
    exists: user !== null,
    businessName: null,
    applicationStatus: null,
    approvedLimitCents: null,
    leaseRentCents: null,
    plan: null,
    heldPayout: false,
  };
  if (!user) return none;
  const business = await db.business.findFirst({
    where: { ownerUserId: user.id },
    orderBy: { createdAt: 'desc' },
  });
  if (!business) return none;
  const [application, lease, plans, held] = await Promise.all([
    db.underwritingApplication.findFirst({
      where: { businessId: business.id },
      orderBy: { createdAt: 'desc' },
    }),
    db.lease.findFirst({
      where: { businessId: business.id, status: { not: 'ENDED' } },
      orderBy: { createdAt: 'desc' },
    }),
    db.rentPlan.findMany({ where: { businessId: business.id }, orderBy: { createdAt: 'desc' } }),
    db.landlordPayout.count({ where: { rentPlan: { businessId: business.id }, status: 'HELD' } }),
  ]);
  const plan = plans.find((p) => p.status === 'ACTIVE') ?? plans[0] ?? null;
  const decision = application ? await currentDecision(db, application.id) : null;
  const lastMonth =
    plan?.kind === 'PASS_THROUGH'
      ? await db.passThroughPeriod.findFirst({
          where: {
            rentPlanId: plan.id,
            status: { in: ['PAID', 'MISSED', 'RETURNED_AFTER_PAYOUT', 'REFUNDED'] },
          },
          orderBy: { dueDate: 'desc' },
        })
      : null;
  const offered =
    plan?.kind === 'PASS_THROUGH'
      ? await db.graduationOffer.count({ where: { passThroughPlanId: plan.id, status: 'OFFERED' } })
      : 0;
  const available =
    application?.status === 'DECLINED' && plans.length === 0
      ? (await passThroughOffer(db, application.id)).eligible
      : false;
  return {
    exists: true,
    businessName: business.dba ?? business.legalName,
    applicationStatus: application?.status ?? null,
    approvedLimitCents:
      decision?.outcome === 'APPROVED' ? decision.approvedMonthlyLimitCents : null,
    leaseRentCents: lease?.monthlyRentCents ?? null,
    plan: plan
      ? { status: plan.status, delinquencyStatus: plan.delinquencyStatus, kind: plan.kind }
      : null,
    heldPayout: held > 0,
    passThroughMissed: lastMonth !== null && lastMonth.status !== 'PAID',
    graduationOffered: offered > 0,
    passThroughAvailable: available,
  };
}

const personaUser = (db: Db, persona: PersonaDefinition) =>
  db.user.findUnique({ where: { email: persona.email } });

export async function personaView(
  db: Db,
  persona: PersonaDefinition,
  today: IsoDate = todayIso(),
): Promise<DevPersona> {
  const user = await personaUser(db, persona);
  const facts = await personaFacts(db, user);
  return {
    key: persona.key,
    title: persona.title,
    group: persona.group,
    section: persona.section,
    demonstrates: persona.demonstrates,
    screens: persona.screens,
    email: persona.email,
    resettable: persona.build.kind !== 'history',
    walkthrough: persona.build.kind === 'fresh' ? persona.build.walkthrough : null,
    state: describePersonaState(facts),
    nextEvent: user ? await nextEventFor(db, user.id, today) : null,
  };
}

export async function listPersonas(db: Db): Promise<DevPersona[]> {
  const today = todayIso();
  const out: DevPersona[] = [];
  for (const persona of PERSONAS) out.push(await personaView(db, persona, today));
  return out;
}

export function requirePersona(key: string): PersonaDefinition {
  const persona = personaByKey(key);
  if (!persona) {
    throw new AppError(
      404,
      'PERSONA_NOT_FOUND',
      `No persona "${key}". Known: ${PERSONAS.map((p) => p.key).join(', ')}`,
    );
  }
  return persona;
}

// ---- Building and resetting one persona ----

const NEEDS_FULL_RESET = (persona: PersonaDefinition) =>
  conflict(
    'PERSONA_NEEDS_FULL_RESET',
    `${persona.title} is months of replayed ledger history, and the ledger is append-only, so it cannot be rebuilt on its own. Use "Reset everything" (POST /v1/dev/reset), which rebuilds every persona in a few seconds`,
  );

/**
 * Take the current account for a persona out of the way so a new one can be built.
 *
 * An account that never opened a rent plan has no ledger postings: its rows are deleted.
 * (Audit events about them stay, as the audit log is append-only. They point at ids that no
 * longer exist and belong to no persona.)
 *
 * An account with a rent plan cannot be deleted, because ledger entries cannot be. It is
 * archived instead: the login is renamed and its sessions revoked, the business is renamed,
 * its plans are closed (which stops new rent periods; rent already paid to a landlord is
 * still collected by the jobs), and its bank and landlord account references are changed so
 * the integrity checks never match the archived business against its replacement. It stays
 * in the book, the trial balance, and the monitoring rules as an ordinary former customer
 * until the next full reset.
 */
async function retirePersonaAccount(ctx: AppContext, user: User): Promise<'deleted' | 'archived'> {
  const { db } = ctx;
  const businesses = await db.business.findMany({
    where: { ownerUserId: user.id },
    select: {
      id: true,
      legalName: true,
      applications: { select: { id: true } },
      leases: { select: { id: true, changes: { select: { id: true } } } },
      screenings: { select: { id: true } },
      rentPlans: { select: { id: true, status: true } },
    },
  });
  const hasPlans = businesses.some((b) => b.rentPlans.length > 0);

  if (!hasPlans) {
    const subjectIds = businesses.flatMap((b) => [
      b.id,
      ...b.applications.map((a) => a.id),
      ...b.leases.flatMap((l) => [l.id, ...l.changes.map((c) => c.id)]),
      ...b.screenings.map((s) => s.id),
    ]);
    await db.$transaction(async (tx) => {
      await tx.alert.deleteMany({ where: { subjectId: { in: subjectIds } } });
      await tx.business.deleteMany({ where: { ownerUserId: user.id } });
      await tx.user.delete({ where: { id: user.id } });
    });
    return 'deleted';
  }

  const stamp = Date.now().toString(36);
  const at = clockNow();
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { email: `archived-${stamp}-${user.email}` },
    });
    await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    for (const business of businesses) {
      await tx.business.update({
        where: { id: business.id },
        data: { legalName: `${business.legalName} (archived ${stamp})` },
      });
      const links = await tx.bankLink.findMany({ where: { businessId: business.id } });
      for (const link of links) {
        await tx.bankLink.update({
          where: { id: link.id },
          data: { providerAccountToken: `${link.providerAccountToken}_archived_${stamp}` },
        });
      }
      await tx.lease.updateMany({
        where: { businessId: business.id },
        data: { landlordRoutingNumber: '000000000' },
      });
      for (const plan of business.rentPlans) {
        if (plan.status === 'CLOSED') continue;
        await tx.rentPlan.update({
          where: { id: plan.id },
          data: { status: 'CLOSED', closedAt: at, closedReason: 'DEV_ARCHIVED' },
        });
        await recordAudit(tx, {
          actor: { type: 'system', id: 'dev-tools' },
          eventType: 'PLAN_STATUS_CHANGED',
          subjectType: 'rent_plan',
          subjectId: plan.id,
          payload: { from: plan.status, to: 'CLOSED', reason: 'DEV_ARCHIVED' },
          at,
        });
      }
    }
  });
  return 'archived';
}

/** Create the login and run the builder. Fresh personas get the login and nothing else. */
async function buildPersona(ctx: AppContext, persona: PersonaDefinition): Promise<User> {
  if (persona.build.kind === 'history') throw NEEDS_FULL_RESET(persona);
  const user = await ctx.db.user.create({
    data: {
      email: persona.email,
      passwordHash: await hashPassword(PERSONA_PASSWORD),
      fullName: persona.fullName,
    },
  });
  if (persona.build.kind === 'instant') {
    const today = todayIso();
    await persona.build.run({ ctx, userId: user.id, today });
    // So the alerts this persona is meant to raise are open now, not on the next job run.
    await monitorJob(ctx, today, JOB_NAMES);
  }
  return user;
}

/**
 * Rebuild one persona and nothing else: a new account with new ids. Refused for personas
 * with replayed history. No other account is read or written, except that the monitor job
 * runs once afterwards (it always reads the whole book).
 */
export async function resetPersona(ctx: AppContext, persona: PersonaDefinition): Promise<User> {
  if (persona.build.kind === 'history') throw NEEDS_FULL_RESET(persona);
  const existing = await personaUser(ctx.db, persona);
  if (existing) await retirePersonaAccount(ctx, existing);
  return buildPersona(ctx, persona);
}

/** The persona's account, created on first use when the database has not been seeded. */
export async function ensurePersonaUser(
  ctx: AppContext,
  persona: PersonaDefinition,
): Promise<User> {
  const existing = await personaUser(ctx.db, persona);
  if (existing) return existing;
  if (persona.build.kind === 'history') {
    throw conflict(
      'PERSONA_NOT_SEEDED',
      `${persona.title} has not been built. Run a full reset first: POST /v1/dev/reset, or ./dev reset`,
    );
  }
  return buildPersona(ctx, persona);
}

/** Where the app should open for this persona, given what exists right now. */
export async function landingFor(
  db: Db,
  persona: PersonaDefinition,
  userId: string,
): Promise<{ screen: DevLandingScreen; applicationId: string | null }> {
  const business = await db.business.findFirst({
    where: { ownerUserId: userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!business) return { screen: 'BUSINESS_NEW', applicationId: null };
  if (persona.landing === 'APPLICATION') {
    const application = await db.underwritingApplication.findFirst({
      where: { businessId: business.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (application) return { screen: 'APPLICATION', applicationId: application.id };
  }
  return {
    screen:
      persona.landing === 'HISTORY' || persona.landing === 'CONNECTIONS' ? persona.landing : 'HOME',
    applicationId: null,
  };
}

// ---- Full reset ----

/** Wipe everything and rebuild every persona as of the real date. The clock goes back too. */
export async function resetEverything(ctx: AppContext) {
  const started = Date.now();
  clearDevClock();
  // The mock payments provider remembers idempotency keys and pending returns in memory.
  const payments = ctx.providers.payments as { reset?: () => void };
  payments.reset?.();
  await seedDemoData(ctx);
  const clock = await loadDevClock(ctx.db);
  return { clock, seconds: (Date.now() - started) / 1000, personas: await listPersonas(ctx.db) };
}

// ---- Read models for the dev home page ----

export async function overview(ctx: AppContext): Promise<DevOverview> {
  const { db, config, providers } = ctx;
  const [
    users,
    businesses,
    inReview,
    plans,
    standing,
    held,
    alerts,
    tb,
    pool,
    receivables,
    breaker,
  ] = await Promise.all([
    db.user.count(),
    db.business.count(),
    db.underwritingApplication.count({ where: { status: 'IN_REVIEW' } }),
    db.rentPlan.count(),
    db.rentPlan.groupBy({ by: ['delinquencyStatus'], _count: { _all: true } }),
    db.landlordPayout.count({ where: { status: 'HELD' } }),
    db.alert.groupBy({
      by: ['severity'],
      where: { status: { not: 'RESOLVED' } },
      _count: { _all: true },
    }),
    trialBalance(db),
    accountBalance(db, ACCOUNTS.CAPITAL_POOL),
    receivablesBalance(db),
    db.circuitBreaker.findFirst({ where: { tripped: true }, select: { id: true } }),
  ]);
  return {
    clock: readDevClock(),
    environment: {
      nodeEnv: config.NODE_ENV,
      providers: Object.fromEntries(
        Object.entries(providers)
          .filter(([, v]) => typeof (v as { name?: unknown }).name === 'string')
          .map(([k, v]) => [k, (v as { name: string }).name]),
      ),
      jobsEnabled: config.JOBS_ENABLED,
      adminEnabled: config.ENABLE_ADMIN,
    },
    counts: {
      users,
      businesses,
      applicationsInReview: inReview,
      plans,
      plansByStanding: Object.fromEntries(
        standing.map((s) => [s.delinquencyStatus, s._count._all]),
      ),
      heldPayouts: held,
      openAlerts: Object.fromEntries(alerts.map((a) => [a.severity, a._count._all])),
    },
    ledger: {
      balanced: tb.balanced,
      totalDebitsCents: tb.totalDebitsCents,
      totalCreditsCents: tb.totalCreditsCents,
      capitalPoolCents: pool,
      receivablesCents: receivables,
    },
    circuitBreakerTripped: breaker !== null,
  };
}

/** What just happened: the latest job runs, audit events and alerts. Read only. */
export async function feed(db: Db): Promise<DevFeed> {
  const [jobRuns, auditEvents, alerts] = await Promise.all([
    db.jobRun.findMany({ orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: 30 }),
    db.auditEvent.findMany({ orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 30 }),
    db.alert.findMany({
      where: { status: { not: 'RESOLVED' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
    }),
  ]);
  return {
    clock: readDevClock(),
    jobRuns: jobRuns.map((r) => ({
      id: r.id,
      name: r.name,
      asOf: r.asOf,
      startedAt: r.startedAt.toISOString(),
      ok: r.ok,
      error: r.error,
      summary: (r.summary as Record<string, unknown> | null) ?? null,
    })),
    auditEvents: auditEvents.map((e) => ({
      id: e.id,
      at: e.at.toISOString(),
      eventType: e.eventType,
      actorType: e.actorType,
      subjectType: e.subjectType,
      subjectId: e.subjectId,
    })),
    alerts: alerts.map((a) => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      status: a.status,
      title: a.title,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

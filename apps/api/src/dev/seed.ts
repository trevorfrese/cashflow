/**
 * Demo data: every persona in `personas.ts`, built from nothing.
 *
 * The plans with history are built by replaying the jobs one day at a time from the oldest
 * plan's start to today, so the ledger holds real payout, collection, provision, charge-off,
 * and recovery postings, each dated on the day it belongs to. Nothing here is an inserted
 * alert row: each alert is opened by the monitor job from what the business did.
 *
 * Wipes every table first. Used by `prisma/seed.ts` and by `POST /v1/dev/reset`.
 */
import { addDays, type IsoDate } from '@cashflow/shared';

import { hashPassword } from '../auth/password.ts';
import type { AppContext } from '../context.ts';
import { todayIso } from '../dates.ts';
import { runAllJobs } from '../jobs/index.ts';
import { ACCOUNTS, ensureSystemAccounts } from '../ledger/accounts.ts';
import {
  accountBalance,
  allowanceBalance,
  receivablesBalance,
  trialBalance,
} from '../ledger/service.ts';
import { delinquencySummary } from '../services/provisioning.ts';
import { PERSONA_PASSWORD, PERSONAS, type HistoryScript } from './personas.ts';

export const POOL_CENTS = 25_000_000; // $250,000

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Every table, emptied. The ledger's append-only triggers do not fire on TRUNCATE. */
export async function truncateAll(ctx: Pick<AppContext, 'db'>): Promise<void> {
  await ctx.db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "LedgerEntry", "LedgerTransaction", "LedgerAccount",
      "Repayment", "Installment", "LandlordPayout", "RentPlan",
      "Lease", "UnderwritingDecision", "ApplicationReview", "UnderwritingApplication",
      "BankLink", "CommerceLink", "BeneficialOwner", "ScreeningResult", "LeaseChange",
      "Business", "RefreshToken", "User", "JobRun", "AuditEvent", "Alert", "CircuitBreaker",
      "DataSnapshot", "ConnectionAuthorization", "PassThroughPeriod", "GraduationOffer",
      "LandlordDisbursement", "AdverseActionNotice"
    RESTART IDENTITY CASCADE
  `);
}

export interface SeedSummary {
  today: IsoDate;
  lines: string[];
}

/**
 * Wipe the database and rebuild every persona as of today. Throws if the replay told a
 * different story from the one the personas are for, or if the trial balance is off.
 */
export async function seedDemoData(ctx: AppContext): Promise<SeedSummary> {
  const today = todayIso();
  await truncateAll(ctx);
  await ensureSystemAccounts(ctx.db);

  const passwordHash = await hashPassword(PERSONA_PASSWORD);
  const users = new Map<string, string>();
  for (const persona of PERSONAS) {
    const user = await ctx.db.user.create({
      data: { email: persona.email, passwordHash, fullName: persona.fullName },
    });
    users.set(persona.key, user.id);
  }
  const userId = (key: string) => users.get(key)!;

  // The plans with history open in the past, before the replay starts.
  const scripts: HistoryScript[] = [];
  for (const persona of PERSONAS) {
    if (persona.build.kind !== 'history') continue;
    scripts.push(persona.build.script({ ctx, userId: userId(persona.key), today }));
  }
  const replayFrom = scripts.reduce(
    (min, s) => (s.replayFrom < min ? s.replayFrom : min),
    addDays(today, -1),
  );
  // The pool was funded before the first plan opened.
  await ctx.db.$transaction((tx) =>
    ctx.providers.capital.fund(tx, POOL_CENTS, 'Seed: initial capital pool', replayFrom),
  );
  for (const script of scripts) await script.open();

  // Replay every day from the oldest plan's start to today. Things that happen to a
  // business on a given day happen before that day's jobs run.
  for (let asOf = replayFrom; asOf <= today; asOf = addDays(asOf, 1)) {
    for (const script of scripts) await script.beforeJobs(asOf);
    for (const persona of PERSONAS) {
      if (persona.build.kind !== 'instant') continue;
      if ((persona.build.builtOn?.(today) ?? today) !== asOf) continue;
      await persona.build.run({ ctx, userId: userId(persona.key), today });
    }
    const result = await runAllJobs(ctx, asOf);
    for (const [name, job] of Object.entries(result)) {
      if (name !== 'asOf' && !(job as { ok: boolean }).ok) {
        throw new Error(
          `Seed: job ${name} failed on ${asOf}: ${(job as { error?: string }).error}`,
        );
      }
    }
  }

  // The stories above are what the demo is for. Fail loudly if the replay told another one.
  for (const script of scripts) await script.verify();

  // The monitoring state the console is seeded to show. Every alert below was opened by the
  // monitor job during the replay; fail loudly if a severity is missing.
  const { db } = ctx;
  const openAlerts = await db.alert.groupBy({
    by: ['severity'],
    where: { status: { not: 'RESOLVED' } },
    _count: { _all: true },
  });
  const bySeverity = Object.fromEntries(openAlerts.map((a) => [a.severity, a._count._all]));
  for (const severity of ['INFO', 'WARNING', 'HIGH', 'CRITICAL'] as const) {
    if (!bySeverity[severity]) {
      throw new Error(`Seed expected at least one open ${severity} alert, found none`);
    }
  }
  const openTypes = await db.alert.findMany({
    where: { status: { not: 'RESOLVED' } },
    orderBy: [{ severity: 'desc' }, { type: 'asc' }],
    select: { severity: true, type: true },
  });
  const breaker = await db.circuitBreaker.findUnique({ where: { id: 'new_approvals' } });

  const pool = await accountBalance(db, ACCOUNTS.CAPITAL_POOL);
  const fees = await accountBalance(db, ACCOUNTS.FEE_REVENUE);
  const payouts = await db.landlordPayout.count({ where: { status: 'PAID' } });
  const installments = await db.installment.count({ where: { status: 'PAID' } });
  const summary = await delinquencySummary(db, today);
  const tb = await trialBalance(db);
  if (!tb.balanced) throw new Error('Seed failed: the trial balance does not balance');

  return {
    today,
    lines: [
      `Personas: ${PERSONAS.length}, each its own login with password ${PERSONA_PASSWORD}. Start with ${PERSONAS[0]!.email}`,
      `Landlord payouts made: ${payouts}, installments collected: ${installments}`,
      `Capital pool: ${usd(pool)}, fee revenue: ${usd(fees)}`,
      `Receivables: ${usd(await receivablesBalance(db))}, allowance: ${usd(await allowanceBalance(db))}`,
      `Charged off: ${usd(summary.chargedOffCents)}, recovered: ${usd(summary.recoveredCents)}, provision expense: ${usd(summary.provisionExpenseCents)}`,
      `Plans by bucket: ${summary.buckets.map((b) => `${b.status} ${b.plans}`).join(', ')}. Held payouts: ${summary.heldPayouts}`,
      `Open alerts: ${(['CRITICAL', 'HIGH', 'WARNING', 'INFO'] as const).map((s) => `${s} ${bySeverity[s] ?? 0}`).join(', ')}. Circuit breaker: ${breaker?.tripped ? 'TRIPPED' : 'not tripped'}`,
      ...openTypes.map((a) => `  ${a.severity.padEnd(8)} ${a.type}`),
      `Trial balance: debits ${usd(tb.totalDebitsCents)}, credits ${usd(tb.totalCreditsCents)}, balanced`,
    ],
  };
}

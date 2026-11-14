import {
  daysBetween,
  type IsoDate,
  type JobHealth,
  type JobRunRow,
  type LatePlanRow,
  type OperatorJobs,
  type OperatorLatePlans,
} from '@cashflow/shared';

import type { Db } from '../db.ts';
import type { JobRun } from '../generated/prisma/client.ts';
import { MONITORING_POLICY } from '../monitoring/policy.ts';
import { planStandings } from './delinquency.ts';
import { releaseBy } from './payouts.ts';

/**
 * Read-only views for the operations console: scheduled job runs, and the plans that are
 * behind. Nothing here changes state.
 */

/** First line of an error, short enough for a table. The full text stays on the row. */
function errorSummary(error: string | null): string | null {
  if (!error) return null;
  const first = error.split('\n', 1)[0]!.trim();
  return first.length > 300 ? `${first.slice(0, 297)}...` : first;
}

function toRow(run: JobRun): JobRunRow {
  return {
    id: run.id,
    name: run.name,
    asOf: run.asOf,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    ok: run.ok,
    error: errorSummary(run.error),
    durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
  };
}

/**
 * How a job stands today. Uses the same measure as the monitoring rule `books.job_stale`:
 * as-of dates, not wall clock, so it reads the same on a simulated clock.
 */
export function jobHealth(
  lastRun: JobRun | null,
  lastSuccessAsOf: IsoDate | null,
  asOf: IsoDate,
  maxGapDays: number,
): JobHealth {
  if (lastRun === null) return 'NEVER_RAN';
  if (lastRun.ok === false) return 'FAILED';
  if (lastSuccessAsOf === null || daysBetween(lastSuccessAsOf, asOf) > maxGapDays) {
    return lastRun.ok === null && lastRun.finishedAt === null ? 'RUNNING' : 'LATE';
  }
  if (lastRun.ok === null && lastRun.finishedAt === null) return 'RUNNING';
  return 'OK';
}

/** Every scheduled job's latest run and health, and the recent run history. */
export async function jobsView(
  db: Db,
  asOf: IsoDate,
  jobNames: readonly string[],
  limit: number,
): Promise<OperatorJobs> {
  const maxGapDays = MONITORING_POLICY.operations.maxJobGapDays;
  const recent = await db.jobRun.findMany({
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: limit,
  });
  const jobs = [];
  for (const name of jobNames) {
    const [lastRun, lastOk] = await Promise.all([
      db.jobRun.findFirst({ where: { name }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }] }),
      db.jobRun.findFirst({
        where: { name, ok: true },
        orderBy: { asOf: 'desc' },
        select: { asOf: true },
      }),
    ]);
    const lastSuccessAsOf = lastOk?.asOf ?? null;
    const mine = recent.filter((r) => r.name === name);
    jobs.push({
      name,
      health: jobHealth(lastRun, lastSuccessAsOf, asOf, maxGapDays),
      lastRun: lastRun ? toRow(lastRun) : null,
      lastSuccessAsOf,
      daysSinceSuccess: lastSuccessAsOf === null ? null : daysBetween(lastSuccessAsOf, asOf),
      recentRuns: mine.length,
      recentFailures: mine.filter((r) => r.ok === false).length,
    });
  }
  return { asOf, maxGapDays, jobs, recent: recent.map(toRow) };
}

/**
 * Plans that are behind: anything owed past its due date, or a bucket other than current
 * (written off plans included, which are closed). Most days past due first.
 */
export async function latePlansView(db: Db, asOf: IsoDate): Promise<OperatorLatePlans> {
  const plans = await db.rentPlan.findMany({
    where: {
      OR: [{ status: { not: 'CLOSED' } }, { delinquencyStatus: { not: 'CURRENT' } }],
    },
    include: {
      business: { select: { legalName: true } },
      payouts: { where: { status: 'HELD' }, orderBy: { scheduledFor: 'asc' } },
    },
  });
  const standings = await planStandings(db, plans, asOf);
  const rows: LatePlanRow[] = [];
  for (const plan of plans) {
    const standing = standings.get(plan.id)!;
    if (standing.pastDueCents === 0 && standing.delinquencyStatus === 'CURRENT') continue;
    const earliestHeld = plan.payouts[0] ?? null;
    rows.push({
      planId: plan.id,
      businessId: plan.businessId,
      businessName: plan.business.legalName,
      kind: plan.kind,
      status: plan.status,
      bucket: standing.delinquencyStatus,
      daysPastDue: standing.daysPastDue,
      pastDueCents: standing.pastDueCents,
      monthlyRentCents: plan.monthlyRentCents,
      needsPayment: standing.needsPayment,
      heldPayouts: plan.payouts.length,
      heldPayoutCents: plan.payouts.reduce((sum, p) => sum + p.amountCents, 0),
      heldReleaseBy: earliestHeld ? releaseBy(earliestHeld.scheduledFor) : null,
      frozenReason: plan.advanceFrozenAt ? plan.advanceFrozenReason : null,
    });
  }
  rows.sort(
    (a, b) =>
      b.daysPastDue - a.daysPastDue ||
      b.pastDueCents - a.pastDueCents ||
      a.businessName.localeCompare(b.businessName),
  );
  return { asOf, plans: rows };
}

/**
 * The simulated clock. Dev tools only.
 *
 * Source of truth: the latest as-of date in the `JobRun` table. "Today" is that date when it
 * is ahead of the wall clock, and the wall clock otherwise. So the simulated date is exactly
 * "the last day the jobs have run for", it survives an API restart, it needs no table of its
 * own, and a full reset (which empties `JobRun`) puts the clock back on the real date.
 *
 * `loadDevClock` copies that date into `src/dates.ts`, where `todayIso()`, `clockNow()` and
 * `effectiveAt()` read it. Nothing calls `loadDevClock` unless `ENABLE_DEV_TOOLS` is on, so
 * with the flag off those functions only ever see the wall clock.
 */
import type { DevAdvanceResult, DevClock, DevNextEvent } from '@cashflow/shared';
import { addDays, daysBetween, DEV_CLOCK_MAX_DAYS, type IsoDate } from '@cashflow/shared';

import { CONTROLS_POLICY } from '../controls/policy.ts';
import type { AppContext } from '../context.ts';
import { clockNow, setDevClockDate, todayIso } from '../dates.ts';
import type { Db } from '../db.ts';
import { unprocessable } from '../errors.ts';
import { runAllJobs } from '../jobs/index.ts';
import { UNPAID } from '../services/delinquency.ts';
import { releaseBy } from '../services/payouts.ts';
import { ACTIVE_SERVICING_POLICY } from '../servicing/policy.ts';

const wallToday = (): IsoDate => todayIso(new Date());

export function readDevClock(): DevClock {
  const today = todayIso();
  const wall = wallToday();
  return { today, wallToday: wall, aheadDays: Math.max(0, daysBetween(wall, today)) };
}

/** Read the latest job date from the database and make it "today" if it is in the future. */
export async function loadDevClock(db: Db): Promise<DevClock> {
  const latest = await db.jobRun.findFirst({ orderBy: { asOf: 'desc' }, select: { asOf: true } });
  setDevClockDate(latest && latest.asOf > wallToday() ? latest.asOf : null);
  return readDevClock();
}

/** Back to the wall clock, in this process. A full reset calls this before it reseeds. */
export function clearDevClock(): void {
  setDevClockDate(null);
}

type JobResults = Awaited<ReturnType<typeof runAllJobs>>;
const num = (summary: Record<string, unknown>, key: string): number =>
  typeof summary[key] === 'number' ? (summary[key] as number) : 0;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Move the clock forward to `target`, running every job once for each day crossed, in
 * order, exactly as the scheduler would have. Returns what changed.
 */
export async function advanceClock(
  ctx: AppContext,
  target: IsoDate,
  event: DevNextEvent | null = null,
): Promise<DevAdvanceResult> {
  const from = todayIso();
  const days = daysBetween(from, target);
  if (days < 1) {
    throw unprocessable('CLOCK_ONLY_FORWARD', `The clock is at ${from} and only moves forward`);
  }
  if (days > DEV_CLOCK_MAX_DAYS) {
    throw unprocessable(
      'CLOCK_TOO_FAR',
      `That is ${days} days ahead. One call can cross at most ${DEV_CLOCK_MAX_DAYS}`,
    );
  }
  // Events written during the advance are stamped on the simulated days, all after this.
  const since = clockNow();
  const summary: DevAdvanceResult['summary'] = {
    periodsCreated: 0,
    payoutsPaid: 0,
    payoutsHeld: 0,
    payoutsCancelled: 0,
    payoutsFailed: 0,
    installmentsCollected: 0,
    installmentsFailed: 0,
    installmentsLate: 0,
    standingChanges: 0,
    plansChargedOff: 0,
    alertsOpened: 0,
    alertsResolved: 0,
  };
  const jobFailures: DevAdvanceResult['jobFailures'] = [];

  for (let asOf = addDays(from, 1); asOf <= target; asOf = addDays(asOf, 1)) {
    // The day becomes "today" before its jobs run, so everything they call agrees.
    setDevClockDate(asOf);
    const result: JobResults = await runAllJobs(ctx, asOf);
    for (const [name, job] of Object.entries(result)) {
      if (name === 'asOf' || typeof job === 'string') continue;
      if (!job.ok) jobFailures.push({ asOf, job: name, error: job.error ?? 'failed' });
    }
    summary.periodsCreated += num(result.generatePeriods.summary, 'periodsCreated');
    summary.payoutsPaid += num(result.processPayouts.summary, 'paid');
    summary.payoutsFailed += num(result.processPayouts.summary, 'failed');
    summary.installmentsCollected += num(result.collectInstallments.summary, 'paid');
    summary.installmentsFailed += num(result.collectInstallments.summary, 'failed');
    summary.installmentsLate += num(result.collectInstallments.summary, 'late');
    summary.alertsOpened += num(result.monitor.summary, 'opened');
    summary.alertsResolved += num(result.monitor.summary, 'autoResolved');
  }
  const clock = await loadDevClock(ctx.db);

  // A payout stays held for days and a plan is aged every day, so those are counted from
  // the audit trail, where each is written once when it happens.
  const events = await ctx.db.auditEvent.findMany({
    where: {
      at: { gt: since },
      eventType: {
        in: [
          'PAYOUT_HELD',
          'PAYOUT_CANCELLED',
          'PAYOUT_RELEASED',
          'DELINQUENCY_CHANGED',
          'PLAN_CHARGED_OFF',
          'LEASE_CHANGE_APPLIED',
          'PLAN_ADVANCE_FROZEN',
        ],
      },
    },
    orderBy: { at: 'asc' },
  });
  const planIds = [
    ...new Set(events.filter((e) => e.subjectType === 'rent_plan').map((e) => e.subjectId)),
  ];
  const plans = await ctx.db.rentPlan.findMany({
    where: { id: { in: planIds } },
    select: { id: true, business: { select: { legalName: true, dba: true } } },
  });
  const nameOf = new Map(plans.map((p) => [p.id, p.business.dba ?? p.business.legalName]));
  const details: string[] = [];
  for (const e of events) {
    const who = nameOf.get(e.subjectId) ?? 'A business';
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const on = e.at.toISOString().slice(0, 10);
    if (e.eventType === 'PAYOUT_HELD') {
      summary.payoutsHeld += 1;
      details.push(`${on}: ${who}: landlord payout held (${String(payload.reason ?? 'held')})`);
    } else if (e.eventType === 'PAYOUT_CANCELLED') {
      summary.payoutsCancelled += 1;
      details.push(`${on}: ${who}: landlord payout cancelled, its installments voided`);
    } else if (e.eventType === 'PAYOUT_RELEASED') {
      details.push(`${on}: ${who}: held landlord payout released and paid`);
    } else if (e.eventType === 'DELINQUENCY_CHANGED') {
      summary.standingChanges += 1;
      details.push(`${on}: ${who}: ${String(payload.from)} to ${String(payload.to)}`);
    } else if (e.eventType === 'PLAN_CHARGED_OFF') {
      summary.plansChargedOff += 1;
      details.push(`${on}: ${who}: written off, plan closed`);
    } else if (e.eventType === 'LEASE_CHANGE_APPLIED') {
      details.push(`${on}: landlord change took effect`);
    } else if (e.eventType === 'PLAN_ADVANCE_FROZEN') {
      details.push(`${on}: ${who}: plan frozen (${String(payload.reason ?? 'review')})`);
    }
  }

  const s = summary;
  const headline = [
    s.payoutsPaid > 0 ? `${plural(s.payoutsPaid, 'landlord payout')} paid` : null,
    s.installmentsCollected > 0
      ? `${plural(s.installmentsCollected, 'installment')} collected`
      : null,
    s.installmentsFailed > 0 ? `${plural(s.installmentsFailed, 'debit')} failed` : null,
    s.periodsCreated > 0 ? `${plural(s.periodsCreated, 'rent period')} scheduled` : null,
    s.alertsOpened > 0 ? `${plural(s.alertsOpened, 'alert')} opened` : null,
    s.alertsResolved > 0 ? `${plural(s.alertsResolved, 'alert')} resolved` : null,
  ].filter((line): line is string => line !== null);
  const changes = [
    ...headline,
    ...details.slice(0, 12),
    ...(details.length > 12 ? [`and ${details.length - 12} more in the audit log`] : []),
    ...jobFailures.map((f) => `${f.asOf}: job ${f.job} FAILED: ${f.error}`),
  ];
  if (changes.length === 0) changes.push('Nothing was due. The jobs ran and changed nothing.');

  return { from, to: target, days, clock, event, summary, changes, jobFailures };
}

/**
 * The next date after `today` on which something happens to the businesses of one user: a
 * payout or installment falls due, grace ends, a held payout runs out of time, a plan is
 * written off, a landlord change takes effect, or a review passes its deadline.
 */
export async function nextEventFor(
  db: Db,
  userId: string,
  today: IsoDate,
): Promise<DevNextEvent | null> {
  const policy = ACTIVE_SERVICING_POLICY;
  const owned = { business: { ownerUserId: userId } };
  const [payouts, installments, changes, reviews] = await Promise.all([
    db.landlordPayout.findMany({
      where: { rentPlan: owned, status: { in: ['SCHEDULED', 'HELD'] } },
      select: { status: true, scheduledFor: true },
    }),
    db.installment.findMany({
      where: { rentPlan: owned, status: { in: UNPAID }, payout: { status: 'PAID' } },
      orderBy: { dueDate: 'asc' },
      select: { dueDate: true },
    }),
    db.leaseChange.findMany({
      where: { status: 'PENDING', lease: owned },
      select: { effectiveOn: true },
    }),
    db.underwritingApplication.findMany({
      where: { ...owned, status: 'IN_REVIEW', submittedAt: { not: null } },
      select: { submittedAt: true },
    }),
  ]);

  const candidates: DevNextEvent[] = [];
  for (const p of payouts) {
    if (p.status === 'SCHEDULED') {
      candidates.push({ date: p.scheduledFor, label: 'Landlord payout due' });
    } else {
      const last = releaseBy(p.scheduledFor);
      if (last) candidates.push({ date: addDays(last, 1), label: 'Held payout is cancelled' });
    }
  }
  for (const i of installments) {
    candidates.push({ date: i.dueDate, label: 'Installment due' });
  }
  const oldest = installments[0];
  if (oldest) {
    candidates.push({
      date: addDays(oldest.dueDate, policy.lateGraceDays + 1),
      label: 'Grace ends: marked late, plan delinquent',
    });
    candidates.push({
      date: addDays(oldest.dueDate, policy.defaultAfterDays),
      label: 'Plan moves to default',
    });
    if (policy.chargeOffAfterDays !== null) {
      candidates.push({
        date: addDays(oldest.dueDate, policy.chargeOffAfterDays),
        label: 'Charge-off: balance written off, plan closed',
      });
    }
  }
  for (const c of changes) {
    candidates.push({ date: c.effectiveOn, label: 'Landlord change takes effect' });
  }
  for (const r of reviews) {
    const submittedOn = r.submittedAt!.toISOString().slice(0, 10);
    candidates.push({
      date: addDays(submittedOn, CONTROLS_POLICY.decisionNoticeDays + 1),
      label: 'Review passes its decision deadline',
    });
  }
  return (
    candidates
      .filter((c) => c.date > today)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0] ?? null
  );
}

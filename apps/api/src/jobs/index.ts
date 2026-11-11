import type { IsoDate } from '@cashflow/shared';
import cron from 'node-cron';

import type { AppContext } from '../context.ts';
import { todayIso } from '../dates.ts';
import { ageReceivablesJob } from './age-receivables.ts';
import { collectInstallmentsJob } from './collect-installments.ts';
import { generatePeriodsJob } from './generate-periods.ts';
import { leaseChangesJob } from './lease-changes.ts';
import { monitorJob } from './monitor.ts';
import { processPayoutsJob } from './process-payouts.ts';
import { provisionJob } from './provision.ts';
import { reconcilePaymentsJob } from './reconcile-payments.ts';
import { rescreenJob } from './rescreen.ts';
import { reunderwriteJob } from './reunderwrite.ts';

/** Every job by name, in the order `runAllJobs` runs them. */
export const JOBS = {
  rescreen: rescreenJob,
  'lease-changes': leaseChangesJob,
  reunderwrite: reunderwriteJob,
  'reconcile-payments': reconcilePaymentsJob,
  'age-receivables': ageReceivablesJob,
  'generate-periods': generatePeriodsJob,
  'process-payouts': processPayoutsJob,
  'collect-installments': collectInstallmentsJob,
  provision: provisionJob,
  monitor: (ctx: AppContext, asOf: IsoDate) => monitorJob(ctx, asOf, JOB_NAMES),
} as const;
export type JobName = keyof typeof JOBS;
/** Every job by name. The monitor checks that each of the others has been running. */
export const JOB_NAMES = [
  'rescreen',
  'lease-changes',
  'reunderwrite',
  'reconcile-payments',
  'age-receivables',
  'generate-periods',
  'process-payouts',
  'collect-installments',
  'provision',
  'monitor',
] as const satisfies readonly JobName[];

/**
 * Runs the jobs in dependency order. Each is idempotent for a given as-of date, so the whole
 * run can be repeated. The order is what makes one run act on the truth as of that day:
 *
 *   1. rescreen              Parties whose screening is older than the policy interval are
 *                            screened again. A hit freezes the plan before anything is
 *                            generated or paid for it today.
 *   2. lease-changes         Landlord and payout changes whose cooling-off has ended apply,
 *                            so a payout they were holding goes out today to the new details.
 *   3. reunderwrite          A plan it freezes must get no new period and no payout today.
 *   4. reconcile-payments    Payments that came back are undone before anything reads who
 *                            is paid up: a return can make a plan past due, or freeze it.
 *   5. age-receivables       Buckets and LATE marks are brought up to today, and plans at
 *                            the charge-off age are written off and closed, before periods
 *                            are generated or payouts decided for them.
 *   6. generate-periods      Next month's payout and installments exist, 30 days ahead, for
 *                            plans that are active and not frozen.
 *   7. process-payouts       Each due payout is paid, held, or cancelled, on the state the
 *                            three jobs above left. It runs before collections, so a
 *                            business has to be current at the start of the day for its
 *                            landlord to be paid, and so the first installment of a period
 *                            is collected on the day its payout goes out.
 *   8. collect-installments  Scheduled debits, a payment's effect on the bucket, and then
 *                            the cash sweep: operating cash is settled with the pool.
 *   9. provision             So the allowance is set on the day's closing balances. Posts
 *                            at most once per calendar month.
 *  10. monitor               Last: the rules read the state every other job left, and can
 *                            tell whether each of them ran.
 */
export async function runAllJobs(ctx: AppContext, asOf: IsoDate = todayIso()) {
  const rescreen = await rescreenJob(ctx, asOf);
  const leaseChanges = await leaseChangesJob(ctx, asOf);
  const reunderwrite = await reunderwriteJob(ctx, asOf);
  const reconcilePayments = await reconcilePaymentsJob(ctx, asOf);
  const ageReceivables = await ageReceivablesJob(ctx, asOf);
  const generatePeriods = await generatePeriodsJob(ctx, asOf);
  const processPayouts = await processPayoutsJob(ctx, asOf);
  const collectInstallments = await collectInstallmentsJob(ctx, asOf);
  const provision = await provisionJob(ctx, asOf);
  const monitor = await monitorJob(ctx, asOf, JOB_NAMES);
  return {
    asOf,
    rescreen,
    leaseChanges,
    reunderwrite,
    reconcilePayments,
    ageReceivables,
    generatePeriods,
    processPayouts,
    collectInstallments,
    provision,
    monitor,
  };
}

/** Schedules runAllJobs inside the API process. Returns a stop function. */
export function startScheduler(ctx: AppContext): () => void {
  const expression = ctx.config.JOBS_CRON;
  if (!cron.validate(expression)) {
    throw new Error(`JOBS_CRON is not a valid cron expression: ${expression}`);
  }
  let running = false;
  const task = cron.schedule(expression, async () => {
    if (running) return; // never overlap runs
    running = true;
    try {
      await runAllJobs(ctx);
    } finally {
      running = false;
    }
  });
  ctx.log.info({ cron: expression }, 'job scheduler started');
  return () => {
    void task.stop();
  };
}

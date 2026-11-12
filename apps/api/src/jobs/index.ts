import type { IsoDate } from '@cashflow/shared';
import cron from 'node-cron';

import type { AppContext } from '../context.ts';
import { todayIso } from '../dates.ts';
import { adverseActionNoticesJob } from './adverse-action-notices.ts';
import { ageReceivablesJob } from './age-receivables.ts';
import { collectInstallmentsJob } from './collect-installments.ts';
import { generatePeriodsJob } from './generate-periods.ts';
import { leaseChangesJob } from './lease-changes.ts';
import { monitorJob } from './monitor.ts';
import { processPayoutsJob } from './process-payouts.ts';
import { provisionJob } from './provision.ts';
import { reconcilePaymentsJob } from './reconcile-payments.ts';
import { refreshEligibilityJob } from './refresh-eligibility.ts';
import { refreshConnectionsJob } from './refresh-connections.ts';
import { rescreenJob } from './rescreen.ts';
import { reunderwriteJob } from './reunderwrite.ts';

/** Every job by name, in the order `runAllJobs` runs them. */
export const JOBS = {
  rescreen: rescreenJob,
  'lease-changes': leaseChangesJob,
  'refresh-connections': refreshConnectionsJob,
  reunderwrite: reunderwriteJob,
  'refresh-eligibility': refreshEligibilityJob,
  'reconcile-payments': reconcilePaymentsJob,
  'age-receivables': ageReceivablesJob,
  'generate-periods': generatePeriodsJob,
  'process-payouts': processPayoutsJob,
  'collect-installments': collectInstallmentsJob,
  provision: provisionJob,
  'adverse-action-notices': adverseActionNoticesJob,
  monitor: (ctx: AppContext, asOf: IsoDate) => monitorJob(ctx, asOf, JOB_NAMES),
} as const;
export type JobName = keyof typeof JOBS;
/** Every job by name. The monitor checks that each of the others has been running. */
export const JOB_NAMES = [
  'rescreen',
  'lease-changes',
  'refresh-connections',
  'reunderwrite',
  'refresh-eligibility',
  'reconcile-payments',
  'age-receivables',
  'generate-periods',
  'process-payouts',
  'collect-installments',
  'provision',
  'adverse-action-notices',
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
 *   3. refresh-connections   Tokens near expiry are refreshed, and businesses with an active
 *                            plan are pulled again on the cadence and their veracity checked.
 *                            Before re-underwriting, which then reads the fresh pull.
 *   4. reunderwrite          A plan it freezes must get no new period and no payout today.
 *   5. refresh-eligibility   Graduation offers expire, accepted ones become financed plans
 *                            (before periods are generated, so the first financed period
 *                            exists today), and pass-through customers with enough on time
 *                            months are re-underwritten with their payment history.
 *   6. reconcile-payments    Payments that came back are undone before anything reads who
 *                            is paid up: a return can make a plan past due, or freeze it.
 *                            A pass-through collection that comes back before its landlord
 *                            payout makes that month missed, so it is never paid.
 *   7. age-receivables       Buckets and LATE marks are brought up to today, and plans at
 *                            the charge-off age are written off and closed, before periods
 *                            are generated or payouts decided for them.
 *   8. generate-periods      Next month's payout and installments exist, 30 days ahead, for
 *                            plans that are active and not frozen. Pass-through months too.
 *   9. process-payouts       Each due payout is paid, held, or cancelled, on the state the
 *                            three jobs above left. It runs before collections, so a
 *                            business has to be current at the start of the day for its
 *                            landlord to be paid, and so the first installment of a period
 *                            is collected on the day its payout goes out. Pass-through
 *                            collections past the return window settle here, and settled
 *                            months that are due are paid to the landlord.
 *  10. collect-installments  Scheduled debits, a payment's effect on the bucket, and then
 *                            the cash sweep: operating cash is settled with the pool. Then
 *                            pass-through collections whose window is open.
 *  11. provision             So the allowance is set on the day's closing balances. Posts
 *                            at most once per calendar month.
 *  12. adverse-action-notices  Counter offers that expired, applications left incomplete,
 *                            and any decline without its notice get their notices, so the
 *                            monitor reads them stored.
 *  13. monitor               Last: the rules read the state every other job left, and can
 *                            tell whether each of them ran.
 */
export async function runAllJobs(ctx: AppContext, asOf: IsoDate = todayIso()) {
  const rescreen = await rescreenJob(ctx, asOf);
  const leaseChanges = await leaseChangesJob(ctx, asOf);
  const refreshConnections = await refreshConnectionsJob(ctx, asOf);
  const reunderwrite = await reunderwriteJob(ctx, asOf);
  const refreshEligibility = await refreshEligibilityJob(ctx, asOf);
  const reconcilePayments = await reconcilePaymentsJob(ctx, asOf);
  const ageReceivables = await ageReceivablesJob(ctx, asOf);
  const generatePeriods = await generatePeriodsJob(ctx, asOf);
  const processPayouts = await processPayoutsJob(ctx, asOf);
  const collectInstallments = await collectInstallmentsJob(ctx, asOf);
  const provision = await provisionJob(ctx, asOf);
  const adverseActionNotices = await adverseActionNoticesJob(ctx, asOf);
  const monitor = await monitorJob(ctx, asOf, JOB_NAMES);
  return {
    asOf,
    rescreen,
    leaseChanges,
    refreshConnections,
    reunderwrite,
    refreshEligibility,
    reconcilePayments,
    ageReceivables,
    generatePeriods,
    processPayouts,
    collectInstallments,
    provision,
    adverseActionNotices,
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

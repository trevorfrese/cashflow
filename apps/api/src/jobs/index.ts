import type { IsoDate } from '@cashflow/shared';
import cron from 'node-cron';

import type { AppContext } from '../context.ts';
import { todayIso } from '../dates.ts';
import { collectInstallmentsJob } from './collect-installments.ts';
import { generatePeriodsJob } from './generate-periods.ts';
import { processPayoutsJob } from './process-payouts.ts';
import { reunderwriteJob } from './reunderwrite.ts';

export const JOBS = {
  reunderwrite: reunderwriteJob,
  'generate-periods': generatePeriodsJob,
  'process-payouts': processPayoutsJob,
  'collect-installments': collectInstallmentsJob,
} as const;
export type JobName = keyof typeof JOBS;

/**
 * Runs the jobs in dependency order. Re-underwriting goes first, so a plan it freezes gets
 * no new period and no payout in the same run. Then periods exist, landlords get paid, and
 * businesses repay.
 */
export async function runAllJobs(ctx: AppContext, asOf: IsoDate = todayIso()) {
  const reunderwrite = await reunderwriteJob(ctx, asOf);
  const generatePeriods = await generatePeriodsJob(ctx, asOf);
  const processPayouts = await processPayoutsJob(ctx, asOf);
  const collectInstallments = await collectInstallmentsJob(ctx, asOf);
  return { asOf, reunderwrite, generatePeriods, processPayouts, collectInstallments };
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

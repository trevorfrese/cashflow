import type { IsoDate } from '@cashflow/shared';
import cron from 'node-cron';

import type { AppContext } from '../context.ts';
import { todayIso } from '../dates.ts';
import { collectInstallmentsJob } from './collect-installments.ts';
import { generatePeriodsJob } from './generate-periods.ts';
import { processPayoutsJob } from './process-payouts.ts';

/** Runs the three jobs in dependency order: periods exist, landlords get paid, businesses repay. */
export async function runAllJobs(ctx: AppContext, asOf: IsoDate = todayIso()) {
  const generatePeriods = await generatePeriodsJob(ctx, asOf);
  const processPayouts = await processPayoutsJob(ctx, asOf);
  const collectInstallments = await collectInstallmentsJob(ctx, asOf);
  return { asOf, generatePeriods, processPayouts, collectInstallments };
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

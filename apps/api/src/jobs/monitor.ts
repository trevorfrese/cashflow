import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { MONITOR_JOB, runMonitor } from '../monitoring/service.ts';
import { runJob } from './runner.ts';

/**
 * Runs every monitoring rule and reconciles the result with the alerts that exist: opens
 * what is new, refreshes what persists, resolves what has cleared where the rule allows it,
 * and trips the circuit breaker on a critical portfolio breach. Last in the run, so it
 * reads the state every other job left and can tell whether they ran.
 *
 * Idempotent: a second run on the same state opens nothing.
 */
export function monitorJob(ctx: AppContext, asOf: IsoDate, jobNames: readonly string[]) {
  return runJob(ctx, MONITOR_JOB, asOf, async () => ({
    ...(await runMonitor(ctx, asOf, jobNames)),
  }));
}

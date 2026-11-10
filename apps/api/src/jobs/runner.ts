import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import type { Prisma } from '../generated/prisma/client.ts';

export type JobSummary = Record<string, number | string | boolean>;

/** Wraps a job so every run is recorded with its outcome, for visibility and auditing. */
export async function runJob(
  ctx: AppContext,
  name: string,
  asOf: IsoDate,
  fn: () => Promise<JobSummary>,
): Promise<{ ok: boolean; summary: JobSummary; error?: string }> {
  const run = await ctx.db.jobRun.create({ data: { name, asOf } });
  try {
    const summary = await fn();
    await ctx.db.jobRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: true, summary: summary as Prisma.InputJsonValue },
    });
    ctx.log.info({ job: name, asOf, ...summary }, 'job finished');
    return { ok: true, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db.jobRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, error: message },
    });
    ctx.log.error({ job: name, asOf, err }, 'job failed');
    return { ok: false, summary: {}, error: message };
  }
}

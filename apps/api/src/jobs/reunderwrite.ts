import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { reunderwritePlan } from '../services/reunderwriting.ts';
import { runJob } from './runner.ts';

/**
 * Periodic review. Once a month, every business with an active plan is scored again on
 * fresh bank data. The result is stored as a decision of kind PERIODIC_REVIEW. When it
 * falls below the watch threshold, or would now be a credit decline, the plan is frozen:
 * no new rent period is generated or paid to the landlord. A period already paid out is not
 * touched and is collected as normal. The freeze stays until a reviewer lifts it.
 *
 * Idempotent: a plan is reviewed at most once per calendar month, so running the job every
 * day, or twice on the same day, changes nothing after the first run of the month. A plan
 * whose bank feed is stale on the day is not reviewed and is picked up by a later run.
 */
export function reunderwriteJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'reunderwrite', asOf, async () => {
    const plans = await ctx.db.rentPlan.findMany({
      where: { kind: 'FINANCED', status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const counts = { plans: plans.length, reviewed: 0, alreadyReviewed: 0, frozen: 0, unscored: 0 };
    for (const { id } of plans) {
      const outcome = await reunderwritePlan(ctx, id, asOf);
      if (outcome === 'already_reviewed') counts.alreadyReviewed += 1;
      else {
        counts.reviewed += 1;
        if (outcome === 'frozen') counts.frozen += 1;
        else if (outcome === 'unscored') counts.unscored += 1;
      }
    }
    return counts;
  });
}

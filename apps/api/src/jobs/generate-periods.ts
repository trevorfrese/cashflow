import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { ensureUpcomingPeriods } from '../services/rent-plan.ts';
import { runJob } from './runner.ts';

/**
 * Creates next month's landlord payout and installments for every active plan, 30 days ahead.
 * A plan frozen by a periodic review gets no new period until the freeze is released.
 */
export function generatePeriodsJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'generate-periods', asOf, async () => {
    const plans = await ctx.db.rentPlan.findMany({
      where: { status: 'ACTIVE', advanceFrozenAt: null },
      include: { lease: true },
    });
    let created = 0;
    for (const plan of plans) {
      created += await ctx.db.$transaction((tx) =>
        ensureUpcomingPeriods(tx, { ...plan, startsOn: plan.lease.startsOn }, asOf),
      );
    }
    return { plans: plans.length, periodsCreated: created };
  });
}

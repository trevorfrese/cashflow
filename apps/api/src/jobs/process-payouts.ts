import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { processPayout } from '../services/payouts.ts';
import { runJob } from './runner.ts';

/** Pays every landlord whose rent is due today or earlier. Retries previously failed payouts. */
export function processPayoutsJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'process-payouts', asOf, async () => {
    const due = await ctx.db.landlordPayout.findMany({
      where: {
        status: { in: ['SCHEDULED', 'FAILED'] },
        scheduledFor: { lte: asOf },
        rentPlan: { status: 'ACTIVE' },
      },
      orderBy: { scheduledFor: 'asc' },
      select: { id: true },
    });
    const counts = { due: due.length, paid: 0, failed: 0, skipped: 0 };
    for (const { id } of due) {
      const outcome = await processPayout(ctx, id, asOf);
      counts[outcome] += 1;
    }
    return counts;
  });
}

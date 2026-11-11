import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { processPayout } from '../services/payouts.ts';
import { runJob } from './runner.ts';

/**
 * Decides every landlord payout that is due and not settled: pay it, hold it, or cancel it.
 * See `processPayout` for the rules. Plans that are paused, frozen, or closed are included,
 * because their payouts have to be held or cancelled, not left scheduled.
 *
 * Idempotent: a paid or cancelled payout is skipped, and a held one stays held without a
 * second audit event.
 */
export function processPayoutsJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'process-payouts', asOf, async () => {
    const due = await ctx.db.landlordPayout.findMany({
      where: {
        status: { in: ['SCHEDULED', 'HELD', 'FAILED'] },
        returnCode: null,
        scheduledFor: { lte: asOf },
      },
      orderBy: { scheduledFor: 'asc' },
      select: { id: true },
    });
    const counts = { due: due.length, paid: 0, failed: 0, held: 0, cancelled: 0, skipped: 0 };
    for (const { id } of due) {
      const outcome = await processPayout(ctx, id, asOf);
      counts[outcome] += 1;
    }
    return counts;
  });
}

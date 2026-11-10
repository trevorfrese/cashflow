import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { collectInstallment, sweepCashToPool } from '../services/collections.ts';
import { runJob } from './runner.ts';

/**
 * Collects every installment due today or earlier whose landlord payout has been made,
 * retrying failed and late ones, then sweeps collected cash back into the capital pool.
 */
export function collectInstallmentsJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'collect-installments', asOf, async () => {
    const due = await ctx.db.installment.findMany({
      where: {
        status: { in: ['SCHEDULED', 'FAILED', 'LATE'] },
        dueDate: { lte: asOf },
        payout: { status: 'PAID' },
        rentPlan: { status: 'ACTIVE' },
      },
      orderBy: { dueDate: 'asc' },
      select: { id: true },
    });
    const counts = { due: due.length, paid: 0, failed: 0, late: 0, skipped: 0, sweptCents: 0 };
    for (const { id } of due) {
      const outcome = await collectInstallment(ctx, id, asOf);
      counts[outcome] += 1;
    }
    counts.sweptCents = await sweepCashToPool(ctx, asOf);
    return counts;
  });
}

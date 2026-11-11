import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { collectInstallment, sweepCashToPool } from '../services/collections.ts';
import { UNPAID } from '../services/delinquency.ts';
import { runJob } from './runner.ts';

/**
 * Asks the servicing policy, for every unpaid installment that is due and whose landlord
 * payout has been made, whether a debit is scheduled today, and makes it. Plans that are
 * paused or closed are included: pausing stops new rent periods, not repayment. Written off
 * installments are not debited automatically. Then settles operating cash with the pool.
 *
 * Idempotent: an installment attempted today is not attempted again until the policy's
 * retry interval has passed.
 */
export function collectInstallmentsJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'collect-installments', asOf, async () => {
    const due = await ctx.db.installment.findMany({
      where: {
        status: { in: UNPAID },
        dueDate: { lte: asOf },
        payout: { status: 'PAID' },
      },
      orderBy: { dueDate: 'asc' },
      select: { id: true },
    });
    const counts = {
      due: due.length,
      paid: 0,
      failed: 0,
      late: 0,
      deferred: 0,
      skipped: 0,
      sweptCents: 0,
    };
    for (const { id } of due) {
      const outcome = await collectInstallment(ctx, id, asOf);
      counts[outcome] += 1;
    }
    counts.sweptCents = await sweepCashToPool(ctx, asOf);
    return counts;
  });
}

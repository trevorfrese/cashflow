import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { sweepCashToPool } from '../services/collections.ts';
import { reconcileReturns } from '../services/returns.ts';
import { runJob } from './runner.ts';

/**
 * Polls the payments provider for payments that came back and undoes each one: a returned
 * installment is unpaid again with a reversing ledger posting, a returned landlord payout
 * restores the pool and takes the receivable off. One database transaction per return.
 * Operating cash taken below zero by a reversal is then covered from the pool.
 *
 * Idempotent: a return already handled is recognised by the status of its payment and
 * skipped, so polling the same window again changes nothing.
 */
export function reconcilePaymentsJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'reconcile-payments', asOf, async () => {
    const counts = await reconcileReturns(ctx, asOf);
    const sweptCents = await sweepCashToPool(ctx, asOf);
    return { ...counts, sweptCents };
  });
}

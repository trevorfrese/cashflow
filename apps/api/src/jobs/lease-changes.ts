import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { applyDueLeaseChanges } from '../services/lease-changes.ts';
import { runJob } from './runner.ts';

/**
 * Applies landlord and payout changes whose cooling-off period has ended. A change whose
 * proposed landlord has an open screening hit is left pending. Runs before payouts are
 * processed, so a payout held by a change is paid, to the new details, on the day the
 * change applies.
 *
 * Idempotent: an applied change is no longer pending.
 */
export function leaseChangesJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'lease-changes', asOf, async () => ({
    ...(await applyDueLeaseChanges(ctx, asOf)),
  }));
}

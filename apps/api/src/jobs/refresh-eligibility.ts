import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import {
  completeAcceptedOffers,
  expireGraduationOffers,
  reviewEligibility,
} from '../services/graduation.ts';
import { runJob } from './runner.ts';

/**
 * Graduation from pass-through to financed plans. In order:
 *
 *   1. Offers past their date that were never accepted expire.
 *   2. Accepted offers become financed plans, once no pass-through month is in flight.
 *      Never mid-cycle: the financed plan takes over from the next month.
 *   3. Every running pass-through plan with enough on time months in a row is re-underwritten
 *      on freshly pulled data and its payment history, at most once a calendar month, and
 *      offered a financed plan when it now qualifies for the lease rent.
 *
 * After `reunderwrite` and before payouts and periods are generated, so a financed plan
 * opened today gets its first period generated today. Idempotent: an expired offer is not
 * expired again, a completed offer is skipped, and a plan reviewed this month is not reviewed
 * again (the decision is keyed by application and month, with a unique index).
 */
export function refreshEligibilityJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'refresh-eligibility', asOf, async () => {
    const expired = await expireGraduationOffers(ctx, asOf);
    const completion = await completeAcceptedOffers(ctx, asOf);
    const plans = await ctx.db.rentPlan.findMany({
      where: { kind: 'PASS_THROUGH', status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const counts = {
      expired,
      acceptedOffers: completion.accepted,
      graduated: completion.completed,
      graduationWaiting: completion.waiting,
      graduationWithdrawn: completion.withdrawn,
      passThroughPlans: plans.length,
      reviewed: 0,
      offered: 0,
      notQualified: 0,
      notReady: 0,
      unscored: 0,
    };
    for (const { id } of plans) {
      const outcome = await reviewEligibility(ctx, id, asOf);
      if (outcome === 'offered') {
        counts.reviewed += 1;
        counts.offered += 1;
      } else if (outcome === 'not_qualified') {
        counts.reviewed += 1;
        counts.notQualified += 1;
      } else if (outcome === 'not_ready') counts.notReady += 1;
      else if (outcome === 'unscored') counts.unscored += 1;
    }
    return counts;
  });
}

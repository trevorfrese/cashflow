import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { chargeOffPlan } from '../services/charge-off.ts';
import { refreshDelinquency, UNPAID } from '../services/delinquency.ts';
import { ACTIVE_SERVICING_POLICY, shouldChargeOff } from '../servicing/policy.ts';
import { runJob } from './runner.ts';

/**
 * Ages every plan that owes anything, every day, whether or not a debit is attempted.
 *
 * For each plan with an unpaid installment on rent already paid to the landlord, and each
 * plan whose stored bucket is not CURRENT (so a plan that cured is moved back): recompute
 * the delinquency bucket from the oldest unpaid installment, mark installments LATE once
 * they are past grace, and write an audit event when the bucket changes. Then write off any
 * plan whose oldest unpaid installment has reached the policy's charge-off age, and anything
 * that reopened on a plan already written off.
 *
 * Idempotent: a second run on the same date finds every bucket already right and nothing
 * left to write off.
 */
export function ageReceivablesJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'age-receivables', asOf, async () => {
    const policy = ACTIVE_SERVICING_POLICY;
    const plans = await ctx.db.rentPlan.findMany({
      where: {
        OR: [
          { delinquencyStatus: { notIn: ['CURRENT', 'CHARGED_OFF'] } },
          {
            installments: {
              some: { status: { in: UNPAID }, payout: { status: 'PAID' }, dueDate: { lte: asOf } },
            },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, delinquencyStatus: true },
    });
    const counts = {
      plans: plans.length,
      bucketChanges: 0,
      chargedOffPlans: 0,
      chargedOffCents: 0,
    };
    const actor = { type: 'job' as const, id: 'age-receivables' };
    for (const plan of plans) {
      const state = await ctx.db.$transaction((tx) => refreshDelinquency(tx, plan.id, asOf, actor));
      if (state.changed) counts.bucketChanges += 1;
      const oldest = await ctx.db.installment.findFirst({
        where: { rentPlanId: plan.id, status: { in: UNPAID }, payout: { status: 'PAID' } },
        orderBy: { dueDate: 'asc' },
        select: { dueDate: true },
      });
      if (!oldest) continue;
      if (
        plan.delinquencyStatus === 'CHARGED_OFF' ||
        shouldChargeOff(policy, oldest.dueDate, asOf)
      ) {
        const result = await chargeOffPlan(ctx, plan.id, asOf);
        if (result.installments > 0) {
          counts.chargedOffPlans += 1;
          counts.chargedOffCents += result.chargedOffCents;
        }
      }
    }
    return counts;
  });
}

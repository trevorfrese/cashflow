import { daysBetween, type IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { CONTROLS_POLICY } from '../controls/policy.ts';
import { effectiveAt } from '../dates.ts';
import { screenLandlord, screenParty } from '../services/identity.ts';
import { runJob } from './runner.ts';

/**
 * Periodic sanctions and watchlist screening. Every business that is active or has a plan
 * that is not closed, each of its owners, and the landlord on each lease with such a plan,
 * is screened again once its current result is older than the policy interval (or it has
 * none). A new hit freezes the plans the party is tied to, exactly as at onboarding.
 *
 * Idempotent: a party screened inside the interval is skipped, so running the job every day
 * rescreens each party once per interval.
 */
export function rescreenJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'rescreen', asOf, async () => {
    const interval = CONTROLS_POLICY.rescreenIntervalDays;
    const at = effectiveAt(asOf);
    const actor = { type: 'job' as const, id: 'rescreen' };
    const businesses = await ctx.db.business.findMany({
      where: { OR: [{ status: 'ACTIVE' }, { rentPlans: { some: { status: { not: 'CLOSED' } } } }] },
      include: {
        owners: true,
        leases: {
          where: {
            status: { not: 'ENDED' },
            rentPlans: { some: { status: { not: 'CLOSED' } } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const current = await ctx.db.screeningResult.findMany({
      where: {
        supersededAt: null,
        leaseChangeId: null,
        businessId: { in: businesses.map((b) => b.id) },
      },
      select: { partyType: true, partyRef: true, screenedAt: true },
    });
    const lastScreened = new Map(
      current.map((s) => [`${s.partyType}:${s.partyRef}`, s.screenedAt.toISOString().slice(0, 10)]),
    );
    const due = (partyType: string, partyRef: string) => {
      const on = lastScreened.get(`${partyType}:${partyRef}`);
      return on === undefined || daysBetween(on, asOf) >= interval;
    };

    const counts = { businesses: businesses.length, parties: 0, screened: 0, hits: 0 };
    const tally = (row: { result: string; clearedAt: Date | null }) => {
      counts.screened += 1;
      if (row.result !== 'CLEAR' && row.clearedAt === null) counts.hits += 1;
    };
    for (const business of businesses) {
      counts.parties += 1 + business.owners.length + business.leases.length;
      if (due('BUSINESS', business.id)) {
        tally(
          await screenParty(ctx, {
            businessId: business.id,
            partyType: 'BUSINESS',
            partyRef: business.id,
            name: business.legalName,
            aliases: business.dba ? [business.dba] : [],
            actor,
            at,
          }),
        );
      }
      for (const owner of business.owners) {
        if (!due('OWNER', owner.id)) continue;
        tally(
          await screenParty(ctx, {
            businessId: business.id,
            partyType: 'OWNER',
            partyRef: owner.id,
            name: owner.fullName,
            actor,
            at,
          }),
        );
      }
      for (const lease of business.leases) {
        if (!due('LANDLORD', lease.id)) continue;
        tally(await screenLandlord(ctx, lease, { actor, at }));
      }
    }
    return counts;
  });
}

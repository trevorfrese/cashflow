import { addDays, type IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import {
  REFRESH_CADENCE_DAYS,
  TOKEN_REFRESH_LEAD_DAYS,
  gatherDecisionData,
  refreshCommerceToken,
} from '../services/connections.ts';
import { recordAudit } from '../services/audit.ts';
import { CURRENT_POLICY } from '../underwriting/policy.ts';
import { assessVeracity } from '../veracity/assess.ts';
import { runJob } from './runner.ts';

/**
 * Keeps connections usable and watched:
 *
 *   1. Platform tokens that expire within TOKEN_REFRESH_LEAD_DAYS are refreshed. A refusal
 *      marks the connection REAUTH_REQUIRED (the owner is prompted, monitoring alerts).
 *   2. Every business with an active plan is pulled again once its last pull is
 *      REFRESH_CADENCE_DAYS old, through the same path a decision uses (snapshots, the
 *      freshness rule), and the veracity checks run on the result. The assessment is audited
 *      on the business, which is what the monitoring rules read. A failed pull marks the
 *      connection ERROR or REAUTH_REQUIRED.
 *
 * Idempotent per day: a business is pulled and assessed at most once a day (its audited
 * assessment marks the day done, even when the pull failed), and a token is only refreshed
 * when it is near expiry. Runs before re-underwriting, so a monthly review that
 * falls on the same day reads the fresh pull instead of making its own.
 */
export function refreshConnectionsJob(ctx: AppContext, asOf: IsoDate) {
  return runJob(ctx, 'refresh-connections', asOf, async () => {
    const counts = {
      tokensRefreshed: 0,
      tokensFailed: 0,
      businesses: 0,
      pulled: 0,
      assessed: 0,
      unhealthy: 0,
    };
    const horizon = new Date(effectiveAt(asOf).getTime() + TOKEN_REFRESH_LEAD_DAYS * 86_400_000);
    const expiring = await ctx.db.commerceLink.findMany({
      where: {
        status: 'LINKED',
        accessMethod: 'DIRECT_OAUTH',
        refreshTokenEnc: { not: null },
        tokenExpiresAt: { lte: horizon },
        health: { not: 'REVOKED' },
      },
    });
    for (const link of expiring) {
      try {
        await refreshCommerceToken(ctx, link, asOf);
        counts.tokensRefreshed += 1;
      } catch {
        counts.tokensFailed += 1;
      }
    }

    const due = addDays(asOf, -(REFRESH_CADENCE_DAYS - 1));
    const businesses = await ctx.db.business.findMany({
      where: { rentPlans: { some: { status: 'ACTIVE' } } },
      include: {
        bankLinks: { where: { status: 'LINKED' }, orderBy: { createdAt: 'desc' }, take: 1 },
        commerceLinks: { where: { status: 'LINKED' }, orderBy: { createdAt: 'desc' }, take: 1 },
        rentPlans: { where: { status: 'ACTIVE' }, include: { application: true }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });
    const policy = CURRENT_POLICY.veracity;
    for (const business of businesses) {
      counts.businesses += 1;
      const bankLink = business.bankLinks[0] ?? null;
      const commerceLink = business.commerceLinks[0] ?? null;
      if (!bankLink) continue;
      // Due when a connection has never been pulled or its last pull is a cadence old. A pull
      // dated after `asOf` (history being replayed) is not redone day by day.
      const isDue = [bankLink, commerceLink].some((l) => {
        if (!l) return false;
        const on = l.lastPulledAt ? l.lastPulledAt.toISOString().slice(0, 10) : null;
        return on === null || on < due;
      });
      if (!isDue) continue;
      // Once a day, whether or not the pull worked: a failed pull leaves the last pull date
      // where it was, so the job's own assessment of the day is what marks it done.
      const done = await ctx.db.auditEvent.findFirst({
        where: {
          eventType: 'VERACITY_ASSESSED',
          subjectType: 'business',
          subjectId: business.id,
          at: { gte: new Date(`${asOf}T00:00:00.000Z`), lte: new Date(`${asOf}T23:59:59.999Z`) },
        },
        select: { id: true },
      });
      if (done) continue;
      const plan = business.rentPlans[0]!;
      const data = await gatherDecisionData(ctx, {
        businessId: business.id,
        bankLink,
        commerceLink,
        timeInBusinessMonths: plan.application.timeInBusinessMonths,
        asOf,
        reason: 'REFRESH',
        periodicReview: true,
      });
      counts.pulled += 1;
      if (
        data.veracity.banks.some((b) => b.current === null) ||
        data.veracity.commerce.some((c) => c.current === null)
      ) {
        counts.unhealthy += 1;
      }
      if (!policy) continue;
      const v = assessVeracity(data.veracity, policy);
      const rec = v.reconciliation[0] ?? null;
      await recordAudit(ctx.db, {
        actor: { type: 'job', id: 'refresh-connections' },
        eventType: 'VERACITY_ASSESSED',
        subjectType: 'business',
        subjectId: business.id,
        payload: {
          businessId: business.id,
          decisionId: null,
          outcome: v.overall.outcome,
          trustTier: v.overall.trustTier,
          independentlyVerifiedSources: v.overall.independentlyVerifiedSources,
          findings: v.findings.map((f) => ({
            code: f.code,
            consequence: f.consequence,
            connectionId: f.connectionId,
          })),
          matchedShareByAmountBps: rec?.matchedShareByAmountBps ?? null,
          payoutsConsidered: rec?.payoutsConsidered ?? null,
          snapshots: v.snapshots.map((s) => ({
            id: s.id,
            kind: s.kind,
            contentHash: s.contentHash,
          })),
        },
        at: effectiveAt(asOf),
      });
      counts.assessed += 1;
    }
    return counts;
  });
}

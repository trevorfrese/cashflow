import {
  AcknowledgeAlertRequest,
  AdminIdentity,
  Alert,
  AlertDetail,
  AlertList,
  AuditEventView,
  BusinessIdentityView,
  Cents,
  CircuitBreakerStatus,
  ClearScreeningRequest,
  DecideLeaseChangeRequest,
  DelinquencySummary,
  Id,
  IsoDateSchema,
  LandlordPayout,
  LeaseChangeStatus,
  LeaseChangeView,
  LedgerAccount,
  ListAlertsQuery,
  MonitoringSummary,
  RecordReviewRequest,
  RecordReviewResponse,
  ReleaseFreezeRequest,
  RentPlan,
  ResendPayoutRequest,
  ResetCircuitBreakerRequest,
  ResolveAlertRequest,
  ReviewQueueItem,
  ScreeningResult,
  TrialBalance,
  type LeaseChangeField,
} from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { adminIdentity, requireRole } from '../auth/admin.ts';
import { todayIso } from '../dates.ts';
import type { Db } from '../db.ts';
import { notFound } from '../errors.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { JOB_NAMES, JOBS, runAllJobs } from '../jobs/index.ts';
import { trialBalance } from '../ledger/service.ts';
import {
  acknowledgeAlert,
  alertDetail,
  listAlerts,
  monitoringSummary,
  resolveAlert,
  toAlert,
  toAuditEventView,
} from '../monitoring/service.ts';
import { toApplication, toPayout, toRentPlan, toReview } from '../serializers.ts';
import { AUDIT_SUBJECT_TYPES, recordAudit } from '../services/audit.ts';
import { breakerStatus, resetBreaker } from '../services/circuit-breaker.ts';
import { planStandings } from '../services/delinquency.ts';
import { clearScreening, SCREENING_FREEZE_REASON } from '../services/identity.ts';
import { decideLeaseChange } from '../services/lease-changes.ts';
import { resendReturnedPayout } from '../services/payouts.ts';
import { delinquencySummary } from '../services/provisioning.ts';
import { releaseAdvanceFreeze } from '../services/rent-plan.ts';
import { listReviewQueue, recordReview } from '../services/reviews.ts';

const Params = z.object({ id: Id });

/** Landlord columns as an operator sees them. The payout token is never shown. */
function landlordView(json: unknown) {
  const v = (json ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof v[key] === 'string' ? (v[key] as string) : undefined);
  return {
    landlordName: text('landlordName'),
    landlordEmail: text('landlordEmail'),
    accountHolderName: text('landlordAccountHolderName'),
    routingNumber: text('landlordRoutingNumber'),
    accountNumberLast4: text('landlordAccountNumberLast4'),
    ...('landlordPayoutToken' in v || v.payoutTokenChanged === true
      ? { payoutTokenChanged: true }
      : {}),
  };
}

export async function leaseChangeViews(db: Db, where: Prisma.LeaseChangeWhereInput) {
  const rows = await db.leaseChange.findMany({
    where,
    include: {
      lease: {
        include: {
          business: { select: { legalName: true } },
          rentPlans: {
            where: { status: { not: 'CLOSED' } },
            select: {
              payouts: {
                where: { status: { in: ['SCHEDULED', 'HELD', 'FAILED'] } },
                orderBy: { scheduledFor: 'asc' },
              },
            },
          },
        },
      },
    },
    orderBy: { requestedAt: 'desc' },
    take: 200,
  });
  const screenings = await db.screeningResult.findMany({
    where: { leaseChangeId: { in: rows.map((r) => r.id) } },
    orderBy: { screenedAt: 'desc' },
  });
  return rows.map((c) => {
    const screening = screenings.find((s) => s.leaseChangeId === c.id) ?? null;
    return {
      id: c.id,
      leaseId: c.leaseId,
      businessId: c.businessId,
      businessName: c.lease.business.legalName,
      status: c.status,
      fields: c.fields as LeaseChangeField[],
      previous: landlordView(c.previous),
      proposed: landlordView(c.changes),
      requestedByUserId: c.requestedByUserId,
      requestedAt: c.requestedAt.toISOString(),
      effectiveOn: c.effectiveOn,
      appliedAt: c.appliedAt?.toISOString() ?? null,
      decidedBy: c.decidedBy,
      decidedAt: c.decidedAt?.toISOString() ?? null,
      decisionReason: c.decisionReason,
      cancelledAt: c.cancelledAt?.toISOString() ?? null,
      screening: screening
        ? {
            id: screening.id,
            result: screening.result,
            cleared: screening.result === 'CLEAR' || screening.clearedAt !== null,
          }
        : null,
      affectedPayouts:
        c.status === 'PENDING'
          ? c.lease.rentPlans
              .flatMap((p) => p.payouts)
              .filter((p) => p.status === 'HELD' || p.scheduledFor <= c.effectiveOn)
              .map((p) => ({
                id: p.id,
                periodMonth: p.periodMonth,
                scheduledFor: p.scheduledFor,
                amountCents: p.amountCents,
                status: p.status,
              }))
          : [],
    };
  });
}

export async function screeningViews(db: Db, where: Prisma.ScreeningResultWhereInput) {
  const rows = await db.screeningResult.findMany({
    where,
    include: {
      business: {
        select: {
          legalName: true,
          rentPlans: {
            where: { status: { not: 'CLOSED' }, advanceFrozenReason: SCREENING_FREEZE_REASON },
            select: { id: true, leaseId: true },
          },
        },
      },
    },
    orderBy: { screenedAt: 'desc' },
    take: 200,
  });
  return rows.map((s) => {
    const open = s.result !== 'CLEAR' && s.clearedAt === null && s.supersededAt === null;
    return {
      id: s.id,
      businessId: s.businessId,
      businessName: s.business.legalName,
      partyType: s.partyType,
      partyRef: s.partyRef,
      nameScreened: s.nameScreened,
      country: s.country,
      result: s.result,
      provider: s.provider,
      providerRef: s.providerRef,
      leaseChangeId: s.leaseChangeId,
      screenedAt: s.screenedAt.toISOString(),
      supersededAt: s.supersededAt?.toISOString() ?? null,
      clearedBy: s.clearedBy,
      clearedAt: s.clearedAt?.toISOString() ?? null,
      clearedReason: s.clearedReason,
      open,
      frozenRentPlanIds:
        open && !s.leaseChangeId
          ? s.business.rentPlans
              .filter((p) => s.partyType !== 'LANDLORD' || p.leaseId === s.partyRef)
              .map((p) => p.id)
          : [],
    };
  });
}

/**
 * Operator routes. Mounted only when ENABLE_ADMIN=true, which in turn needs
 * ADMIN_API_TOKEN, and every one of them needs a bearer token and the X-Admin-Actor header
 * (see `auth/admin.ts`). `reviewer` routes also accept the admin token.
 *
 * Every route that changes state writes an audit event whose actor is the role of the
 * token and the person named in the header. No route takes who is acting from the body.
 */
export async function adminRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, providers, config } = app.ctx;
  const reviewer = { preHandler: [requireRole(config, 'reviewer')] };
  const admin = { preHandler: [requireRole(config, 'admin')] };
  const tags = ['admin'];
  const security = [{ operatorToken: [] }];

  /** Who the API thinks is calling. Lets a console check its token and show the role. */
  r.get(
    '/admin/whoami',
    { ...reviewer, schema: { tags, security, response: { 200: AdminIdentity } } },
    async (request) => adminIdentity(request),
  );

  // ---------- Admin only: money and controls ----------

  /** Run every job as of a date, or one job by name. */
  r.post(
    '/admin/jobs/run',
    {
      ...admin,
      schema: {
        tags,
        security,
        body: z
          .object({ asOf: IsoDateSchema.optional(), only: z.enum(JOB_NAMES).optional() })
          .nullish(),
        response: { 200: z.object({ asOf: z.string() }).passthrough() },
      },
    },
    async (request) => {
      const identity = adminIdentity(request);
      const asOf = request.body?.asOf ?? todayIso();
      const only = request.body?.only;
      await recordAudit(db, {
        actor: { type: identity.role, id: identity.actor },
        eventType: 'JOBS_RUN_REQUESTED',
        subjectType: 'system',
        subjectId: 'jobs',
        payload: { asOf, only: only ?? null },
      });
      if (only) return { asOf, [only]: await JOBS[only](app.ctx, asOf) };
      return runAllJobs(app.ctx, asOf);
    },
  );

  r.post(
    '/admin/capital/fund',
    {
      ...admin,
      schema: {
        tags,
        security,
        body: z.object({
          amountCents: Cents.refine((v) => v > 0),
          description: z.string().max(200).optional(),
        }),
        response: { 200: z.object({ availableCents: z.number().int() }) },
      },
    },
    async (request) => {
      const identity = adminIdentity(request);
      await db.$transaction(async (tx) => {
        await providers.capital.fund(
          tx,
          request.body.amountCents,
          request.body.description ?? 'Manual funding',
        );
        await recordAudit(tx, {
          actor: { type: identity.role, id: identity.actor },
          eventType: 'POOL_FUNDED',
          subjectType: 'system',
          subjectId: 'capital_pool',
          payload: {
            amountCents: request.body.amountCents,
            description: request.body.description ?? null,
          },
        });
      });
      return { availableCents: await providers.capital.availableCents(db) };
    },
  );

  /** Reset the circuit breaker so clean applications are approved automatically again. */
  r.post(
    '/admin/circuit-breaker/reset',
    {
      ...admin,
      schema: {
        tags,
        security,
        body: ResetCircuitBreakerRequest,
        response: { 200: CircuitBreakerStatus },
      },
    },
    async (request) =>
      resetBreaker(db, { identity: adminIdentity(request), reason: request.body.reason }),
  );

  // ---------- Reviewer: read the book ----------

  r.get(
    '/admin/ledger/trial-balance',
    { ...reviewer, schema: { tags, security, response: { 200: TrialBalance } } },
    async () => trialBalance(db),
  );

  r.get(
    '/admin/ledger/accounts',
    { ...reviewer, schema: { tags, security, response: { 200: z.array(LedgerAccount) } } },
    async () => {
      const rows = await db.ledgerAccount.findMany({ orderBy: { code: 'asc' } });
      return rows.map((a) => ({
        id: a.id,
        code: a.code,
        name: a.name,
        type: a.type,
        ownerType: a.ownerType,
        ownerId: a.ownerId,
      }));
    },
  );

  r.get(
    '/admin/capital',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        response: { 200: z.object({ provider: z.string(), availableCents: z.number().int() }) },
      },
    },
    async () => ({
      provider: providers.capital.name,
      availableCents: await providers.capital.availableCents(db),
    }),
  );

  /**
   * Delinquency and the loss accounts: plans and principal by bucket with the reserve the
   * servicing policy calls for, the allowance, charge-offs and recoveries to date, held
   * payouts, and frozen plans.
   */
  r.get(
    '/admin/delinquency',
    { ...reviewer, schema: { tags, security, response: { 200: DelinquencySummary } } },
    async () => delinquencySummary(db, todayIso()),
  );

  /** The audit trail for one record, oldest first. */
  r.get(
    '/admin/audit-events',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        querystring: z.object({ subjectType: z.enum(AUDIT_SUBJECT_TYPES), subjectId: Id }),
        response: { 200: z.array(AuditEventView) },
      },
    },
    async (request) => {
      const rows = await db.auditEvent.findMany({
        where: { subjectType: request.query.subjectType, subjectId: request.query.subjectId },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      });
      return rows.map(toAuditEventView);
    },
  );

  r.get(
    '/admin/circuit-breaker',
    { ...reviewer, schema: { tags, security, response: { 200: CircuitBreakerStatus } } },
    async () => breakerStatus(db),
  );

  /** Open alerts by severity and type, the breaker, and the last run of every job and rule. */
  r.get(
    '/admin/monitoring/summary',
    { ...reviewer, schema: { tags, security, response: { 200: MonitoringSummary } } },
    async () => monitoringSummary(db, todayIso(), JOB_NAMES),
  );

  /** Verification state of one business and its owners, as the identity provider left it. */
  r.get(
    '/admin/businesses/:id/identity',
    {
      ...reviewer,
      schema: { tags, security, params: Params, response: { 200: BusinessIdentityView } },
    },
    async (request) => {
      const b = await db.business.findUnique({
        where: { id: request.params.id },
        include: { owners: { orderBy: { createdAt: 'asc' } } },
      });
      if (!b) throw notFound('Business');
      return {
        businessId: b.id,
        legalName: b.legalName,
        taxIdLast4: b.taxIdLast4,
        verificationStatus: b.verificationStatus,
        verificationCheckedAt: b.verificationCheckedAt?.toISOString() ?? null,
        verificationProvider: b.verificationProvider,
        verificationRef: b.verificationRef,
        verificationReasons: b.verificationReasons,
        owners: b.owners.map((o) => ({
          id: o.id,
          fullName: o.fullName,
          title: o.title,
          ownershipBps: o.ownershipBps,
          verificationStatus: o.verificationStatus,
          verificationRef: o.verificationRef,
        })),
      };
    },
  );

  // ---------- Reviewer: the review queue ----------

  /**
   * The review queue: applications the engine referred, oldest first, with the engine's
   * recommendation, the referral triggers, and the integrity flags. This is the only route
   * that exposes those internals.
   */
  r.get(
    '/admin/reviews',
    { ...reviewer, schema: { tags, security, response: { 200: z.array(ReviewQueueItem) } } },
    async () => listReviewQueue(db),
  );

  /**
   * Record a decision on a referred application, or reconsider a declined one. Produces a
   * new current decision; the engine's stays in the history. A review that differs from the
   * engine's recommendation is an override and needs reason codes. The reviewer is the
   * person in the X-Admin-Actor header.
   */
  r.post(
    '/admin/applications/:id/review',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        params: Params,
        body: RecordReviewRequest,
        response: { 200: RecordReviewResponse },
      },
    },
    async (request) => {
      const { review, application } = await recordReview(db, {
        applicationId: request.params.id,
        identity: adminIdentity(request),
        ...request.body,
      });
      return { review: toReview(review), application: toApplication(application) };
    },
  );

  /**
   * Lift a freeze on a plan (periodic review, unauthorized return, returned payout). A
   * payout held by the freeze is paid on the next job run if it is still inside its release
   * window; otherwise it is cancelled. Refused while a screening hit on the plan is open.
   */
  r.post(
    '/admin/rent-plans/:id/release-freeze',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        params: Params,
        body: ReleaseFreezeRequest,
        response: { 200: RentPlan },
      },
    },
    async (request) => {
      const plan = await releaseAdvanceFreeze(db, {
        planId: request.params.id,
        identity: adminIdentity(request),
        reason: request.body.reason,
      });
      const standings = await planStandings(db, [plan], todayIso());
      return toRentPlan(plan, standings.get(plan.id));
    },
  );

  /**
   * Send a landlord payout again after it came back from the landlord's bank, once the
   * landlord's details have been corrected and the correction has cleared its cooling-off.
   */
  r.post(
    '/admin/payouts/:id/resend',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        params: Params,
        body: ResendPayoutRequest,
        response: { 200: LandlordPayout },
      },
    },
    async (request) =>
      toPayout(
        await resendReturnedPayout(app.ctx, {
          payoutId: request.params.id,
          identity: adminIdentity(request),
          reason: request.body.reason,
          asOf: todayIso(),
        }),
      ),
  );

  // ---------- Reviewer: alerts ----------

  r.get(
    '/admin/alerts',
    {
      ...reviewer,
      schema: { tags, security, querystring: ListAlertsQuery, response: { 200: AlertList } },
    },
    async (request) => listAlerts(db, request.query),
  );

  /** One alert with what it is about, its rule, related alerts, and the audit trail. */
  r.get(
    '/admin/alerts/:id',
    { ...reviewer, schema: { tags, security, params: Params, response: { 200: AlertDetail } } },
    async (request) => alertDetail(db, request.params.id),
  );

  r.post(
    '/admin/alerts/:id/acknowledge',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        params: Params,
        body: AcknowledgeAlertRequest.nullish(),
        response: { 200: Alert },
      },
    },
    async (request) =>
      toAlert(
        await acknowledgeAlert(db, {
          alertId: request.params.id,
          identity: adminIdentity(request),
          notes: request.body?.notes,
        }),
      ),
  );

  r.post(
    '/admin/alerts/:id/resolve',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        params: Params,
        body: ResolveAlertRequest,
        response: { 200: Alert },
      },
    },
    async (request) =>
      toAlert(
        await resolveAlert(db, {
          alertId: request.params.id,
          identity: adminIdentity(request),
          disposition: request.body.disposition,
          notes: request.body.notes,
        }),
      ),
  );

  // ---------- Reviewer: lease changes ----------

  r.get(
    '/admin/lease-changes',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        querystring: z.object({
          status: z.union([LeaseChangeStatus, z.literal('ALL')]).default('PENDING'),
        }),
        response: { 200: z.array(LeaseChangeView) },
      },
    },
    async (request) =>
      leaseChangeViews(db, request.query.status === 'ALL' ? {} : { status: request.query.status }),
  );

  /** Approve a pending change before its cooling-off ends, or reject it. */
  r.post(
    '/admin/lease-changes/:id/decide',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        params: Params,
        body: DecideLeaseChangeRequest,
        response: { 200: LeaseChangeView },
      },
    },
    async (request) => {
      await decideLeaseChange(app.ctx, {
        changeId: request.params.id,
        identity: adminIdentity(request),
        decision: request.body.decision,
        reason: request.body.reason,
      });
      const [view] = await leaseChangeViews(db, { id: request.params.id });
      if (!view) throw notFound('Lease change');
      return view;
    },
  );

  // ---------- Reviewer: screening ----------

  /** Screening results. `open` (the default) is hits waiting for a person. */
  r.get(
    '/admin/screening/hits',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        querystring: z.object({
          status: z.enum(['open', 'cleared', 'all']).default('open'),
          businessId: Id.optional(),
        }),
        response: { 200: z.array(ScreeningResult) },
      },
    },
    async (request) => {
      const hit = { result: { in: ['POSSIBLE_MATCH', 'MATCH'] as ('POSSIBLE_MATCH' | 'MATCH')[] } };
      const byStatus: Prisma.ScreeningResultWhereInput =
        request.query.status === 'open'
          ? { ...hit, clearedAt: null, supersededAt: null }
          : request.query.status === 'cleared'
            ? { ...hit, clearedAt: { not: null } }
            : hit;
      return screeningViews(db, {
        ...byStatus,
        ...(request.query.businessId ? { businessId: request.query.businessId } : {}),
      });
    },
  );

  /**
   * Clear a hit: the match is not the party. Records who and why, and releases the plans it
   * froze. A possible match can be cleared by a reviewer; a match needs an admin.
   */
  r.post(
    '/admin/screening/:id/clear',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        params: Params,
        body: ClearScreeningRequest,
        response: { 200: ScreeningResult },
      },
    },
    async (request) => {
      await clearScreening(db, {
        screeningId: request.params.id,
        identity: adminIdentity(request),
        reason: request.body.reason,
      });
      const [view] = await screeningViews(db, { id: request.params.id });
      if (!view) throw notFound('Screening result');
      return view;
    },
  );
}

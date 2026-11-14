import {
  AuditLogPage,
  AuditLogQuery,
  Id,
  OperatorApplicationDetail,
  OperatorBusinessDetail,
  OperatorBusinessList,
  OperatorBusinessListQuery,
  OperatorConnections,
  OperatorEvaluation,
  OperatorJobs,
  OperatorJobsQuery,
  OperatorLatePlans,
  OperatorPolicy,
  OperatorPortfolio,
  OperatorRentPlan,
} from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { requireRole } from '../auth/admin.ts';
import { notFound } from '../errors.ts';
import { todayIso } from '../dates.ts';
import { JOB_NAMES } from '../jobs/index.ts';
import { operatorConnections } from '../services/connection-views.ts';
import { jobsView, latePlansView } from '../services/operations.ts';
import {
  applicationDetail,
  auditLog,
  businessDetail,
  businessRentPlans,
  evaluationView,
  listBusinesses,
  policyView,
  portfolioView,
} from '../services/operator.ts';

const Params = z.object({ id: Id });

/**
 * Read routes for the operations console (`apps/ops`). Mounted with the other operator
 * routes, only when ENABLE_ADMIN=true, and every one needs a `reviewer` or `admin` bearer
 * token plus the X-Admin-Actor header. They are all reads: nothing here changes state, so
 * nothing here writes an audit event. The actions the console takes go through the routes
 * in `admin.ts`, which do.
 *
 * The responses are operator views (`services/operator.ts`). They carry internals no
 * customer route returns, and the customer serializers are not touched.
 */
export async function adminConsoleRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, providers, config } = app.ctx;
  const reviewer = { preHandler: [requireRole(config, 'reviewer')] };
  const tags = ['admin'];
  const security = [{ operatorToken: [] }];

  /** Businesses by name, searchable by name, trading name, owner email, or id. Paged. */
  r.get(
    '/admin/businesses',
    {
      ...reviewer,
      schema: {
        tags,
        security,
        querystring: OperatorBusinessListQuery,
        response: { 200: OperatorBusinessList },
      },
    },
    async (request) => listBusinesses(db, request.query),
  );

  /** One business: verification, owners, bank links, leases, applications, hits, alerts. */
  r.get(
    '/admin/businesses/:id',
    {
      ...reviewer,
      schema: { tags, security, params: Params, response: { 200: OperatorBusinessDetail } },
    },
    async (request) => businessDetail(db, request.params.id),
  );

  /** Every plan of a business with its payouts, installments, and debits. */
  r.get(
    '/admin/businesses/:id/rent-plans',
    {
      ...reviewer,
      schema: { tags, security, params: Params, response: { 200: z.array(OperatorRentPlan) } },
    },
    async (request) => businessRentPlans(db, request.params.id, todayIso()),
  );

  /**
   * One application as a reviewer needs it: the engine's recommendation, score factors,
   * integrity flags, referral triggers, fee build-up, cash flow, decision history, reviews,
   * identity, open screening hits, and the audit trail.
   */
  r.get(
    '/admin/applications/:id',
    {
      ...reviewer,
      schema: { tags, security, params: Params, response: { 200: OperatorApplicationDetail } },
    },
    async (request) => applicationDetail(db, request.params.id, todayIso()),
  );

  /**
   * A business's data connections as an operator sees them: method, trust tier, health, what
   * the platform or bank reported about the account, the snapshots (time, hash, counts), and
   * the latest veracity assessment with every finding and its evidence. No token, ever.
   */
  r.get(
    '/admin/businesses/:id/connections',
    {
      ...reviewer,
      schema: { tags, security, params: Params, response: { 200: OperatorConnections } },
    },
    async (request) => {
      const business = await db.business.findUnique({ where: { id: request.params.id } });
      if (!business) throw notFound('Business');
      return operatorConnections(db, business.id);
    },
  );

  /** The same, with the veracity assessment of this application's current decision. */
  r.get(
    '/admin/applications/:id/connections',
    {
      ...reviewer,
      schema: { tags, security, params: Params, response: { 200: OperatorConnections } },
    },
    async (request) => {
      const application = await db.underwritingApplication.findUnique({
        where: { id: request.params.id },
      });
      if (!application) throw notFound('Application');
      return operatorConnections(db, application.businessId, application.id);
    },
  );

  /** Audit events across every subject, newest first, with filters. Paged. */
  r.get(
    '/admin/audit-log',
    {
      ...reviewer,
      schema: { tags, security, querystring: AuditLogQuery, response: { 200: AuditLogPage } },
    },
    async (request) => auditLog(db, request.query),
  );

  /** The live book: delinquency, pool, concentration against caps, first payment defaults. */
  r.get(
    '/admin/portfolio',
    { ...reviewer, schema: { tags, security, response: { 200: OperatorPortfolio } } },
    async () => portfolioView(db, providers, todayIso()),
  );

  /**
   * Scheduled jobs: each job's latest run and whether it is healthy, late, or failing (the
   * measure `books.job_stale` uses), and the most recent runs of every job.
   */
  r.get(
    '/admin/jobs',
    {
      ...reviewer,
      schema: { tags, security, querystring: OperatorJobsQuery, response: { 200: OperatorJobs } },
    },
    async (request) => jobsView(db, todayIso(), JOB_NAMES, request.query.limit),
  );

  /**
   * The plans behind `/admin/delinquency`: every plan with anything past due or out of the
   * current bucket, with days past due, the amount, and held payouts.
   */
  r.get(
    '/admin/delinquency/plans',
    { ...reviewer, schema: { tags, security, response: { 200: OperatorLatePlans } } },
    async () => latePlansView(db, todayIso()),
  );

  /** The credit, servicing, controls, and monitoring numbers in force. Staff only. */
  r.get(
    '/admin/policy',
    { ...reviewer, schema: { tags, security, response: { 200: OperatorPolicy } } },
    async () => policyView(),
  );

  /** Gate results of the last checked in portfolio evaluation. Simulation, not the book. */
  r.get(
    '/admin/policy/evaluation',
    { ...reviewer, schema: { tags, security, response: { 200: OperatorEvaluation } } },
    async () => evaluationView(),
  );
}

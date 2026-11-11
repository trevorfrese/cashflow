import {
  Cents,
  Id,
  IsoDateSchema,
  IsoDateTimeSchema,
  LedgerAccount,
  RecordReviewRequest,
  RecordReviewResponse,
  ReviewQueueItem,
  TrialBalance,
} from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { todayIso } from '../dates.ts';
import { runAllJobs } from '../jobs/index.ts';
import { trialBalance } from '../ledger/service.ts';
import { toApplication, toReview } from '../serializers.ts';
import { listReviewQueue, recordReview } from '../services/reviews.ts';

/**
 * Operator routes for local development and demos. Mounted only when ENABLE_ADMIN=true.
 * They are not authenticated: do not enable them on a public deployment.
 */
export async function adminRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, providers } = app.ctx;

  r.post(
    '/admin/jobs/run',
    {
      schema: {
        tags: ['admin'],
        body: z.object({ asOf: IsoDateSchema.optional() }).nullish(),
        response: { 200: z.object({ asOf: z.string() }).passthrough() },
      },
    },
    async (request) => runAllJobs(app.ctx, request.body?.asOf ?? todayIso()),
  );

  r.get(
    '/admin/ledger/trial-balance',
    { schema: { tags: ['admin'], response: { 200: TrialBalance } } },
    async () => trialBalance(db),
  );

  r.get(
    '/admin/ledger/accounts',
    { schema: { tags: ['admin'], response: { 200: z.array(LedgerAccount) } } },
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
      schema: {
        tags: ['admin'],
        response: { 200: z.object({ provider: z.string(), availableCents: z.number().int() }) },
      },
    },
    async () => ({
      provider: providers.capital.name,
      availableCents: await providers.capital.availableCents(db),
    }),
  );

  r.post(
    '/admin/capital/fund',
    {
      schema: {
        tags: ['admin'],
        body: z.object({
          amountCents: Cents.refine((v) => v > 0),
          description: z.string().max(200).optional(),
        }),
        response: { 200: z.object({ availableCents: z.number().int() }) },
      },
    },
    async (request) => {
      await db.$transaction(async (tx) => {
        await providers.capital.fund(
          tx,
          request.body.amountCents,
          request.body.description ?? 'Manual funding',
        );
      });
      return { availableCents: await providers.capital.availableCents(db) };
    },
  );

  /**
   * The review queue: applications the engine referred, oldest first, with the engine's
   * recommendation, the referral triggers, and the integrity flags. This is the only route
   * that exposes those internals, and it is an operator route.
   */
  r.get(
    '/admin/reviews',
    { schema: { tags: ['admin'], response: { 200: z.array(ReviewQueueItem) } } },
    async () => listReviewQueue(db),
  );

  /**
   * Record a reviewer's decision on a referred application, or reconsider a declined one.
   * Produces a new current decision; the engine's stays in the history. A review that
   * differs from the engine's recommendation is an override and needs reason codes.
   *
   * The reviewer's identity comes from the request body until admin authentication exists.
   */
  r.post(
    '/admin/applications/:id/review',
    {
      schema: {
        tags: ['admin'],
        params: z.object({ id: Id }),
        body: RecordReviewRequest,
        response: { 200: RecordReviewResponse },
      },
    },
    async (request) => {
      const { review, application } = await recordReview(db, {
        applicationId: request.params.id,
        ...request.body,
      });
      return { review: toReview(review), application: toApplication(application) };
    },
  );

  /** The audit trail for one record, oldest first. */
  r.get(
    '/admin/audit-events',
    {
      schema: {
        tags: ['admin'],
        querystring: z.object({
          subjectType: z.enum(['application', 'rent_plan', 'business']),
          subjectId: Id,
        }),
        response: {
          200: z.array(
            z.object({
              id: Id,
              at: IsoDateTimeSchema,
              actorType: z.string(),
              actorId: z.string().nullable(),
              eventType: z.string(),
              subjectType: z.string(),
              subjectId: z.string(),
              payload: z.record(z.string(), z.unknown()),
            }),
          ),
        },
      },
    },
    async (request) => {
      const rows = await db.auditEvent.findMany({
        where: { subjectType: request.query.subjectType, subjectId: request.query.subjectId },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
      });
      return rows.map((e) => ({
        id: e.id,
        at: e.at.toISOString(),
        actorType: e.actorType,
        actorId: e.actorId,
        eventType: e.eventType,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        payload: (e.payload ?? {}) as Record<string, unknown>,
      }));
    },
  );
}

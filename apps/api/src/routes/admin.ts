import { Cents, IsoDateSchema, LedgerAccount, TrialBalance } from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { todayIso } from '../dates.ts';
import { runAllJobs } from '../jobs/index.ts';
import { trialBalance } from '../ledger/service.ts';

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
}

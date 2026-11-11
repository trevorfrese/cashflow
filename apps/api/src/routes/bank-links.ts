import { BankLink, CreateBankLinkRequest, Id } from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { unprocessable } from '../errors.ts';
import { toBankLink } from '../serializers.ts';
import { connectBank } from '../services/connections.ts';
import { currentUserId, getOwnedBusiness } from './helpers.ts';

export async function bankLinkRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, providers } = app.ctx;

  r.post(
    '/bank-links/link-token',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['bank-links'],
        body: z.object({ businessId: Id }),
        response: { 200: z.object({ linkToken: z.string(), provider: z.string() }) },
      },
    },
    async (request) => {
      await getOwnedBusiness(db, request.body.businessId, currentUserId(request));
      const { linkToken } = await providers.bankLink.createLinkToken(request.body.businessId);
      return { linkToken, provider: providers.bankLink.name };
    },
  );

  r.post(
    '/bank-links',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['bank-links'], body: CreateBankLinkRequest, response: { 201: BankLink } },
    },
    async (request, reply) => {
      await getOwnedBusiness(db, request.body.businessId, currentUserId(request));
      let row;
      try {
        row = await connectBank(
          { db, providers },
          {
            businessId: request.body.businessId,
            publicToken: request.body.publicToken,
            actor: { type: 'user', id: currentUserId(request) },
          },
        );
      } catch (err) {
        throw unprocessable(
          'BANK_LINK_FAILED',
          err instanceof Error ? err.message : 'Bank link failed',
        );
      }
      return reply.code(201).send(toBankLink(row));
    },
  );

  r.get(
    '/businesses/:id/bank-links',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['bank-links'],
        params: z.object({ id: Id }),
        response: { 200: z.array(BankLink) },
      },
    },
    async (request) => {
      await getOwnedBusiness(db, request.params.id, currentUserId(request));
      const rows = await db.bankLink.findMany({
        where: { businessId: request.params.id },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toBankLink);
    },
  );
}

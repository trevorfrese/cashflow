import { BankLink, CreateBankLinkRequest, Id } from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { unprocessable } from '../errors.ts';
import { toBankLink } from '../serializers.ts';
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
      let linked;
      try {
        linked = await providers.bankLink.exchangePublicToken(request.body.publicToken);
      } catch (err) {
        throw unprocessable(
          'BANK_LINK_FAILED',
          err instanceof Error ? err.message : 'Bank link failed',
        );
      }
      const row = await db.bankLink.create({
        data: {
          businessId: request.body.businessId,
          provider: providers.bankLink.name,
          providerItemId: linked.providerItemId,
          providerAccountToken: linked.providerAccountToken,
          institutionName: linked.institutionName,
          accountMask: linked.accountMask,
          availableBalanceCents: linked.availableBalanceCents,
          status: 'LINKED',
        },
      });
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

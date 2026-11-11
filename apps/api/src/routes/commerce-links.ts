import { CommerceLink, CommercePlatform, CreateCommerceLinkRequest, Id } from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { unprocessable } from '../errors.ts';
import { toCommerceLink } from '../serializers.ts';
import { connectCommerceWithToken } from '../services/connections.ts';
import { currentUserId, getOwnedBusiness } from './helpers.ts';

/** Point of sale and commerce platform connections. Read only data for underwriting. */
export async function commerceLinkRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, providers } = app.ctx;

  r.post(
    '/commerce-links/link-token',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['commerce-links'],
        body: z.object({ businessId: Id, platform: CommercePlatform }),
        response: { 200: z.object({ linkToken: z.string(), provider: z.string() }) },
      },
    },
    async (request) => {
      await getOwnedBusiness(db, request.body.businessId, currentUserId(request));
      const { linkToken } = await providers.commerce.createLinkToken(
        request.body.businessId,
        request.body.platform,
      );
      return { linkToken, provider: providers.commerce.nameFor(request.body.platform) };
    },
  );

  r.post(
    '/commerce-links',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['commerce-links'],
        body: CreateCommerceLinkRequest,
        response: { 201: CommerceLink },
      },
    },
    async (request, reply) => {
      await getOwnedBusiness(db, request.body.businessId, currentUserId(request));
      let row;
      try {
        row = await connectCommerceWithToken(
          { db, providers },
          {
            businessId: request.body.businessId,
            platform: request.body.platform,
            publicToken: request.body.publicToken,
            actor: { type: 'user', id: currentUserId(request) },
          },
        );
      } catch (err) {
        throw unprocessable(
          'COMMERCE_LINK_FAILED',
          err instanceof Error ? err.message : 'Commerce link failed',
        );
      }
      return reply.code(201).send(toCommerceLink(row));
    },
  );

  r.get(
    '/businesses/:id/commerce-links',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['commerce-links'],
        params: z.object({ id: Id }),
        response: { 200: z.array(CommerceLink) },
      },
    },
    async (request) => {
      await getOwnedBusiness(db, request.params.id, currentUserId(request));
      const rows = await db.commerceLink.findMany({
        where: { businessId: request.params.id },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toCommerceLink);
    },
  );
}

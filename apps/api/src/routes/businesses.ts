import { Business, CreateBusinessRequest, Id, UpdateBusinessRequest } from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { toBusiness } from '../serializers.ts';
import { currentUserId, getOwnedBusiness } from './helpers.ts';

const Params = z.object({ id: Id });

export async function businessRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.ctx;

  r.post(
    '/businesses',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['businesses'], body: CreateBusinessRequest, response: { 201: Business } },
    },
    async (request, reply) => {
      const b = request.body;
      const business = await db.business.create({
        data: {
          ownerUserId: currentUserId(request),
          legalName: b.legalName,
          dba: b.dba ?? null,
          industry: b.industry,
          addressLine1: b.address.line1,
          addressLine2: b.address.line2 ?? null,
          city: b.address.city,
          state: b.address.state,
          postalCode: b.address.postalCode,
          foundedOn: b.foundedOn,
          statedMonthlyRevenueCents: b.statedMonthlyRevenueCents,
        },
      });
      return reply.code(201).send(toBusiness(business));
    },
  );

  r.get(
    '/businesses',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['businesses'], response: { 200: z.array(Business) } },
    },
    async (request) => {
      const rows = await db.business.findMany({
        where: { ownerUserId: currentUserId(request) },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(toBusiness);
    },
  );

  r.get(
    '/businesses/:id',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['businesses'], params: Params, response: { 200: Business } },
    },
    async (request) =>
      toBusiness(await getOwnedBusiness(db, request.params.id, currentUserId(request))),
  );

  r.patch(
    '/businesses/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['businesses'],
        params: Params,
        body: UpdateBusinessRequest,
        response: { 200: Business },
      },
    },
    async (request) => {
      await getOwnedBusiness(db, request.params.id, currentUserId(request));
      const b = request.body;
      const business = await db.business.update({
        where: { id: request.params.id },
        data: {
          legalName: b.legalName,
          dba: b.dba,
          industry: b.industry,
          addressLine1: b.address?.line1,
          addressLine2: b.address?.line2,
          city: b.address?.city,
          state: b.address?.state,
          postalCode: b.address?.postalCode,
          foundedOn: b.foundedOn,
          statedMonthlyRevenueCents: b.statedMonthlyRevenueCents,
        },
      });
      return toBusiness(business);
    },
  );
}

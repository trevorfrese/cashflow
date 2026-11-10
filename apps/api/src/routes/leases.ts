import { CreateLeaseRequest, Id, Lease, UpdateLeaseRequest } from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { forbidden, notFound } from '../errors.ts';
import { toLease } from '../serializers.ts';
import { currentUserId, getOwnedBusiness } from './helpers.ts';

const Params = z.object({ id: Id });

export async function leaseRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.ctx;

  const loadOwned = async (id: string, userId: string) => {
    const lease = await db.lease.findUnique({ where: { id }, include: { business: true } });
    if (!lease) throw notFound('Lease');
    if (lease.business.ownerUserId !== userId) throw forbidden();
    return lease;
  };

  r.post(
    '/leases',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['leases'], body: CreateLeaseRequest, response: { 201: Lease } },
    },
    async (request, reply) => {
      const b = request.body;
      await getOwnedBusiness(db, b.businessId, currentUserId(request));
      const lease = await db.lease.create({
        data: {
          businessId: b.businessId,
          landlordName: b.landlordName,
          landlordEmail: b.landlordEmail,
          propertyLine1: b.propertyAddress.line1,
          propertyLine2: b.propertyAddress.line2 ?? null,
          propertyCity: b.propertyAddress.city,
          propertyState: b.propertyAddress.state,
          propertyPostalCode: b.propertyAddress.postalCode,
          monthlyRentCents: b.monthlyRentCents,
          dueDayOfMonth: b.dueDayOfMonth,
          startsOn: b.startsOn,
          endsOn: b.endsOn ?? null,
          landlordAccountHolderName: b.landlordPayout.accountHolderName,
          landlordRoutingNumber: b.landlordPayout.routingNumber,
          landlordAccountNumberLast4: b.landlordPayout.accountNumberLast4,
          landlordPayoutToken: b.landlordPayout.providerToken,
        },
      });
      return reply.code(201).send(toLease(lease));
    },
  );

  r.get(
    '/businesses/:id/leases',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['leases'], params: Params, response: { 200: z.array(Lease) } },
    },
    async (request) => {
      await getOwnedBusiness(db, request.params.id, currentUserId(request));
      const rows = await db.lease.findMany({
        where: { businessId: request.params.id },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toLease);
    },
  );

  r.get(
    '/leases/:id',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['leases'], params: Params, response: { 200: Lease } },
    },
    async (request) => toLease(await loadOwned(request.params.id, currentUserId(request))),
  );

  r.patch(
    '/leases/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['leases'],
        params: Params,
        body: UpdateLeaseRequest,
        response: { 200: Lease },
      },
    },
    async (request) => {
      await loadOwned(request.params.id, currentUserId(request));
      const b = request.body;
      const lease = await db.lease.update({
        where: { id: request.params.id },
        data: {
          landlordName: b.landlordName,
          landlordEmail: b.landlordEmail,
          propertyLine1: b.propertyAddress?.line1,
          propertyLine2: b.propertyAddress?.line2,
          propertyCity: b.propertyAddress?.city,
          propertyState: b.propertyAddress?.state,
          propertyPostalCode: b.propertyAddress?.postalCode,
          monthlyRentCents: b.monthlyRentCents,
          dueDayOfMonth: b.dueDayOfMonth,
          startsOn: b.startsOn,
          endsOn: b.endsOn,
          landlordAccountHolderName: b.landlordPayout?.accountHolderName,
          landlordRoutingNumber: b.landlordPayout?.routingNumber,
          landlordAccountNumberLast4: b.landlordPayout?.accountNumberLast4,
          landlordPayoutToken: b.landlordPayout?.providerToken,
        },
      });
      return toLease(lease);
    },
  );
}

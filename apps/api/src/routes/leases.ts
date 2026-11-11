import { CreateLeaseRequest, Id, Lease, UpdateLeaseRequest } from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Db } from '../db.ts';
import { forbidden, notFound } from '../errors.ts';
import type { Lease as LeaseRow } from '../generated/prisma/client.ts';
import { toLease } from '../serializers.ts';
import { screenLandlord } from '../services/identity.ts';
import { cancelLeaseChange, updateLease } from '../services/lease-changes.ts';
import { currentUserId, getOwnedBusiness } from './helpers.ts';

const Params = z.object({ id: Id });

/** Leases as their owner sees them: with any pending landlord change or rent increase. */
async function present(db: Db, leases: LeaseRow[]) {
  if (leases.length === 0) return [];
  const ids = leases.map((l) => l.id);
  const [changes, plans] = await Promise.all([
    db.leaseChange.findMany({ where: { leaseId: { in: ids }, status: 'PENDING' } }),
    db.rentPlan.findMany({
      where: { leaseId: { in: ids }, status: { not: 'CLOSED' }, pendingRentCents: { not: null } },
      select: { id: true, leaseId: true, monthlyRentCents: true, pendingRentCents: true },
    }),
  ]);
  return leases.map((lease) =>
    toLease(lease, {
      pendingChange: changes.find((c) => c.leaseId === lease.id) ?? null,
      pendingRentPlan: plans.find((p) => p.leaseId === lease.id) ?? null,
    }),
  );
}

export async function leaseRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.ctx;

  const loadOwned = async (id: string, userId: string) => {
    const lease = await db.lease.findUnique({ where: { id }, include: { business: true } });
    if (!lease) throw notFound('Lease');
    if (lease.business.ownerUserId !== userId) throw forbidden();
    return lease;
  };

  /** Link a lease. The landlord is screened as the payee before the response. */
  r.post(
    '/leases',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['leases'], body: CreateLeaseRequest, response: { 201: Lease } },
    },
    async (request, reply) => {
      const b = request.body;
      const userId = currentUserId(request);
      await getOwnedBusiness(db, b.businessId, userId);
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
      await screenLandlord(app.ctx, lease, { actor: { type: 'user', id: userId } });
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
      return present(db, rows);
    },
  );

  r.get(
    '/leases/:id',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['leases'], params: Params, response: { 200: Lease } },
    },
    async (request) => {
      const lease = await loadOwned(request.params.id, currentUserId(request));
      return (await present(db, [lease]))[0]!;
    },
  );

  /**
   * Edit a lease. Property and date fields apply at once. On a lease with a running plan, a
   * change to the landlord or the payout account does not: it comes back as
   * `pendingChange`, takes effect after the cooling-off period, and holds rent payments to
   * the landlord until then. A rent change moves the plan from the next period, unless it is
   * an increase past the approval, which comes back as `pendingRentIncrease`. See
   * `services/lease-changes.ts`.
   */
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
      const result = await updateLease(app.ctx, {
        leaseId: request.params.id,
        userId: currentUserId(request),
        body: request.body,
      });
      return (await present(db, [result.lease]))[0]!;
    },
  );

  /** Cancel a pending landlord or payout change. Payouts held by it go out on the next run. */
  r.post(
    '/leases/:id/pending-change/cancel',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['leases'], params: Params, response: { 200: Lease } },
    },
    async (request) => {
      const lease = await cancelLeaseChange(db, {
        leaseId: request.params.id,
        userId: currentUserId(request),
      });
      return (await present(db, [lease]))[0]!;
    },
  );
}

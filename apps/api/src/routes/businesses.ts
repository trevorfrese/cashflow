import {
  Business,
  CreateBusinessRequest,
  Id,
  UpdateBusinessRequest,
  type BeneficialOwnerInput,
} from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Db, Tx } from '../db.ts';
import { toBusiness } from '../serializers.ts';
import { OPEN_HIT, runBusinessIdentity } from '../services/identity.ts';
import { currentUserId, getOwnedBusiness } from './helpers.ts';

const Params = z.object({ id: Id });

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Make the stored owners match the list given. An owner whose name is unchanged keeps its
 * row, and so its screening history; one that is gone is removed; a new one is added. A
 * screening hit on a removed owner stays open in the screening queue: taking a flagged
 * person off the list does not clear them.
 */
async function replaceOwners(tx: Tx, businessId: string, owners: BeneficialOwnerInput[]) {
  const existing = await tx.beneficialOwner.findMany({ where: { businessId } });
  const kept = new Set<string>();
  for (const owner of owners) {
    const match = existing.find((e) => !kept.has(e.id) && sameName(e.fullName, owner.fullName));
    if (match) {
      kept.add(match.id);
      await tx.beneficialOwner.update({
        where: { id: match.id },
        data: { fullName: owner.fullName, title: owner.title, ownershipBps: owner.ownershipBps },
      });
    } else {
      await tx.beneficialOwner.create({ data: { businessId, ...owner } });
    }
  }
  const removed = existing.filter((e) => !kept.has(e.id)).map((e) => e.id);
  if (removed.length > 0) {
    await tx.beneficialOwner.deleteMany({ where: { id: { in: removed } } });
  }
}

/** Businesses with their owners and the count of open screening hits, as the owner sees them. */
async function present(db: Db, where: { id: string } | { ownerUserId: string }) {
  const rows = await db.business.findMany({
    where,
    include: { owners: { orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return [];
  const hits = await db.screeningResult.groupBy({
    by: ['businessId'],
    where: { ...OPEN_HIT, leaseChangeId: null, businessId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const open = new Map(hits.map((h) => [h.businessId, h._count._all]));
  return rows.map((row) => toBusiness(row, open.get(row.id) ?? 0));
}

export async function businessRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.ctx;

  /**
   * Create a business with its tax id (last four digits only) and at least one owner. The
   * business and its owners are verified and screened before the response, so the
   * `verification` the owner sees is already the real one.
   */
  r.post(
    '/businesses',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['businesses'], body: CreateBusinessRequest, response: { 201: Business } },
    },
    async (request, reply) => {
      const b = request.body;
      const userId = currentUserId(request);
      const business = await db.business.create({
        data: {
          ownerUserId: userId,
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
          taxIdLast4: b.taxIdLast4,
          owners: { create: b.owners },
        },
      });
      await runBusinessIdentity(app.ctx, business.id, { actor: { type: 'user', id: userId } });
      const [dto] = await present(db, { id: business.id });
      return reply.code(201).send(dto!);
    },
  );

  r.get(
    '/businesses',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['businesses'], response: { 200: z.array(Business) } },
    },
    async (request) => present(db, { ownerUserId: currentUserId(request) }),
  );

  r.get(
    '/businesses/:id',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['businesses'], params: Params, response: { 200: Business } },
    },
    async (request) => {
      await getOwnedBusiness(db, request.params.id, currentUserId(request));
      const [dto] = await present(db, { id: request.params.id });
      return dto!;
    },
  );

  /**
   * Update a business. A change to anything identity is checked on (legal or trade name,
   * address, tax id, formation date, owners) sends the business back through verification
   * and screening.
   */
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
      const userId = currentUserId(request);
      await getOwnedBusiness(db, request.params.id, userId);
      const b = request.body;
      await db.$transaction(async (tx) => {
        await tx.business.update({
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
            taxIdLast4: b.taxIdLast4,
          },
        });
        if (b.owners) await replaceOwners(tx, request.params.id, b.owners);
      });
      const identityChanged =
        b.legalName !== undefined ||
        b.dba !== undefined ||
        b.address !== undefined ||
        b.taxIdLast4 !== undefined ||
        b.foundedOn !== undefined ||
        b.owners !== undefined;
      if (identityChanged) {
        await runBusinessIdentity(app.ctx, request.params.id, {
          actor: { type: 'user', id: userId },
        });
      }
      const [dto] = await present(db, { id: request.params.id });
      return dto!;
    },
  );
}

import type { FastifyRequest } from 'fastify';

import type { Tx } from '../db.ts';
import { forbidden, notFound } from '../errors.ts';

export function currentUserId(request: FastifyRequest): string {
  return request.user.sub;
}

/** Loads a business and checks the caller owns it. */
export async function getOwnedBusiness(tx: Tx, businessId: string, userId: string) {
  const business = await tx.business.findUnique({ where: { id: businessId } });
  if (!business) throw notFound('Business');
  if (business.ownerUserId !== userId) throw forbidden();
  return business;
}

/** Loads a rent plan and checks the caller owns its business. */
export async function getOwnedRentPlan(tx: Tx, planId: string, userId: string) {
  const plan = await tx.rentPlan.findUnique({ where: { id: planId }, include: { business: true } });
  if (!plan) throw notFound('Rent plan');
  if (plan.business.ownerUserId !== userId) throw forbidden();
  return plan;
}

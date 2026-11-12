import type {
  GraduationOffer as GraduationOfferDto,
  PassThroughPeriod as PassThroughPeriodDto,
} from '@cashflow/shared';

import type { Tx } from '../db.ts';
import { toGraduationOffer, toPassThroughPeriod } from '../serializers.ts';

/**
 * Read views over pass-through plans for the owner's routes and the ops console. Kept apart
 * from the services so that the serializers can depend on the services and not the other
 * way round.
 */

/** The newest graduation offer of a business that is still open (offered or accepted). */
export async function openGraduationOffer(
  tx: Tx,
  businessId: string,
): Promise<GraduationOfferDto | null> {
  const offer = await tx.graduationOffer.findFirst({
    where: { businessId, status: { in: ['OFFERED', 'ACCEPTED'] } },
    orderBy: { createdAt: 'desc' },
    include: { passThroughPlan: { select: { monthlyRentCents: true } } },
  });
  return offer ? toGraduationOffer(offer, offer.passThroughPlan.monthlyRentCents) : null;
}

/** Every graduation offer of a business, newest first. */
export async function graduationOffers(tx: Tx, businessId: string): Promise<GraduationOfferDto[]> {
  const offers = await tx.graduationOffer.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    include: { passThroughPlan: { select: { monthlyRentCents: true } } },
  });
  return offers.map((o) => toGraduationOffer(o, o.passThroughPlan.monthlyRentCents));
}

/** The months of a pass-through plan, oldest first, and the next one not yet paid. */
export async function passThroughDetail(
  tx: Tx,
  planId: string,
  landlordName: string,
): Promise<{ nextPeriod: PassThroughPeriodDto | null; periods: PassThroughPeriodDto[] }> {
  const rows = await tx.passThroughPeriod.findMany({
    where: { rentPlanId: planId },
    orderBy: { dueDate: 'asc' },
  });
  const periods = rows.map((p) => toPassThroughPeriod(p, landlordName));
  const nextPeriod =
    periods.find(
      (p) => p.status === 'SCHEDULED' || p.status === 'COLLECTING' || p.status === 'SETTLED',
    ) ?? null;
  return { nextPeriod, periods };
}

/** The open offer on one pass-through plan, if any. */
export async function planGraduationOffer(
  tx: Tx,
  planId: string,
  monthlyRentCents: number,
): Promise<GraduationOfferDto | null> {
  const offer = await tx.graduationOffer.findFirst({
    where: { passThroughPlanId: planId, status: { in: ['OFFERED', 'ACCEPTED'] } },
    orderBy: { createdAt: 'desc' },
  });
  return offer ? toGraduationOffer(offer, monthlyRentCents) : null;
}

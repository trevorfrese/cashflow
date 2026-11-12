import {
  AcceptGraduationOfferRequest,
  GraduationOffer,
  Id,
  PassThroughOffer,
  PaymentHistory,
  RentPlan,
  StartPassThroughPlanRequest,
} from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { todayIso } from '../dates.ts';
import { forbidden, notFound } from '../errors.ts';
import { toGraduationOffer, toRentPlan } from '../serializers.ts';
import { acceptGraduationOffer } from '../services/graduation.ts';
import { passThroughOffer, startPassThroughPlan } from '../services/pass-through.ts';
import { openGraduationOffer } from '../services/pass-through-views.ts';
import { paymentHistoryView } from '../services/payment-history.ts';
import { currentUserId, getOwnedBusiness } from './helpers.ts';

const Params = z.object({ id: Id });

/**
 * The free pass-through plan, payment history, and graduation to a financed plan.
 * See `src/services/pass-through.ts` and `src/services/graduation.ts`.
 */
export async function passThroughRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.ctx;

  /** The pass-through offer on an application: available or not, and what it means. */
  r.get(
    '/underwriting/applications/:id/pass-through',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['pass-through'], params: Params, response: { 200: PassThroughOffer } },
    },
    async (request) => {
      const application = await db.underwritingApplication.findUnique({
        where: { id: request.params.id },
        include: { business: true },
      });
      if (!application) throw notFound('Application');
      if (application.business.ownerUserId !== currentUserId(request)) throw forbidden();
      return passThroughOffer(db, application.id);
    },
  );

  /** Start a pass-through plan on a lease, for a declined application that is offered one. */
  r.post(
    '/pass-through-plans',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['pass-through'],
        body: StartPassThroughPlanRequest,
        response: { 201: RentPlan },
      },
    },
    async (request, reply) => {
      const plan = await startPassThroughPlan(app.ctx, {
        userId: currentUserId(request),
        applicationId: request.body.applicationId,
        leaseId: request.body.leaseId,
        asOf: todayIso(),
      });
      return reply.code(201).send(toRentPlan(plan));
    },
  );

  /** Every month of rent through CashFlow, on either kind of plan. Derived on read. */
  r.get(
    '/businesses/:id/payment-history',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['pass-through'], params: Params, response: { 200: PaymentHistory } },
    },
    async (request) => {
      await getOwnedBusiness(db, request.params.id, currentUserId(request));
      const offer = await openGraduationOffer(db, request.params.id);
      return paymentHistoryView(db, request.params.id, todayIso(), offer);
    },
  );

  /**
   * Accept an offer to move from the pass-through plan to a financed plan. The financed plan
   * opens once the pass-through month in flight is done, from the next month.
   */
  r.post(
    '/graduation-offers/:id/accept',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['pass-through'],
        params: Params,
        body: AcceptGraduationOfferRequest,
        response: { 200: GraduationOffer },
      },
    },
    async (request) => {
      const { offer } = await acceptGraduationOffer(app.ctx, {
        offerId: request.params.id,
        userId: currentUserId(request),
        ...(request.body.installmentsPerMonth
          ? { installmentsPerMonth: request.body.installmentsPerMonth }
          : {}),
        asOf: todayIso(),
      });
      const plan = await db.rentPlan.findUniqueOrThrow({ where: { id: offer.passThroughPlanId } });
      return toGraduationOffer(offer, plan.monthlyRentCents);
    },
  );
}

import {
  CreateRentPlanRequest,
  Id,
  Installment,
  LandlordPayout,
  PayInstallmentRequest,
  RentPlan,
  RentPlanDetail,
  Repayment,
  UpdateRentPlanRequest,
} from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { todayIso } from '../dates.ts';
import { forbidden, notFound, unprocessable } from '../errors.ts';
import { toInstallment, toPayout, toRentPlan, toRepayment } from '../serializers.ts';
import { collectInstallment } from '../services/collections.ts';
import { createRentPlan } from '../services/rent-plan.ts';
import { currentUserId, getOwnedBusiness, getOwnedRentPlan } from './helpers.ts';

const Params = z.object({ id: Id });

export async function rentPlanRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = app.ctx;

  r.post(
    '/rent-plans',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['rent-plans'], body: CreateRentPlanRequest, response: { 201: RentPlan } },
    },
    async (request, reply) => {
      const plan = await createRentPlan(db, {
        userId: currentUserId(request),
        leaseId: request.body.leaseId,
        applicationId: request.body.applicationId,
        installmentsPerMonth: request.body.installmentsPerMonth,
        asOf: todayIso(),
      });
      return reply.code(201).send(toRentPlan(plan));
    },
  );

  r.get(
    '/businesses/:id/rent-plans',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['rent-plans'], params: Params, response: { 200: z.array(RentPlan) } },
    },
    async (request) => {
      await getOwnedBusiness(db, request.params.id, currentUserId(request));
      const rows = await db.rentPlan.findMany({
        where: { businessId: request.params.id },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toRentPlan);
    },
  );

  r.get(
    '/rent-plans/:id',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['rent-plans'], params: Params, response: { 200: RentPlanDetail } },
    },
    async (request) => {
      const plan = await getOwnedRentPlan(db, request.params.id, currentUserId(request));
      const today = todayIso();
      const [installments, payouts] = await Promise.all([
        db.installment.findMany({
          where: { rentPlanId: plan.id },
          orderBy: [{ dueDate: 'asc' }, { sequence: 'asc' }],
        }),
        db.landlordPayout.findMany({
          where: { rentPlanId: plan.id },
          orderBy: { scheduledFor: 'asc' },
        }),
      ]);
      const upcoming = installments.filter((i) => i.status !== 'PAID');
      const nextInstallment = upcoming[0] ?? null;
      const nextPayout =
        payouts.find((p) => p.status !== 'PAID' && p.scheduledFor >= today) ?? null;
      return {
        ...toRentPlan(plan),
        nextInstallment: nextInstallment ? toInstallment(nextInstallment) : null,
        nextPayout: nextPayout ? toPayout(nextPayout) : null,
        upcomingInstallments: upcoming.map(toInstallment),
        payouts: payouts.map(toPayout),
      };
    },
  );

  /** Change the repayment cadence or pause and resume the plan. Closed plans are final. */
  r.patch(
    '/rent-plans/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['rent-plans'],
        params: Params,
        body: UpdateRentPlanRequest,
        response: { 200: RentPlan },
      },
    },
    async (request) => {
      const plan = await getOwnedRentPlan(db, request.params.id, currentUserId(request));
      if (plan.status === 'CLOSED') throw unprocessable('PLAN_CLOSED', 'This plan is closed');
      const updated = await db.rentPlan.update({
        where: { id: plan.id },
        data: {
          installmentsPerMonth: request.body.installmentsPerMonth,
          status: request.body.status,
        },
      });
      return toRentPlan(updated);
    },
  );

  r.get(
    '/rent-plans/:id/installments',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['rent-plans'], params: Params, response: { 200: z.array(Installment) } },
    },
    async (request) => {
      const plan = await getOwnedRentPlan(db, request.params.id, currentUserId(request));
      const rows = await db.installment.findMany({
        where: { rentPlanId: plan.id },
        orderBy: [{ dueDate: 'asc' }, { sequence: 'asc' }],
      });
      return rows.map(toInstallment);
    },
  );

  r.get(
    '/rent-plans/:id/payouts',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['rent-plans'], params: Params, response: { 200: z.array(LandlordPayout) } },
    },
    async (request) => {
      const plan = await getOwnedRentPlan(db, request.params.id, currentUserId(request));
      const rows = await db.landlordPayout.findMany({
        where: { rentPlanId: plan.id },
        orderBy: { scheduledFor: 'asc' },
      });
      return rows.map(toPayout);
    },
  );

  /** Payment history: every collection attempt, newest first. */
  r.get(
    '/rent-plans/:id/repayments',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['rent-plans'], params: Params, response: { 200: z.array(Repayment) } },
    },
    async (request) => {
      const plan = await getOwnedRentPlan(db, request.params.id, currentUserId(request));
      const rows = await db.repayment.findMany({
        where: { installment: { rentPlanId: plan.id } },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toRepayment);
    },
  );

  /** Pay an installment now, ahead of its due date or to retry a failed one. */
  r.post(
    '/repayments',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['rent-plans'], body: PayInstallmentRequest, response: { 200: Installment } },
    },
    async (request) => {
      const installment = await db.installment.findUnique({
        where: { id: request.body.installmentId },
        include: { rentPlan: { include: { business: true } }, payout: true },
      });
      if (!installment) throw notFound('Installment');
      if (installment.rentPlan.business.ownerUserId !== currentUserId(request)) throw forbidden();
      if (installment.status === 'PAID')
        throw unprocessable('ALREADY_PAID', 'This installment is already paid');
      if (installment.payout.status !== 'PAID') {
        throw unprocessable('PAYOUT_PENDING', 'The landlord has not been paid for this period yet');
      }
      const outcome = await collectInstallment(app.ctx, installment.id, todayIso(), {
        allowEarly: true,
      });
      const updated = await db.installment.findUniqueOrThrow({ where: { id: installment.id } });
      if (outcome !== 'paid') {
        const last = await db.repayment.findFirst({
          where: { installmentId: installment.id },
          orderBy: { createdAt: 'desc' },
        });
        throw unprocessable(
          'PAYMENT_FAILED',
          last?.failureReason ?? 'Payment failed',
          toInstallment(updated),
        );
      }
      return toInstallment(updated);
    },
  );
}

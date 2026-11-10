import { CreateApplicationRequest, Id, UnderwritingApplication } from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { forbidden, notFound, unprocessable } from '../errors.ts';
import { toApplication } from '../serializers.ts';
import { underwriteApplication } from '../services/underwriting.ts';
import { currentUserId, getOwnedBusiness } from './helpers.ts';

const Params = z.object({ id: Id });

export async function underwritingRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, providers } = app.ctx;

  const loadOwned = async (id: string, userId: string) => {
    const application = await db.underwritingApplication.findUnique({
      where: { id },
      include: { decision: true, business: true, bankLink: true },
    });
    if (!application) throw notFound('Application');
    if (application.business.ownerUserId !== userId) throw forbidden();
    return application;
  };

  r.post(
    '/underwriting/applications',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['underwriting'],
        body: CreateApplicationRequest,
        response: { 201: UnderwritingApplication },
      },
    },
    async (request, reply) => {
      const userId = currentUserId(request);
      await getOwnedBusiness(db, request.body.businessId, userId);
      if (request.body.bankLinkId) {
        const link = await db.bankLink.findUnique({ where: { id: request.body.bankLinkId } });
        if (!link || link.businessId !== request.body.businessId) {
          throw unprocessable('BANK_LINK_INVALID', 'Bank link does not belong to this business');
        }
      }
      const application = await db.underwritingApplication.create({
        data: {
          businessId: request.body.businessId,
          bankLinkId: request.body.bankLinkId ?? null,
          statedMonthlyRevenueCents: request.body.statedMonthlyRevenueCents,
          timeInBusinessMonths: request.body.timeInBusinessMonths,
          requestedMonthlyRentCents: request.body.requestedMonthlyRentCents,
        },
        include: { decision: true },
      });
      return reply.code(201).send(toApplication(application));
    },
  );

  /** Runs underwriting. Can be called again after NEEDS_INFO once a bank link is attached. */
  r.post(
    '/underwriting/applications/:id/submit',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['underwriting'],
        params: Params,
        body: z.object({ bankLinkId: Id.optional() }).nullish(),
        response: { 200: UnderwritingApplication },
      },
    },
    async (request) => {
      const application = await loadOwned(request.params.id, currentUserId(request));
      if (application.status === 'APPROVED' || application.status === 'DECLINED') {
        throw unprocessable(
          'APPLICATION_FINAL',
          `Application is already ${application.status.toLowerCase()}`,
        );
      }

      let bankLink = application.bankLink;
      const requestedLinkId = request.body?.bankLinkId;
      if (requestedLinkId) {
        const link = await db.bankLink.findUnique({ where: { id: requestedLinkId } });
        if (!link || link.businessId !== application.businessId) {
          throw unprocessable('BANK_LINK_INVALID', 'Bank link does not belong to this business');
        }
        bankLink = link;
      }
      if (!bankLink) {
        // Fall back to the business's most recent linked account.
        bankLink = await db.bankLink.findFirst({
          where: { businessId: application.businessId, status: 'LINKED' },
          orderBy: { createdAt: 'desc' },
        });
      }

      const updated = await underwriteApplication({
        db,
        providers,
        applicationId: application.id,
        bankLink,
      });
      return toApplication(updated);
    },
  );

  r.get(
    '/underwriting/applications/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['underwriting'],
        params: Params,
        response: { 200: UnderwritingApplication },
      },
    },
    async (request) => toApplication(await loadOwned(request.params.id, currentUserId(request))),
  );

  r.get(
    '/businesses/:id/applications',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['underwriting'],
        params: Params,
        response: { 200: z.array(UnderwritingApplication) },
      },
    },
    async (request) => {
      await getOwnedBusiness(db, request.params.id, currentUserId(request));
      const rows = await db.underwritingApplication.findMany({
        where: { businessId: request.params.id },
        include: { decision: true },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(toApplication);
    },
  );
}

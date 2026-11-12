import {
  AdverseActionNoticeView,
  CreateApplicationRequest,
  DecisionExplanation,
  Id,
  UnderwritingApplication,
} from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { forbidden, notFound, unprocessable } from '../errors.ts';
import { toApplication } from '../serializers.ts';
import {
  declineCounterOffer,
  noticesForApplication,
  toNoticeView,
} from '../services/adverse-action.ts';
import { INCLUDE_CURRENT_DECISION, withCurrentDecision } from '../services/decisions.ts';
import { buildExplanation } from '../services/explanation.ts';
import { underwriteApplication } from '../services/underwriting.ts';
import { currentUserId, getOwnedBusiness } from './helpers.ts';

const Params = z.object({ id: Id });

export async function underwritingRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, providers } = app.ctx;

  const loadOwned = async (id: string, userId: string) => {
    const application = await db.underwritingApplication.findUnique({
      where: { id },
      include: { ...INCLUDE_CURRENT_DECISION, business: true, bankLink: true, commerceLink: true },
    });
    if (!application) throw notFound('Application');
    if (application.business.ownerUserId !== userId) throw forbidden();
    return withCurrentDecision(application);
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
      if (request.body.commerceLinkId) {
        const link = await db.commerceLink.findUnique({
          where: { id: request.body.commerceLinkId },
        });
        if (!link || link.businessId !== request.body.businessId) {
          throw unprocessable(
            'COMMERCE_LINK_INVALID',
            'Commerce link does not belong to this business',
          );
        }
      }
      const application = await db.underwritingApplication.create({
        data: {
          businessId: request.body.businessId,
          bankLinkId: request.body.bankLinkId ?? null,
          commerceLinkId: request.body.commerceLinkId ?? null,
          statedMonthlyRevenueCents: request.body.statedMonthlyRevenueCents,
          timeInBusinessMonths: request.body.timeInBusinessMonths,
          requestedMonthlyRentCents: request.body.requestedMonthlyRentCents,
        },
      });
      return reply.code(201).send(toApplication({ ...application, decision: null }));
    },
  );

  /**
   * Runs underwriting. Can be called again after NEEDS_INFO once a bank or POS link is
   * attached: each run adds a decision and supersedes the one before it. Clean applications
   * are decided in this request. A referred one comes back IN_REVIEW.
   */
  r.post(
    '/underwriting/applications/:id/submit',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['underwriting'],
        params: Params,
        body: z.object({ bankLinkId: Id.optional(), commerceLinkId: Id.optional() }).nullish(),
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
      if (application.status === 'IN_REVIEW') {
        throw unprocessable(
          'APPLICATION_IN_REVIEW',
          'Application is with a reviewer. We will be in touch if anything more is needed',
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

      let commerceLink = application.commerceLink;
      const requestedCommerceId = request.body?.commerceLinkId;
      if (requestedCommerceId) {
        const link = await db.commerceLink.findUnique({ where: { id: requestedCommerceId } });
        if (!link || link.businessId !== application.businessId) {
          throw unprocessable(
            'COMMERCE_LINK_INVALID',
            'Commerce link does not belong to this business',
          );
        }
        commerceLink = link;
      }
      if (!commerceLink) {
        commerceLink = await db.commerceLink.findFirst({
          where: { businessId: application.businessId, status: 'LINKED' },
          orderBy: { createdAt: 'desc' },
        });
      }

      const updated = await underwriteApplication({
        db,
        providers,
        applicationId: application.id,
        bankLink,
        commerceLink,
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

  /**
   * Why the applicant got this decision: principal reasons with what would change them,
   * factor statuses, the rules that ran, the data read, and the terms. The score only on an
   * approval or a counter offer. See `services/explanation.ts`.
   */
  r.get(
    '/underwriting/applications/:id/explanation',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['underwriting'],
        params: Params,
        response: { 200: DecisionExplanation },
      },
    },
    async (request) => {
      const application = await loadOwned(request.params.id, currentUserId(request));
      const notices = await noticesForApplication(db, application.id);
      return buildExplanation(application, application.decision, notices);
    },
  );

  /** Every notice sent on the application, oldest first, exactly as delivered. */
  r.get(
    '/underwriting/applications/:id/notices',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['underwriting'],
        params: Params,
        response: { 200: z.array(AdverseActionNoticeView) },
      },
    },
    async (request) => {
      const application = await loadOwned(request.params.id, currentUserId(request));
      return (await noticesForApplication(db, application.id)).map(toNoticeView);
    },
  );

  /**
   * The owner declines a counter offer. An adverse action notice is stored and delivered at
   * once. Calling it again returns the same notice.
   */
  r.post(
    '/underwriting/applications/:id/decline-offer',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['underwriting'],
        params: Params,
        response: { 200: AdverseActionNoticeView },
      },
    },
    async (request) =>
      toNoticeView(await declineCounterOffer(db, request.params.id, currentUserId(request))),
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
        include: INCLUDE_CURRENT_DECISION,
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((row) => toApplication(withCurrentDecision(row)));
    },
  );
}

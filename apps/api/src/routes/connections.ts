import {
  Connection,
  ConnectionList,
  CreateSeatInvitationRequest,
  Id,
  MockAuthorizeRequest,
  MockAuthorizeResponse,
  OAuthCallbackRequest,
  SeatInvitation,
  StartOAuthRequest,
  StartOAuthResponse,
} from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Db } from '../db.ts';
import { forbidden, notFound } from '../errors.ts';
import {
  completeOAuth,
  createSeatInvitation,
  disconnect,
  mockAuthorize,
  startOAuth,
  verifySeat,
} from '../services/connections.ts';
import { connectionList, latestAssessment, toConnection } from '../services/connection-views.ts';
import { currentUserId, getOwnedBusiness } from './helpers.ts';

const Params = z.object({ id: Id });

/** A connection of either kind, checked against the caller. */
async function ownedConnection(db: Db, id: string, userId: string) {
  const bank = await db.bankLink.findUnique({ where: { id }, include: { business: true } });
  if (bank) {
    if (bank.business.ownerUserId !== userId) throw forbidden();
    return { kind: 'BANK' as const, link: bank };
  }
  const platform = await db.commerceLink.findUnique({ where: { id }, include: { business: true } });
  if (!platform) throw notFound('Connection');
  if (platform.business.ownerUserId !== userId) throw forbidden();
  return { kind: 'COMMERCE' as const, link: platform };
}

/**
 * Data connections with their provenance: start an OAuth connection and complete it, the
 * sandbox approval page, delegated seat invitations and checks, the owner's list, and
 * disconnect. Every route is the business owner's only. No response carries a token.
 */
export async function connectionRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, providers, config } = app.ctx;
  const deps = { db, providers };
  const tags = ['connections'];

  const view = async (id: string, businessId: string) => {
    const latest = await latestAssessment(db, businessId);
    const bank = await db.bankLink.findUnique({ where: { id } });
    if (bank) return toConnection({ ...bank, kind: 'BANK' }, latest?.veracity ?? null);
    const platform = await db.commerceLink.findUniqueOrThrow({ where: { id } });
    return toConnection({ ...platform, kind: 'COMMERCE' }, latest?.veracity ?? null);
  };

  r.get(
    '/businesses/:id/connections',
    {
      preHandler: [app.authenticate],
      schema: { tags, params: Params, response: { 200: ConnectionList } },
    },
    async (request) => {
      await getOwnedBusiness(db, request.params.id, currentUserId(request));
      return connectionList(db, request.params.id);
    },
  );

  r.get(
    '/connections/:id',
    {
      preHandler: [app.authenticate],
      schema: { tags, params: Params, response: { 200: Connection } },
    },
    async (request) => {
      const { link } = await ownedConnection(db, request.params.id, currentUserId(request));
      return view(link.id, link.businessId);
    },
  );

  /** Where to send the owner to approve read-only access. Platforms with an API only. */
  r.post(
    '/connections/oauth/start',
    {
      preHandler: [app.authenticate],
      schema: { tags, body: StartOAuthRequest, response: { 200: StartOAuthResponse } },
    },
    async (request) => {
      const userId = currentUserId(request);
      await getOwnedBusiness(db, request.body.businessId, userId);
      return startOAuth(deps, {
        businessId: request.body.businessId,
        userId,
        platform: request.body.platform,
        redirectUri: request.body.redirectUri ?? config.OAUTH_REDIRECT_URI,
      });
    },
  );

  /**
   * The sandbox platform's consent page. It answers with the redirect a real platform would
   * send, code and state included, so a test or the app can follow it without a browser.
   */
  r.post(
    '/connections/oauth/mock-authorize',
    {
      preHandler: [app.authenticate],
      schema: { tags, body: MockAuthorizeRequest, response: { 200: MockAuthorizeResponse } },
    },
    async (request) =>
      mockAuthorize(deps, {
        state: request.body.state,
        userId: currentUserId(request),
        scenario: request.body.scenario,
        approve: request.body.approve,
      }),
  );

  /** The redirect back from the platform: exchange the code and connect. */
  r.post(
    '/connections/oauth/callback',
    {
      preHandler: [app.authenticate],
      schema: { tags, body: OAuthCallbackRequest, response: { 201: Connection } },
    },
    async (request, reply) => {
      const link = await completeOAuth(deps, {
        state: request.body.state,
        userId: currentUserId(request),
        ...(request.body.code ? { code: request.body.code } : {}),
        ...(request.body.error ? { error: request.body.error } : {}),
      });
      return reply.code(201).send(await view(link.id, link.businessId));
    },
  );

  /** Platforms without an API: how to add CashFlow's own read-only reports user. */
  r.post(
    '/connections/seats',
    {
      preHandler: [app.authenticate],
      schema: { tags, body: CreateSeatInvitationRequest, response: { 201: SeatInvitation } },
    },
    async (request, reply) => {
      const userId = currentUserId(request);
      await getOwnedBusiness(db, request.body.businessId, userId);
      const { link, invitation } = await createSeatInvitation(deps, {
        businessId: request.body.businessId,
        platform: request.body.platform,
        userId,
        ...(request.body.scenario ? { scenario: request.body.scenario } : {}),
      });
      return reply.code(201).send({
        connection: await view(link.id, link.businessId),
        serviceUserEmail: invitation.serviceUserEmail,
        role: invitation.role,
        steps: invitation.steps,
      });
    },
  );

  /** "Check connection": is the seat there, active, and read only. */
  r.post(
    '/connections/:id/verify-seat',
    {
      preHandler: [app.authenticate],
      schema: { tags, params: Params, response: { 200: Connection } },
    },
    async (request) => {
      const userId = currentUserId(request);
      const { link } = await ownedConnection(db, request.params.id, userId);
      await verifySeat(deps, link.id, undefined, { type: 'user', id: userId });
      return view(link.id, link.businessId);
    },
  );

  /** Revoke at the platform and delete the tokens. The snapshots stay, as evidence. */
  r.post(
    '/connections/:id/disconnect',
    {
      preHandler: [app.authenticate],
      schema: { tags, params: Params, response: { 200: Connection } },
    },
    async (request) => {
      const userId = currentUserId(request);
      const { kind, link } = await ownedConnection(db, request.params.id, userId);
      await disconnect(deps, { kind, id: link.id, userId });
      return view(link.id, link.businessId);
    },
  );
}

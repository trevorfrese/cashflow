import {
  ApiError,
  AuthResponse,
  AuthTokens,
  LoginRequest,
  RefreshRequest,
  RegisterRequest,
  User,
} from '@cashflow/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { hashPassword, verifyPassword } from '../auth/password.ts';
import { consumeRefreshToken, hashRefreshToken, issueRefreshToken } from '../auth/tokens.ts';
import { conflict, unauthorized } from '../errors.ts';
import { toUser } from '../serializers.ts';

export async function authRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, config } = app.ctx;

  const tokensFor = async (user: { id: string; email: string }) => {
    const accessToken = app.jwt.sign({ sub: user.id, email: user.email });
    const refreshToken = await issueRefreshToken(db, user.id, config.REFRESH_TOKEN_TTL_DAYS);
    return { accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS };
  };

  r.post(
    '/auth/register',
    {
      schema: {
        tags: ['auth'],
        body: RegisterRequest,
        response: { 201: AuthResponse, 409: ApiError },
      },
    },
    async (request, reply) => {
      const existing = await db.user.findUnique({ where: { email: request.body.email } });
      if (existing) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
      const user = await db.user.create({
        data: {
          email: request.body.email,
          fullName: request.body.fullName,
          passwordHash: await hashPassword(request.body.password),
        },
      });
      return reply.code(201).send({ user: toUser(user), tokens: await tokensFor(user) });
    },
  );

  r.post(
    '/auth/login',
    {
      schema: {
        tags: ['auth'],
        body: LoginRequest,
        response: { 200: AuthResponse, 401: ApiError },
      },
    },
    async (request) => {
      const user = await db.user.findUnique({ where: { email: request.body.email } });
      // Same error for unknown email and bad password so the endpoint does not leak which emails exist.
      if (!user || !(await verifyPassword(request.body.password, user.passwordHash))) {
        throw unauthorized('Incorrect email or password');
      }
      return { user: toUser(user), tokens: await tokensFor(user) };
    },
  );

  r.post(
    '/auth/refresh',
    {
      schema: {
        tags: ['auth'],
        body: RefreshRequest,
        response: { 200: AuthTokens, 401: ApiError },
      },
    },
    async (request) => {
      return db.$transaction(async (tx) => {
        const userId = await consumeRefreshToken(tx, request.body.refreshToken);
        if (!userId) throw unauthorized('Refresh token is invalid or expired');
        const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
        const accessToken = app.jwt.sign({ sub: user.id, email: user.email });
        const refreshToken = await issueRefreshToken(tx, user.id, config.REFRESH_TOKEN_TTL_DAYS);
        return { accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL_SECONDS };
      });
    },
  );

  r.post(
    '/auth/logout',
    { schema: { tags: ['auth'], body: RefreshRequest, response: { 204: z.null() } } },
    async (request, reply) => {
      await db.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(request.body.refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return reply.code(204).send(null);
    },
  );

  r.get(
    '/me',
    {
      preHandler: [app.authenticate],
      schema: { tags: ['auth'], response: { 200: User, 401: ApiError } },
    },
    async (request) => {
      const user = await db.user.findUnique({ where: { id: request.user.sub } });
      if (!user) throw unauthorized();
      return toUser(user);
    },
  );
}

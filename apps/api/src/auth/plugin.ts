import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import type { Config } from '../config.ts';
import { unauthorized } from '../errors.ts';

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { config: Config }) => {
  await app.register(fastifyJwt, {
    secret: opts.config.JWT_SECRET,
    sign: { expiresIn: `${opts.config.ACCESS_TOKEN_TTL_SECONDS}s` },
  });

  app.decorate('authenticate', async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      throw unauthorized('Invalid or expired access token');
    }
  });
});

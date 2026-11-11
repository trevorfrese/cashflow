import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

import { authPlugin } from './auth/plugin.ts';
import type { Config } from './config.ts';
import type { AppContext } from './context.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { ensureSystemAccounts } from './ledger/accounts.ts';
import type { Providers } from './providers/index.ts';
import { adminConsoleRoutes } from './routes/admin-console.ts';
import { adminRoutes } from './routes/admin.ts';
import { authRoutes } from './routes/auth.ts';
import { bankLinkRoutes } from './routes/bank-links.ts';
import { businessRoutes } from './routes/businesses.ts';
import { commerceLinkRoutes } from './routes/commerce-links.ts';
import { healthRoutes } from './routes/health.ts';
import { leaseRoutes } from './routes/leases.ts';
import { rentPlanRoutes } from './routes/rent-plans.ts';
import { underwritingRoutes } from './routes/underwriting.ts';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

export interface BuildAppOptions {
  config: Config;
  db: Db;
  providers: Providers;
  logger?: boolean | object;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      opts.logger ??
      (opts.config.NODE_ENV === 'development'
        ? {
            level: opts.config.LOG_LEVEL,
            transport: { target: 'pino-pretty', options: { colorize: true } },
          }
        : { level: opts.config.LOG_LEVEL }),
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('ctx', {
    config: opts.config,
    db: opts.db,
    providers: opts.providers,
    log: app.log,
  });

  await app.register(cors, {
    origin:
      opts.config.CORS_ORIGIN === '*'
        ? true
        : opts.config.CORS_ORIGIN.split(',').map((s) => s.trim()),
  });

  // A default for every route, with tighter limits on the auth routes (see routes/auth.ts).
  // Counted per client address, in memory: one process. Several instances behind a load
  // balancer each count on their own, and would want a shared store.
  if (opts.config.RATE_LIMIT_ENABLED) {
    await app.register(rateLimit, {
      global: true,
      max: opts.config.RATE_LIMIT_MAX,
      timeWindow: opts.config.RATE_LIMIT_WINDOW_SECONDS * 1000,
      allowList: (request) => request.url === '/health',
      errorResponseBuilder: (_request, context) =>
        new AppError(429, 'RATE_LIMITED', `Too many requests. Try again in ${context.after}`),
    });
  }

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'CashFlow API',
        description: 'Buy now, pay later for small business rent. Mock money only.',
        version: '0.1.0',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          // Operator routes: ADMIN_API_TOKEN or REVIEWER_API_TOKEN, plus X-Admin-Actor.
          operatorToken: { type: 'http', scheme: 'bearer' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(authPlugin, { config: opts.config });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request failed validation',
          details: error.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        },
      });
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response failed schema');
      return reply
        .code(500)
        .send({ error: { code: 'RESPONSE_SCHEMA', message: 'Response did not match schema' } });
    }
    const e = error as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 ? e.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled error');
    const message =
      status >= 500
        ? 'Internal error'
        : typeof e.message === 'string'
          ? e.message
          : 'Request error';
    return reply.code(status).send({
      error: { code: status >= 500 ? 'INTERNAL' : 'REQUEST_ERROR', message },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    }),
  );

  await app.register(healthRoutes);
  await app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(businessRoutes);
      await v1.register(bankLinkRoutes);
      await v1.register(commerceLinkRoutes);
      await v1.register(underwritingRoutes);
      await v1.register(leaseRoutes);
      await v1.register(rentPlanRoutes);
      if (opts.config.ENABLE_ADMIN) {
        await v1.register(adminRoutes);
        await v1.register(adminConsoleRoutes);
      }
    },
    { prefix: '/v1' },
  );

  app.addHook('onReady', async () => {
    await ensureSystemAccounts(opts.db);
  });

  return app;
}

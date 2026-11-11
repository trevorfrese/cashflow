import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ZodTypeProvider } from 'fastify-type-provider-zod';

export async function healthRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: {
        tags: ['health'],
        response: {
          200: z.object({ ok: z.boolean(), providers: z.record(z.string(), z.string()) }),
        },
      },
    },
    async () => {
      await app.ctx.db.$queryRaw`SELECT 1`;
      const p = app.ctx.providers;
      return {
        ok: true,
        providers: {
          underwriting: p.underwriting.name,
          bankLink: p.bankLink.name,
          commerce: p.commerce.name,
          payments: p.payments.name,
          capital: p.capital.name,
          identity: p.identity.name,
        },
      };
    },
  );
}

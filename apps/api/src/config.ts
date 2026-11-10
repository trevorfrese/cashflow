import { z } from 'zod';

const Bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  CORS_ORIGIN: z.string().default('*'),

  UNDERWRITING_PROVIDER: z.enum(['mock']).default('mock'),
  BANK_LINK_PROVIDER: z.enum(['mock', 'plaid']).default('mock'),
  PAYMENTS_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  CAPITAL_PROVIDER: z.enum(['mock']).default('mock'),

  JOBS_ENABLED: Bool.default(false),
  JOBS_CRON: z.string().default('0 * * * *'),

  ENABLE_ADMIN: Bool.default(false),

  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_ENV: z.enum(['sandbox', 'development', 'production']).default('sandbox'),
  STRIPE_SECRET_KEY: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  const config = parsed.data;

  // Safety rails. A production build must never run with a live key by accident.
  if (config.NODE_ENV === 'production') {
    if (config.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
      throw new Error(
        'Refusing to start: STRIPE_SECRET_KEY is a live key. This project never moves real money.',
      );
    }
    if (config.PLAID_ENV === 'production') {
      throw new Error(
        'Refusing to start: PLAID_ENV=production. This project only runs against sandbox data.',
      );
    }
  }
  return config;
}

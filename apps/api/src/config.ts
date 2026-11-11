import { z } from 'zod';

const Bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

/** Shortest operator token accepted. 32 characters of a random token is over 128 bits. */
export const MIN_ADMIN_TOKEN_LENGTH = 32;

const OptionalToken = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
  .refine((v) => v === undefined || v.length >= MIN_ADMIN_TOKEN_LENGTH, {
    message: `must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters. Generate one with: openssl rand -hex 32`,
  });

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

  UNDERWRITING_PROVIDER: z.enum(['cashflow', 'mock']).default('cashflow'),
  BANK_LINK_PROVIDER: z.enum(['mock', 'plaid']).default('mock'),
  COMMERCE_PROVIDER: z.enum(['mock', 'square']).default('mock'),
  PAYMENTS_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  CAPITAL_PROVIDER: z.enum(['mock']).default('mock'),
  IDENTITY_PROVIDER: z.enum(['mock']).default('mock'),

  JOBS_ENABLED: Bool.default(false),
  JOBS_CRON: z.string().default('0 * * * *'),

  ENABLE_ADMIN: Bool.default(false),
  /**
   * Bearer tokens for the operator routes. `ADMIN_API_TOKEN` can do everything;
   * `REVIEWER_API_TOKEN` can work the queues and read the book. An empty value is unset.
   */
  ADMIN_API_TOKEN: OptionalToken,
  REVIEWER_API_TOKEN: OptionalToken,

  /** Request rate limiting. Off under test so the suites stay fast and deterministic. */
  RATE_LIMIT_ENABLED: Bool.default(true),
  /** Requests per client address per window, across all routes. */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /** The same for register, login and refresh, which are counted on their own. */
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  /** Failed sign ins in a row before an account is locked. 0 turns lockout off. */
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(0).default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  PLAID_ENV: z.enum(['sandbox', 'development', 'production']).default('sandbox'),
  STRIPE_SECRET_KEY: z.string().optional(),
  SQUARE_APPLICATION_ID: z.string().optional(),
  SQUARE_APPLICATION_SECRET: z.string().optional(),
  SQUARE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  const config = parsed.data;

  // Operator routes are never open. Enabling them without an admin token is a refusal to
  // start, not a warning, so a deployment cannot expose them by forgetting a variable.
  if (config.ENABLE_ADMIN && !config.ADMIN_API_TOKEN) {
    throw new Error(
      'Refusing to start: ENABLE_ADMIN=true needs ADMIN_API_TOKEN. Generate one with: openssl rand -hex 32',
    );
  }
  if (config.ADMIN_API_TOKEN && config.ADMIN_API_TOKEN === config.REVIEWER_API_TOKEN) {
    throw new Error(
      'Refusing to start: ADMIN_API_TOKEN and REVIEWER_API_TOKEN must be different tokens.',
    );
  }

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
    if (config.SQUARE_ENV === 'production') {
      throw new Error(
        'Refusing to start: SQUARE_ENV=production. This project only reads sandbox sales data.',
      );
    }
  }
  return config;
}

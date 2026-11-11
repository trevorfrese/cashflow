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
  /**
   * Point of sale and commerce platforms. `mock` serves every platform from the sandbox. A
   * platform name puts that platform on its real adapter (a compile-only skeleton that refuses
   * to run without its credentials) and leaves the others on the sandbox.
   */
  COMMERCE_PROVIDER: z.enum(['mock', 'square', 'shopify', 'stripe', 'clover']).default('mock'),
  /** Platforms without an API (Toast): a read-only seat for CashFlow's own service user. */
  DELEGATED_SEAT_PROVIDER: z.enum(['mock', 'toast']).default('mock'),
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

  /**
   * Dev tools under /v1/dev: sign in as a persona without a password, move the simulated
   * clock, rebuild demo data. Off unless the local .env turns it on, and never in
   * production: see the refusal in `loadConfig`. With it off the routes are not registered.
   */
  ENABLE_DEV_TOOLS: Bool.default(false),

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
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  STRIPE_CONNECT_CLIENT_ID: z.string().optional(),
  CLOVER_APP_ID: z.string().optional(),
  CLOVER_APP_SECRET: z.string().optional(),
  CLOVER_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  /** CashFlow's own Toast service user, and where its credentials live (a secret store ref). */
  TOAST_SEAT_SERVICE_USER: z.string().optional(),
  TOAST_SEAT_CREDENTIALS_REF: z.string().optional(),
  /**
   * Key for encrypting platform and aggregator tokens at rest (AES-256-GCM, HKDF derived). The
   * mocks work without it on a public sandbox key; every real adapter refuses to start
   * without it. Generate with: openssl rand -hex 32
   */
  CONNECTION_TOKEN_KEY: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .refine((v) => v === undefined || v.length >= 32, {
      message: 'must be at least 32 characters. Generate one with: openssl rand -hex 32',
    }),
  /** Where platforms redirect the owner after approving access. */
  OAUTH_REDIRECT_URI: z.string().default('http://localhost:8099/connect/callback'),
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

  // A real data adapter receives platform tokens, which are encrypted at rest. The sandbox key
  // is public, so a real adapter without a key of its own is a refusal to start.
  const realAdapters = [
    config.BANK_LINK_PROVIDER !== 'mock' ? `BANK_LINK_PROVIDER=${config.BANK_LINK_PROVIDER}` : null,
    config.COMMERCE_PROVIDER !== 'mock' ? `COMMERCE_PROVIDER=${config.COMMERCE_PROVIDER}` : null,
    config.DELEGATED_SEAT_PROVIDER !== 'mock'
      ? `DELEGATED_SEAT_PROVIDER=${config.DELEGATED_SEAT_PROVIDER}`
      : null,
  ].filter((v): v is string => v !== null);
  if (realAdapters.length > 0 && !config.CONNECTION_TOKEN_KEY) {
    throw new Error(
      `Refusing to start: ${realAdapters.join(', ')} needs CONNECTION_TOKEN_KEY to encrypt the tokens it receives. Generate one with: openssl rand -hex 32`,
    );
  }

  // Safety rails. A production build must never run with a live key by accident.
  if (config.NODE_ENV === 'production') {
    // Dev tools hand out sessions without a password and can wipe the database.
    if (config.ENABLE_DEV_TOOLS) {
      throw new Error(
        'Refusing to start: ENABLE_DEV_TOOLS=true with NODE_ENV=production. Dev tools impersonate users, reset data and move the clock. They only run in local development.',
      );
    }
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
    if (config.CLOVER_ENV === 'production') {
      throw new Error(
        'Refusing to start: CLOVER_ENV=production. This project only reads sandbox sales data.',
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

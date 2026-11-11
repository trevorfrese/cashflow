/**
 * Server-side configuration of the console, read from the environment on every request so
 * a test can pass its own. Nothing here is ever sent to the browser.
 */
export interface OpsEnv {
  /** Base URL of the CashFlow API, without a trailing slash. */
  apiUrl: string;
  /** Secret the session cookie is encrypted with. Null when unset or too short. */
  sessionSecret: string | null;
  /** Extra origins allowed to make state-changing requests. Usually empty. */
  allowedOrigins: string[];
}

export const DEFAULT_API_URL = 'http://localhost:4000';
export const MIN_SECRET_LENGTH = 32;

export function loadEnv(env: Record<string, string | undefined> = process.env): OpsEnv {
  const secret = env.OPS_SESSION_SECRET?.trim() ?? '';
  return {
    apiUrl: (env.CASHFLOW_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, ''),
    sessionSecret: secret.length >= MIN_SECRET_LENGTH ? secret : null,
    allowedOrigins: (env.OPS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter((o) => o.length > 0),
  };
}

import type { z } from 'zod';
import { ApiError as ApiErrorSchema, AuthTokens } from '@cashflow/shared';

import { storage } from './storage';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);

const ACCESS_KEY = 'cashflow.accessToken';
const REFRESH_KEY = 'cashflow.refreshToken';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type Tokens = z.infer<typeof AuthTokens>;

/** In memory copy of the tokens so every request does not hit the keychain. */
let cached: Tokens | null | undefined;
let onSessionExpired: (() => void) | null = null;

export const tokenStore = {
  async load(): Promise<Tokens | null> {
    if (cached !== undefined) return cached;
    const [accessToken, refreshToken] = await Promise.all([
      storage.get(ACCESS_KEY),
      storage.get(REFRESH_KEY),
    ]);
    cached = accessToken && refreshToken ? { accessToken, refreshToken, expiresIn: 0 } : null;
    return cached;
  },
  async save(tokens: Tokens): Promise<void> {
    cached = tokens;
    await Promise.all([
      storage.set(ACCESS_KEY, tokens.accessToken),
      storage.set(REFRESH_KEY, tokens.refreshToken),
    ]);
  },
  async clear(): Promise<void> {
    cached = null;
    await Promise.all([storage.remove(ACCESS_KEY), storage.remove(REFRESH_KEY)]);
  },
  /** Called when a refresh fails so the auth provider can sign the user out. */
  setSessionExpiredHandler(handler: (() => void) | null) {
    onSessionExpired = handler;
  },
};

type RequestOptions<T> = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Zod schema used to validate the response body. Omit for 204 responses. */
  schema?: z.ZodType<T>;
  /** Attach the bearer token. Defaults to true. */
  auth?: boolean;
};

async function parseError(res: Response): Promise<ApiError> {
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // Non JSON error body. Fall through to the status text.
  }
  const parsed = ApiErrorSchema.safeParse(payload);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(res.status, code, message, details);
  }
  return new ApiError(res.status, 'HTTP_ERROR', res.statusText || `Request failed (${res.status})`);
}

let refreshing: Promise<Tokens | null> | null = null;

/** Exchange the refresh token for a new pair. Concurrent callers share one refresh. */
async function refreshTokens(): Promise<Tokens | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const current = await tokenStore.load();
    if (!current) return null;
    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    });
    if (!res.ok) {
      await tokenStore.clear();
      onSessionExpired?.();
      return null;
    }
    const tokens = AuthTokens.parse(await res.json());
    await tokenStore.save(tokens);
    return tokens;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * Typed fetch wrapper. Validates responses with the shared Zod schema, attaches the access
 * token, and transparently refreshes it once on a 401.
 */
export async function api<T = void>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const { method = 'GET', body, schema, auth = true } = options;

  const send = async (accessToken: string | null) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    return fetch(`${API_URL}/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  let tokens = auth ? await tokenStore.load() : null;
  let res = await send(tokens?.accessToken ?? null);

  if (res.status === 401 && auth && tokens) {
    tokens = await refreshTokens();
    if (tokens) res = await send(tokens.accessToken);
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204 || !schema) return undefined as T;
  return schema.parse(await res.json());
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) {
    return `Could not reach the API at ${API_URL}. Is it running?`;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

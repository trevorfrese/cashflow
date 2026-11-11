import type { ZodType } from 'zod';

/**
 * The browser's only way to the API: the console's own `/api/admin/...` routes. The session
 * cookie rides along on its own (same origin, httpOnly), and the server attaches the bearer
 * token. This module never sees a token and has nowhere to keep one.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** A response body as an `ApiError`. Tolerates anything, including a body that is not JSON. */
export function toApiError(status: number, body: unknown): ApiError {
  const error = (
    body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null
  )?.error;
  return new ApiError(
    status,
    typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED',
    typeof error?.message === 'string' ? error.message : `The request failed (status ${status}).`,
    error?.details,
  );
}

/** `{ status: 'OPEN', severity: undefined }` is `?status=OPEN`. Empty values are left out. */
export function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

interface CallOptions<T> {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** The shared Zod schema the response must match. */
  schema: ZodType<T>;
  signal?: AbortSignal;
}

/**
 * Call the API through the proxy and validate the answer against its shared schema. A 401
 * means the session is gone, so the browser is sent to sign in.
 */
export async function call<T>(path: string, options: CallOptions<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/admin/${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers:
        options.method === 'POST'
          ? { 'content-type': 'application/json', accept: 'application/json' }
          : { accept: 'application/json' },
      body: options.method === 'POST' ? JSON.stringify(options.body ?? {}) : undefined,
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK', 'The console server did not answer. Is it still running?');
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.status === 401) {
    if (typeof window !== 'undefined') window.location.assign('/sign-in?expired=1');
    throw toApiError(401, body);
  }
  if (!response.ok) throw toApiError(response.status, body);
  const parsed = options.schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      'UNEXPECTED_SHAPE',
      'The API answered in a shape the console did not expect. The console and the API may be on different versions.',
      parsed.error.issues.slice(0, 5),
    );
  }
  return parsed.data;
}

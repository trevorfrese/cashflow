import { requestHost } from './session';

/**
 * Cross-site request forgery protection for the cookie-authenticated routes.
 *
 * Two layers. The session cookie is SameSite=Strict, so a browser does not attach it to a
 * request another site started. And every state-changing request must prove where it came
 * from: its `Origin` header has to name the host the request was sent to (or an origin
 * listed in OPS_ALLOWED_ORIGINS). A browser always sends `Origin` on a cross-origin POST
 * and a page cannot forge it. When `Origin` is absent, `Sec-Fetch-Site: same-origin` is
 * accepted, which browsers set themselves. A request with neither is refused, so a tool
 * like curl has to state an origin on purpose.
 */
export function isSameOrigin(request: Request, allowedOrigins: readonly string[] = []): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) {
    if (allowedOrigins.includes(origin.replace(/\/+$/, ''))) return true;
    try {
      return new URL(origin).host.toLowerCase() === requestHost(request).toLowerCase();
    } catch {
      // "null" (a sandboxed frame, a file) or anything that is not a URL.
      return false;
    }
  }
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True when the request may change state and so has to pass the origin check. */
export function needsOriginCheck(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

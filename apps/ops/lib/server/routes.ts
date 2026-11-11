/**
 * The API routes the console may reach through its proxy, and nothing else. A path that is
 * not listed here is not forwarded, whatever the session's role: the console has no button
 * for funding the pool or running jobs, so its proxy has no route for them either.
 *
 * `:id` matches one path segment of letters, digits, `_` and `-`.
 */
export const PROXIED_ROUTES: ReadonlyArray<{ method: 'GET' | 'POST'; path: string }> = [
  // Overview
  { method: 'GET', path: 'monitoring/summary' },
  { method: 'GET', path: 'delinquency' },
  { method: 'GET', path: 'circuit-breaker' },
  { method: 'POST', path: 'circuit-breaker/reset' },
  // Review queue
  { method: 'GET', path: 'reviews' },
  { method: 'GET', path: 'applications/:id' },
  { method: 'GET', path: 'applications/:id/connections' },
  { method: 'POST', path: 'applications/:id/review' },
  // Alerts
  { method: 'GET', path: 'alerts' },
  { method: 'GET', path: 'alerts/:id' },
  { method: 'POST', path: 'alerts/:id/acknowledge' },
  { method: 'POST', path: 'alerts/:id/resolve' },
  // Lease changes
  { method: 'GET', path: 'lease-changes' },
  { method: 'POST', path: 'lease-changes/:id/decide' },
  // Screening
  { method: 'GET', path: 'screening/hits' },
  { method: 'POST', path: 'screening/:id/clear' },
  // Portfolio and policy
  { method: 'GET', path: 'portfolio' },
  { method: 'GET', path: 'policy' },
  { method: 'GET', path: 'policy/evaluation' },
  // Customers
  { method: 'GET', path: 'businesses' },
  { method: 'GET', path: 'businesses/:id' },
  { method: 'GET', path: 'businesses/:id/rent-plans' },
  { method: 'GET', path: 'businesses/:id/connections' },
  { method: 'POST', path: 'rent-plans/:id/release-freeze' },
  { method: 'POST', path: 'payouts/:id/resend' },
  // Audit
  { method: 'GET', path: 'audit-log' },
];

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The upstream path for a console request, or null when the console does not proxy it.
 * Every segment is checked against a strict pattern first, so a segment can never carry a
 * slash, a dot, or an encoded escape into the upstream URL.
 */
export function upstreamPath(method: string, segments: readonly string[]): string | null {
  if (segments.length === 0 || segments.some((s) => !SEGMENT.test(s))) return null;
  const wanted = method.toUpperCase();
  for (const route of PROXIED_ROUTES) {
    if (route.method !== wanted) continue;
    const pattern = route.path.split('/');
    if (pattern.length !== segments.length) continue;
    if (pattern.every((p, i) => p === ':id' || p === segments[i])) {
      return `/v1/admin/${segments.join('/')}`;
    }
  }
  return null;
}

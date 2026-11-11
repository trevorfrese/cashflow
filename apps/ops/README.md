# @cashflow/ops

The CashFlow operations console: the staff side of the product. Review queue, monitoring alerts, lease changes, screening hits, the live portfolio, customers with their plans and payments, the audit log, and the policy in force.

**Local only.** This app is not deployed anywhere and has no hosting configuration. It runs on a staff machine next to the API, talks only to that API, and tells crawlers to stay away (`noindex` in the page metadata, an `X-Robots-Tag` header, and a `robots.txt` that disallows everything). Like the rest of the repo it is sandbox only: no real money moves.

## Run it

The API has to be running with operator routes on (`ENABLE_ADMIN=true`, `ADMIN_API_TOKEN`, and optionally `REVIEWER_API_TOKEN` in `apps/api/.env`).

```sh
cp apps/ops/.env.example apps/ops/.env.local
# set OPS_SESSION_SECRET in apps/ops/.env.local: openssl rand -hex 32
pnpm dev:ops                          # http://localhost:3200
```

Sign in with your name and an operator token. The role (reviewer or admin) comes from the token. Your name is recorded on everything you do, in the audit log.

| Variable              | Default                 | What it is                                                                          |
| --------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `CASHFLOW_API_URL`    | `http://localhost:4000` | The API the console talks to. The only address it ever calls                        |
| `OPS_SESSION_SECRET`  | none, required          | Encrypts the session cookie. 32 characters or more. Sign in is refused without it   |
| `OPS_ALLOWED_ORIGINS` | empty                   | Extra origins allowed to make state-changing requests, comma separated. Rarely used |

`.env.local` is gitignored. Tokens are never written to a file by the console: they are typed at sign in.

Other commands: `pnpm --filter @cashflow/ops test`, `typecheck`, `lint`, `build`.

## How a request gets to the API

The browser never holds the operator token in anything JavaScript can read.

1. **Sign in.** The form posts the token and your name to `POST /api/session` on the console's own server. The server checks them with the API (`GET /v1/admin/whoami`), which also returns the role.
2. **Session cookie.** The server puts `{ token, actor, role, expiresAt }` in one cookie, encrypted with AES-256-GCM under a key derived (HKDF-SHA256) from `OPS_SESSION_SECRET`. The cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, lasts 12 hours, and is `Secure` unless the host is localhost. It is encrypted and not only signed because the payload is a credential: a signature would stop tampering but leave the token readable to anything that can see the cookie. There is no server-side session store, so a restart does not sign anyone out.
3. **Proxy.** Pages call `/api/admin/<path>`. The route handler opens the cookie, attaches `Authorization: Bearer ...` and `X-Admin-Actor`, and forwards to `/v1/admin/<path>`. Only the routes listed in `lib/server/routes.ts` are forwarded: the console has no button for funding the pool or running jobs, so the proxy has no route for them. Browser cookies and headers are not forwarded, and upstream headers are not passed back.
4. **Sign out.** `DELETE /api/session` clears the cookie. A 401 from the API (a rotated token) clears it too.

**CSRF.** The cookie is `SameSite=Strict`, so a browser does not attach it to a request another site started. On top of that every state-changing request (sign in, sign out, every proxied `POST`) must carry an `Origin` header naming the host the request was sent to, or `Sec-Fetch-Site: same-origin` when there is no `Origin`. A request with neither is refused. Proxied `POST`s must also be JSON.

**Roles.** The role from `whoami` decides what the console offers: a reviewer is not offered the circuit breaker reset or clearing a confirmed match. That is a convenience. The API enforces the role on every request whatever the console shows.

**What the browser can see:** your name, your role, when the session ends, and the API's JSON responses. **What it cannot:** the token, in any response body, header, or readable storage. The console uses no localStorage or sessionStorage.

What this does not do: the token is shared by a team and the name is typed, not proven. Per person credentials (SSO) are what a real deployment needs, as `ARCHITECTURE.md` says of the API. There is no rate limit on the console's own sign in beyond the API's. A Content Security Policy beyond `frame-ancestors 'none'` is not set.

## Pages

| Page              | Reads (through `/api/admin/...`)                           | Actions                                               |
| ----------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `/sign-in`        | `POST /api/session`                                        | Sign in                                               |
| `/` Overview      | `monitoring/summary`, `portfolio`                          | `circuit-breaker/reset` (admin)                       |
| `/reviews`        | `reviews`                                                  |                                                       |
| `/reviews/[id]`   | `applications/:id`                                         | `applications/:id/review`                             |
| `/alerts`         | `alerts`                                                   |                                                       |
| `/alerts/[id]`    | `alerts/:id`                                               | `alerts/:id/acknowledge`, `alerts/:id/resolve`        |
| `/lease-changes`  | `lease-changes`                                            | `lease-changes/:id/decide`                            |
| `/screening`      | `screening/hits`                                           | `screening/:id/clear` (a match: admin)                |
| `/portfolio`      | `portfolio`, `policy/evaluation`                           |                                                       |
| `/customers`      | `businesses`                                               |                                                       |
| `/customers/[id]` | `businesses/:id`, `businesses/:id/rent-plans`, `audit-log` | `rent-plans/:id/release-freeze`, `payouts/:id/resend` |
| `/audit`          | `audit-log`                                                |                                                       |
| `/policy`         | `policy`                                                   |                                                       |

Every page under the console layout is rendered only with a valid session; without one the server redirects to `/sign-in`. The policy page shows what the customer API hides, and is reachable only signed in.

The evaluation gate results on the portfolio page are read by the API from the checked in `apps/api/evals/baseline.json`. They come from a simulated population and are labelled that way on the page.

## Layout

```
app/                      routes: sign-in, the console pages, /api/session, /api/admin/[...path]
components/               Shell, CoinMark, the design system pieces (ui.tsx), shared tables and forms
lib/format.ts             money from cents, percentages from basis points, dates, deadlines
lib/labels.ts             plain words for codes, and what to do about each API refusal
lib/api.ts, use-api.ts    the browser's fetch wrapper: proxy only, validated with the shared Zod schemas
lib/theme.ts              brand tokens from @cashflow/shared as CSS custom properties
lib/server/               session sealing, cookie, origin check, route allowlist, handlers
```

## Design

The product's neo-brutalist system from `packages/shared/src/brand.ts`, set dense for a working tool: Ink text and 3px ink borders on Paper, Canvas wells, gold for brand, Azure for primary actions, hard offset shadows that sink when pressed, Archivo loaded the way the marketing site loads it. `lib/theme.ts` turns the tokens into CSS custom properties, so `app/globals.css` contains no hex values. Severity is always a word and a level meter as well as a color.

`components/CoinMark.tsx` is a copy of `apps/web/components/CoinMark.tsx`, not a shared import: the two apps have no shared component package, and one small SVG did not justify making one.

Dates and times are shown in UTC, because the API's "today" is the UTC date and a due date must not move with the viewer's time zone.

## Tests

Vitest, like the rest of the repo. `lib/format.test.ts` and `lib/labels.test.ts` cover formatting and wording. `lib/server/*.test.ts` cover the session cookie (sealed, set, cleared, attributes), that the token is never in a response, the origin check, and the proxy allowlist, by calling the handlers with web `Request` objects and a fake `fetch`.

There are no component or browser tests.

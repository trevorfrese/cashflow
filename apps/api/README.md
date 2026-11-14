# @cashflow/api

Fastify API for CashFlow. Postgres via Prisma, Zod validation on every route, OpenAPI docs at
`/docs`, the underwriting engine and its veracity checks, the double entry ledger, and thirteen
scheduled jobs that screen parties, apply lease changes, refresh data, re-underwrite, pay
landlords, collect installments, handle returned payments, age and charge off receivables, book
loss provisions, send notices, and monitor the result. Every provider that touches money or
risk is a sandbox by default.

The other API documents: [`CREDIT_POLICY.md`](CREDIT_POLICY.md) (the policy),
[`UNDERWRITING.md`](UNDERWRITING.md) (the mechanics), [`DATA_CONNECTIONS.md`](DATA_CONNECTIONS.md)
(how data is obtained), [`evals/README.md`](evals/README.md) (the portfolio evaluation), and
[`DEPLOY.md`](DEPLOY.md).

## Contents

- [Run it](#run-it), [Commands](#commands), [Environment](#environment), [Layout](#layout)
- [Jobs](#jobs), with the reasons, notices, pass-through and sandbox payment notes
- [Sandbox identity keywords](#sandbox-identity-keywords) and
  [sandbox data connections](#sandbox-data-connections)
- [Owner routes](#owner-routes) and [operator routes](#operator-routes)
- [Dev tools](#dev-tools)
- [Rate limiting and lockout](#rate-limiting-and-lockout)

## Run it

From the repo root, with Docker running:

```sh
./dev --only api                  # from the repo root: Postgres, migrate, seed, http://localhost:4000, docs at /docs
```

Or by hand: `pnpm setup`, then `pnpm --filter @cashflow/api dev`. If port 5432 is taken,
`./dev` picks the next free port and writes it to the root `.env`.

Demo login after seeding: `demo@cashflow.local` / `demo-password-123`. Every seeded persona is
its own login with that password: the 24 personas are defined in `src/dev/personas.ts` and
listed in [`AGENTS.md`](../../AGENTS.md).

`.env.example` has `ENABLE_ADMIN=true` with placeholder operator tokens so a local copy
starts. See "Operator routes" below before the API is reachable by anyone else.

## Commands

```sh
pnpm --filter @cashflow/api dev            # watch mode
pnpm --filter @cashflow/api test           # unit + integration (needs Postgres)
pnpm --filter @cashflow/api test:unit
pnpm --filter @cashflow/api test:int
pnpm --filter @cashflow/api db:migrate     # create / apply a migration in dev
pnpm --filter @cashflow/api db:seed        # reseed demo data
pnpm --filter @cashflow/api db:reset       # drop, migrate, seed
pnpm --filter @cashflow/api db:studio      # Prisma Studio
pnpm --filter @cashflow/api job:run        # run jobs once as of today
pnpm --filter @cashflow/api job:run -- --as-of 2026-12-01
pnpm --filter @cashflow/api job:run -- --only reunderwrite   # one job by name
pnpm --filter @cashflow/api eval:portfolio # portfolio simulation and gates, see evals/README.md
pnpm --filter @cashflow/api eval:calibrate # regenerate the PD table the pricing module reads
```

## Environment

`src/config.ts` parses and checks every variable; `.env.example` lists them with comments, and
`./dev` writes a working `.env` with fresh secrets. The ones that change behavior:

| Variable                                                      | Default         | Meaning                                                                                                   |
| ------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `DATABASE_URL_TEST`                           | none            | Postgres. Integration tests use and wipe the second                                                       |
| `JWT_SECRET`                                                  | none            | Signs access tokens. At least 16 characters                                                               |
| `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_TOKEN_TTL_DAYS`          | 900, 30         | Session lifetimes                                                                                         |
| `*_PROVIDER`                                                  | sandbox         | Which implementation of each provider. See "Provider seams" in [`ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| `CONNECTION_TOKEN_KEY`                                        | unset           | Seals platform and aggregator tokens. Required by every real adapter                                      |
| `JOBS_ENABLED`, `JOBS_CRON`                                   | `false`, hourly | Run the job sequence inside the API process on a cron. Each run acts as of today and is idempotent        |
| `ENABLE_ADMIN`, `ADMIN_API_TOKEN`, `REVIEWER_API_TOKEN`       | `false`         | Operator routes. See "Operator routes"                                                                    |
| `ENABLE_DEV_TOOLS`                                            | `false`         | `/v1/dev`. Refused when `NODE_ENV=production`. See "Dev tools"                                            |
| `RATE_LIMIT_*`, `LOGIN_MAX_FAILURES`, `LOGIN_LOCKOUT_MINUTES` | see below       | See "Rate limiting and lockout"                                                                           |

## Layout

```
prisma/schema.prisma     data model and enums
prisma/seed.ts           demo data: every persona, five months of jobs replayed day by day
src/app.ts               Fastify factory: plugins, error handling, routes
src/index.ts             server entry, starts the scheduler when JOBS_ENABLED=true
src/config.ts            environment parsing and safety rails
src/auth/                scrypt passwords, JWT access tokens, rotating refresh tokens
src/ledger/              double-entry ledger: accounts, validation, posting, trial balance
src/auth/admin.ts        operator tokens, roles, and the X-Admin-Actor identity
src/routes/admin.ts      operator routes: the queues, the actions, the book
src/routes/admin-console.ts  read routes for the operations console (apps/ops)
src/services/operator.ts operator read models: businesses, applications, audit log, portfolio, policy, gates
src/auth/lockout.ts      login lockout after repeated failures
src/providers/           underwriting, bank-link, commerce, delegated-seat, payments, capital,
                         identity (sandboxes + skeletons)
src/underwriting/        the engine: features, integrity checks, scorecard, pricing, exposure,
                         payment history, pass-through eligibility, the policy versions
src/veracity/            data veracity checks: ownership, settlement, completeness, consistency
src/adverse-action/      notice deadlines, rendering, and the date driven schedule
src/crypto/token-vault.ts  sealing platform and aggregator tokens at rest
src/servicing/           servicing and pass-through rules as data and pure functions, shared with the evals
src/controls/policy.ts   cooling-off, rescreen interval, retention, decision deadline
src/monitoring/          rules (pure), data layer, engine, policy with every threshold
src/services/            rent plans, payouts and holds, collections, returns, delinquency,
                         charge-off, provisioning, identity and screening, lease change
                         control, connections and snapshots, reviews, pass-through,
                         graduation, adverse action notices, the circuit breaker
src/evals/               the portfolio simulation and its gates (see evals/README.md)
src/dev/                 personas, builders, the simulated clock, the seed (dev tools only)
src/jobs/                the thirteen jobs below, cron, CLI
src/routes/              HTTP handlers grouped by resource
src/serializers.ts       Prisma rows to API shapes from @cashflow/shared
src/test/                integration test harness
```

## Jobs

`job:run` runs all of them in this order for one date. `--only <name>` runs one. Each is
idempotent for a given date and records a `JobRun`. The reasoning for the order is in
`src/jobs/index.ts`; the rules are in `ARCHITECTURE.md` under "The life of a rent payment".

| Order | Name                     | What it does                                                                                                                     |
| ----: | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
|     1 | `rescreen`               | Screens active businesses, owners and landlords again once their screening is 30 days old                                        |
|     2 | `lease-changes`          | Applies landlord and payout changes whose cooling-off period has ended                                                           |
|     3 | `refresh-connections`    | Refreshes tokens near expiry and pulls businesses with an active plan again weekly                                               |
|     4 | `reunderwrite`           | Monthly review of each active financed plan on fresh data. Freezes a deteriorated or untrusted plan, with a `PLAN_FROZEN` notice |
|     5 | `refresh-eligibility`    | Graduation: expires offers, opens accepted ones, re-underwrites pass-through plans with 3 on time months                         |
|     6 | `reconcile-payments`     | Polls the payments provider for returns and reverses each returned installment, payout or pass-through debit                     |
|     7 | `age-receivables`        | Delinquency bucket per plan, `LATE` marks, audit event on each change, charge-off at 90 days past due                            |
|     8 | `generate-periods`       | Next month's payout and installments, and next month's pass-through month, 30 days ahead                                         |
|     9 | `process-payouts`        | Pays, holds, releases, or cancels each landlord payout that is due; settles and pays pass-through months                         |
|    10 | `collect-installments`   | Scheduled debits (days 0, 3, and 6, after a balance check), the cash sweep, then pass-through collections                        |
|    11 | `provision`              | Sets the allowance for credit losses by bucket. Posts on the first run of each calendar month                                    |
|    12 | `adverse-action-notices` | Notices that fall due on a date: expired counter offers, incomplete applications, any decline without one                        |
|    13 | `monitor`                | Runs every monitoring rule, opens and resolves alerts, trips the circuit breaker on a critical breach                            |

`refresh-eligibility` re-underwrites a pass-through customer at most once a calendar month
(the `ELIGIBILITY_REVIEW` decision is keyed by application and month with a unique index),
reads payment history completed before the review date, and on an approval for at least the
lease rent makes a `GraduationOffer` the owner accepts with
`POST /v1/graduation-offers/:id/accept`. The financed plan opens only between pass-through
months, from the next one. Like every job it runs for each day crossed by `./dev advance`.

Reasons and notices (see `UNDERWRITING.md`, "Reasons and adverse action notices"):
`GET /v1/underwriting/applications/:id/explanation` (why the applicant got the decision:
principal reasons with guidance, factor statuses, checks, data sources, and the score and
terms only on an approval or counter offer), `GET /v1/underwriting/applications/:id/notices`
(every notice sent, with its full text), and `POST /v1/underwriting/applications/:id/decline-offer`
(the owner turns down a counter offer; the adverse action notice is stored at once). A decline's
notice is written with the decision. `adverse-action-notices` sends a notice of incompleteness
10 days after an application starts waiting on information, closes it with a notice 30 days
after that, and sends the notice for a counter offer not taken up within 30 days. A reviewer's
`DECLINE` and `REQUEST_INFO` need `principalReasonCodes` from the reason catalog.

Pass-through routes: `GET /v1/underwriting/applications/:id/pass-through` (the offer on a
declined application), `POST /v1/pass-through-plans` (start one on a lease),
`GET /v1/businesses/:id/payment-history`, and the accept route above. `GET /v1/rent-plans/:id`
returns `kind`, the pass-through months, and any open graduation offer.

To see the unhappy paths in the sandbox, point a bank account or a landlord at a mock
payments keyword. `mock_acct_fail` rejects every debit. `mock_acct_return_r01` accepts a
debit and returns it two days later for insufficient funds; any two digit code works
(`return_r02` is a closed account). `late_return_r10` returns it three weeks later as
unauthorized. Adding `_once` returns only the first payment. A lease whose payout token
contains `return_r03` has its landlord payout sent back. The mock remembers pending returns
for the life of one process, so they show up when the jobs run inside the API server, the
seed, or a test, and not across separate `job:run` invocations.

The seed builds every persona, one business in each state (the table is in
[`AGENTS.md`](../../AGENTS.md), "Personas"). It replays the `monitor` job with the others, so
the open alerts (at least one of each severity) were raised by the rules, not inserted.

## Sandbox identity keywords

`IDENTITY_PROVIDER=mock` verifies every business and owner and screens every name clear,
unless a name carries one of these keywords (case insensitive, anywhere in the name). It is
deterministic, has no network access, and stores nothing.

| Where                                                               | Keyword or value | Result                                                             |
| ------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------ |
| Business legal name or trade name                                   | `unverifiable`   | Verification `FAILED`: the application is declined                 |
| Business legal name or trade name                                   | `mismatch`       | Verification `REVIEW`: the application is referred                 |
| Tax id last 4                                                       | `0000`           | Verification `REVIEW` (tax id mismatch)                            |
| Owner name                                                          | `unverifiable`   | Verification `FAILED`                                              |
| Owner name                                                          | `mismatch`       | Verification `REVIEW`                                              |
| Any screened name: business, owner, landlord, payout account holder | `watchlist`      | Screening `POSSIBLE_MATCH`: referred, and a running plan is frozen |
| Any screened name                                                   | `sanctioned`     | Screening `MATCH`: held in review, only an admin can clear it      |

A business with no tax id or no owners (a row from before verification) comes back `REVIEW`.
Try an owner called "Morgan Watchlist", or a landlord called "Sanctioned Holdings".

## Sandbox data connections

Everything below is the sandbox: deterministic, offline, and nothing is ever sent to a real
platform, aggregator, or bank. How it works and why is in [`DATA_CONNECTIONS.md`](DATA_CONNECTIONS.md);
what each finding does to a decision is in `UNDERWRITING.md`, "Veracity".

**Connecting a point of sale.** Platforms with an API connect by read-only OAuth:

```sh
# 1. Where to send the owner: a state, a PKCE challenge, read-only scopes.
curl -s -X POST localhost:4000/v1/connections/oauth/start -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"businessId":"<id>","platform":"SQUARE"}'
# 2. The sandbox stand-in for the platform's consent page answers with the redirect.
curl -s -X POST localhost:4000/v1/connections/oauth/mock-authorize -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"state":"<state>","scenario":"healthy_sales_48000"}'
# 3. Hand the redirect's code and state back.
curl -s -X POST localhost:4000/v1/connections/oauth/callback -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"state":"<state>","code":"<code>"}'
```

Toast connects through a delegated seat: `POST /v1/connections/seats` returns CashFlow's
service user and the steps, and `POST /v1/connections/:id/verify-seat` checks it.
`GET /v1/businesses/:id/connections` lists every connection with its method, trust tier,
health, what it verified, and what the owner can do; `POST /v1/connections/:id/disconnect`
revokes it. The original sandbox shortcut, `POST /v1/commerce-links` with a token, still works.

**Keywords.** They combine with the scenario keywords (`healthy`, `declining`, `sales_40000`, ...).

| Where                         | Keyword               | What the sandbox reports                                                       |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------------ |
| Bank public token             | `personal`            | A personal account in the first owner's name                                   |
| Bank public token             | `borrowed`            | An account held by another business (Harlow Ventures LLC)                      |
| Bank public token             | `new_account`         | Opened 60 days before it was linked                                            |
| Bank public token             | `hidden`              | Two more accounts on the same login, not shared                                |
| Bank public token             | `legacy`              | Not authorized through the bank's own OAuth                                    |
| Bank public token             | `rewrites`            | Pulls after the link date leave out overdraft fees and debt payments           |
| Bank public token             | `expired`             | Pulls after the link date need the owner to reconnect                          |
| Consent page scenario or seat | `owner_mismatch`      | The platform account is in another business's legal name                       |
| Consent page scenario or seat | `taxid_mismatch`      | The platform reports a tax id ending 9999                                      |
| Consent page scenario or seat | `payout_elsewhere`    | Payouts go to an account that is not connected                                 |
| Consent page scenario or seat | `unsettled`           | Gross sales 80% above what is paid out, for the last 120 days                  |
| Consent page scenario or seat | `new_account`         | The platform account was created 45 days before it was connected               |
| Consent page scenario         | `expired`             | The token cannot be refreshed after the connect date                           |
| Seat scenario                 | `seat_inactive`       | The CashFlow reports user has not been added: the seat stays pending           |
| Seat scenario                 | `seat_layout_changed` | Every report pull fails as a layout change would: the connection goes to ERROR |
| Consent page scenario or seat | `rewrites`            | Pulls after the connect date report higher sales for days that were final      |

The sandbox platform pays out exactly the card deposits of the business's connected sandbox
bank, so the two generators reconcile; sandbox histories are anchored on the day they are
connected and continue from there.

**Environment.**

| Variable                                                                                                                                                                         | Default   | Meaning                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `COMMERCE_PROVIDER`                                                                                                                                                              | `mock`    | `square`, `shopify`, `stripe` or `clover` puts that platform on its compile-only skeleton; the rest stay mock   |
| `DELEGATED_SEAT_PROVIDER`                                                                                                                                                        | `mock`    | `toast` is a skeleton that refuses to run                                                                       |
| `CONNECTION_TOKEN_KEY`                                                                                                                                                           | unset     | Seals tokens at rest. Required by every real adapter; the API refuses to start without it then                  |
| `OAUTH_REDIRECT_URI`                                                                                                                                                             | app route | Where a platform sends the owner back                                                                           |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `STRIPE_CONNECT_CLIENT_ID`, `CLOVER_APP_ID`, `CLOVER_APP_SECRET`, `CLOVER_ENV`, `TOAST_SEAT_SERVICE_USER`, `TOAST_SEAT_CREDENTIALS_REF` | unset     | Credentials the skeletons check for. `TOAST_SEAT_CREDENTIALS_REF` is a secret store reference, never a password |

## Owner routes

Paths below are under `/v1` and need a bearer access token from `/v1/auth/login`, except
register, login, refresh and `/health`. Every body and response is a Zod schema in `packages/shared`;
the full contract is at `/docs`.

| Area           | Routes                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth           | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me`                                                                                                                                                                                                                                                                                                       |
| Businesses     | `POST /businesses`, `GET /businesses`, `GET /businesses/:id`, `PATCH /businesses/:id`                                                                                                                                                                                                                                                                                                                 |
| Bank           | `POST /bank-links/link-token`, `POST /bank-links`, `GET /businesses/:id/bank-links`                                                                                                                                                                                                                                                                                                                   |
| Point of sale  | `POST /connections/oauth/start`, `POST /connections/oauth/mock-authorize` (sandbox), `POST /connections/oauth/callback`, `POST /connections/seats`, `POST /connections/:id/verify-seat`, `POST /connections/:id/disconnect`, `GET /connections/:id`, `GET /businesses/:id/connections`, and the older `POST /commerce-links/link-token`, `POST /commerce-links`, `GET /businesses/:id/commerce-links` |
| Applications   | `POST /underwriting/applications`, `POST /underwriting/applications/:id/submit`, `GET /underwriting/applications/:id`, `GET /underwriting/applications/:id/explanation`, `GET /underwriting/applications/:id/notices`, `POST /underwriting/applications/:id/decline-offer`, `GET /businesses/:id/applications`                                                                                        |
| Leases         | `POST /leases`, `GET /businesses/:id/leases`, `GET /leases/:id`, `PATCH /leases/:id` (returns `pendingChange` and `pendingRentIncrease`), `POST /leases/:id/pending-change/cancel`                                                                                                                                                                                                                    |
| Financed plans | `POST /rent-plans`, `GET /businesses/:id/rent-plans`, `GET /rent-plans/:id`, `PATCH /rent-plans/:id` (pause, resume, close, cadence), `GET /rent-plans/:id/installments`, `GET /rent-plans/:id/payouts`, `GET /rent-plans/:id/repayments`, `POST /repayments` (a manual payment)                                                                                                                      |
| Pass-through   | `GET /underwriting/applications/:id/pass-through`, `POST /pass-through-plans`, `GET /businesses/:id/payment-history`, `POST /graduation-offers/:id/accept`                                                                                                                                                                                                                                            |
| Health         | `GET /health`, at the root rather than under `/v1`, with no token                                                                                                                                                                                                                                                                                                                                     |

## Operator routes

The routes under `/v1/admin` are mounted only with `ENABLE_ADMIN=true`, and the API refuses
to start in that mode without `ADMIN_API_TOKEN`. Every request needs a bearer token and the
name of the person acting:

```sh
curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
     -H "X-Admin-Actor: pat@example.com" \
     http://localhost:4000/v1/admin/monitoring/summary
```

Two tokens, two roles. `REVIEWER_API_TOKEN` is optional; `ADMIN_API_TOKEN` can do everything
a reviewer can. Tokens are at least 32 characters (`openssl rand -hex 32`), must differ, and
are compared in constant time. The `.env.example` values are placeholders that only make a
local copy start. The role and the header name are what the audit log records; no request
body can say who is acting.

| Route                                            | Role     | What it does                                                                                            |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `GET /v1/admin/whoami`                           | reviewer | The role and actor the API resolved                                                                     |
| `POST /v1/admin/jobs/run`                        | admin    | Run all jobs as of `{ asOf }`, or one with `{ only }`                                                   |
| `POST /v1/admin/capital/fund`                    | admin    | Add capital to the mock pool                                                                            |
| `POST /v1/admin/circuit-breaker/trip`            | admin    | Pause new automatic approvals: trip the breaker by hand (rule `manual`), with a reason                  |
| `POST /v1/admin/circuit-breaker/reset`           | admin    | Reset the circuit breaker, with a reason                                                                |
| `POST /v1/admin/rent-plans/:id/freeze`           | admin    | Freeze a plan's next period (`OPERATOR_HOLD`), with a reason. Stores a `PLAN_FROZEN` notice             |
| `GET /v1/admin/businesses/:id/limit`             | reviewer | The approved limit, any admin cap on it, and the limit in force                                         |
| `POST /v1/admin/businesses/:id/limit/lower`      | admin    | Cap the limit below the one in force, with a reason. A value at or above it is refused                  |
| `POST /v1/admin/businesses/:id/limit/remove-cap` | admin    | Take the cap off: the decision's limit applies again                                                    |
| `GET /v1/admin/circuit-breaker`                  | reviewer | Whether it is tripped, by which rule, and when                                                          |
| `GET /v1/admin/monitoring/summary`               | reviewer | Open alerts by severity, category and type, the breaker, the last run of every job and rule             |
| `GET /v1/admin/alerts`                           | reviewer | List, filtered by `status`, `severity`, `category`, `type`, `subjectType`, `subjectId`; paged           |
| `GET /v1/admin/alerts/:id`                       | reviewer | One alert with its subject, its rule, related alerts, and the audit trail                               |
| `POST /v1/admin/alerts/:id/acknowledge`          | reviewer | Acknowledge, with optional notes                                                                        |
| `POST /v1/admin/alerts/:id/resolve`              | reviewer | Resolve with a disposition and notes                                                                    |
| `GET /v1/admin/lease-changes`                    | reviewer | Landlord and payout changes, `PENDING` by default                                                       |
| `POST /v1/admin/lease-changes/:id/decide`        | reviewer | Approve a pending change early, or reject it                                                            |
| `GET /v1/admin/screening/hits`                   | reviewer | Screening hits: `open` by default, or `cleared`, or `all`                                               |
| `POST /v1/admin/screening/:id/clear`             | reviewer | Clear a hit with a reason. A `MATCH` needs the admin role                                               |
| `GET /v1/admin/businesses/:id/identity`          | reviewer | Verification state of a business and its owners                                                         |
| `GET /v1/admin/reviews`                          | reviewer | Applications the engine referred, with its recommendation, the triggers, and the integrity flags        |
| `POST /v1/admin/applications/:id/review`         | reviewer | Record a decision: `{ decision, reasonCodes, notes }`. An approval above $10,000 a month needs an admin |
| `POST /v1/admin/rent-plans/:id/release-freeze`   | reviewer | Lift a freeze, with `{ reason }`. An admin's hold needs an admin. Refused while a screening hit is open |
| `POST /v1/admin/payouts/:id/resend`              | reviewer | Send a returned landlord payout again, once corrected details have applied                              |
| `GET /v1/admin/delinquency`                      | reviewer | Plans and principal by bucket, the allowance, charge-offs, recoveries, held payouts                     |
| `GET /v1/admin/ledger/trial-balance`             | reviewer | Every account with debits, credits, and balance                                                         |
| `GET /v1/admin/ledger/accounts`                  | reviewer | The chart of accounts                                                                                   |
| `GET /v1/admin/capital`                          | reviewer | The pool's available balance                                                                            |
| `GET /v1/admin/audit-events`                     | reviewer | The audit trail for one record: `?subjectType=...&subjectId=...`                                        |

The operations console (`apps/ops`) uses the routes above and these reads, in
`src/routes/admin-console.ts`. They their responses are operator views built in
`src/services/operator.ts`: they carry what the customer serializers leave out (the engine's
terms on a referral, integrity flags, the fee build-up, screening detail, policy numbers), so
no customer route uses them.

| Route                                        | Role     | What it does                                                                                                                                                   |
| -------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/admin/businesses`                   | reviewer | Businesses by name. `?q=` matches legal name, trading name, owner email, or an id. `status`, `verification`, `limit`, `cursor`                                 |
| `GET /v1/admin/businesses/:id`               | reviewer | One business: verification, owners, bank links, leases (never the payout token), applications, pending lease changes, hits, alerts                             |
| `GET /v1/admin/businesses/:id/connections`   | reviewer | A business's connections: method, trust tier, health, what the platform or bank reported, snapshots, the latest veracity findings with evidence. Never a token |
| `GET /v1/admin/applications/:id/connections` | reviewer | The same, with the veracity assessment of that application's current decision                                                                                  |
| `GET /v1/admin/businesses/:id/rent-plans`    | reviewer | Its plans with standing and freeze, every payout (with hold reason) and every installment with its debits and return codes                                     |
| `GET /v1/admin/applications/:id`             | reviewer | One application for review: recommendation, score factors, flags, triggers, fee build-up, cash flow, history, reviews, audit trail                             |
| `GET /v1/admin/audit-log`                    | reviewer | Audit events across every subject, newest first. `subjectType`, `subjectId`, `eventType`, `actorType`, `actor`, `businessId`, `from`, `to`, `limit`, `cursor`  |
| `GET /v1/admin/portfolio`                    | reviewer | The live book: delinquency, pool and utilization, concentration against the caps, first payment default by origination month                                   |
| `GET /v1/admin/policy`                       | reviewer | The credit, servicing, controls, and monitoring numbers in force                                                                                               |
| `GET /v1/admin/policy/evaluation`            | reviewer | Gate results of the last default evaluation run, read from `evals/baseline.json`. Simulation, not the live book                                                |
| `GET /v1/admin/delinquency/plans`            | reviewer | Every plan with anything past due or out of the current bucket: days past due, amount, held payouts and their release date                                     |
| `GET /v1/admin/jobs`                         | reviewer | Each scheduled job's health (OK, running, failed, late, never run) and its recent runs                                                                         |

`GET /v1/admin/reviews` also returns `ageDays` and `decisionDueOn` on each item. Who may do
what, and why, is policy: [`CREDIT_POLICY.md`](CREDIT_POLICY.md), section 9.

## Dev tools

With `ENABLE_DEV_TOOLS=true` the API mounts `/v1/dev`. Without it the routes are not
registered (404), and the API refuses to start with it when `NODE_ENV=production`. They take
no credentials, so they also answer 404 to any caller that is not on this machine or a
private network. `./dev` turns the flag on in the `.env` it generates.

| Route                                | What it does                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `GET /v1/dev/personas`               | Every persona: what it demonstrates, its state now, its next event, and the preset inputs of a fresh applicant |
| `POST /v1/dev/personas/:key/session` | Sign in as a persona. The same session shape as `/v1/auth/login`, plus the persona and the screen to land on   |
| `POST /v1/dev/personas/:key/reset`   | Rebuild one persona as a new account and sign in as it. 409 for the seven personas that are replayed history   |
| `GET /v1/dev/clock`                  | The simulated date, the real date, and the days between                                                        |
| `POST /v1/dev/clock/advance`         | `{ days }`, `{ toDate }` or `{ toNextEventFor }`. Runs every job for each day crossed and returns what changed |
| `POST /v1/dev/reset`                 | Wipe everything, rebuild every persona as of the real date. The clock goes back with it                        |
| `GET /v1/dev/overview`               | Counts, plans by standing, open alerts, pool, trial balance, providers                                         |
| `GET /v1/dev/feed`                   | The latest job runs, audit events and open alerts. Read only                                                   |

**Personas** are in `src/dev/personas.ts`, one definition each, built by `src/dev/builders.ts`.
`prisma/seed.ts` builds all of them through `src/dev/seed.ts`.

**The clock.** The simulated date is the latest as-of date in `JobRun` when that is ahead of
the wall clock. `src/dates.ts` holds it for the process: `todayIso()`, `clockNow()` and
`effectiveAt()` read it, and every route, service, job and sandbox provider gets "today"
from those. The API re-reads it from the database at start and at most every two seconds,
so `job:run --as-of` or the operator jobs route moves it too. With the flag off nothing sets
it and those functions read the wall clock. Still on the wall clock with the dev clock
ahead: `createdAt` and `updatedAt` defaults written by the database, `JobRun.startedAt` and
`finishedAt`, access and refresh token expiry, login lockout, and rate limit windows.

**Resets.** `LedgerEntry`, `LedgerTransaction` and `AuditEvent` reject UPDATE and DELETE, so a
persona with ledger history cannot be deleted. `POST /v1/dev/reset` truncates every table
(triggers do not fire on TRUNCATE) and reseeds: about eight seconds. A per-persona reset
builds a new account with new ids. The old account is deleted when it never opened a rent
plan (it has no ledger postings; its audit events stay, pointing at ids that no longer
exist). An old account that did open a plan is archived instead: login renamed, sessions
revoked, business renamed, plans closed, bank and landlord account references changed so
integrity checks do not match it against its replacement. It stays in the book as a former
customer: its ledger entries stay in the trial balance, which stays balanced because
nothing is removed, and the monitoring rules, which read the whole book, keep counting it
until the next full reset.

## Rate limiting and lockout

`RATE_LIMIT_MAX` requests per client address per `RATE_LIMIT_WINDOW_SECONDS` on every route
(300 a minute by default), and `RATE_LIMIT_AUTH_MAX` (10) on register, login and refresh,
each counted on its own. `/health` is exempt. `LOGIN_MAX_FAILURES` wrong passwords in a row
(5) lock an account for `LOGIN_LOCKOUT_MINUTES` (15) and write a `LOGIN_LOCKED` audit event.
The integration tests run with rate limiting off.

See `DEPLOY.md` for Docker, Fly.io, and Render.

# @cashflow/api

Fastify API for CashFlow. Postgres via Prisma, Zod validation on every route, OpenAPI docs at
`/docs`, and ten scheduled jobs that screen parties, apply lease changes, pay landlords,
collect installments, handle returned payments, age and write off receivables, book loss
provisions, and monitor the result. Every provider that touches money or risk is a mock by
default.

## Run it

From the repo root, with Docker running:

```sh
pnpm setup                        # Postgres up, migrate, seed demo data
pnpm --filter @cashflow/api dev   # http://localhost:4000, docs at /docs
```

If port 5432 is taken on your machine, set `POSTGRES_PORT=5433` in the root `.env` and update
`DATABASE_URL` in `apps/api/.env` to match.

Demo login after seeding: `demo@cashflow.local` / `demo-password-123`. A second owner,
`sam@cashflow.local` with the same password, has the businesses that give the operator
routes something to show.

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

## Layout

```
prisma/schema.prisma     data model and enums
prisma/seed.ts           demo data: five months of jobs replayed day by day
src/app.ts               Fastify factory: plugins, error handling, routes
src/index.ts             server entry, starts the scheduler when JOBS_ENABLED=true
src/config.ts            environment parsing and safety rails
src/auth/                scrypt passwords, JWT access tokens, rotating refresh tokens
src/ledger/              double-entry ledger: accounts, validation, posting, trial balance
src/auth/admin.ts        operator tokens, roles, and the X-Admin-Actor identity
src/auth/lockout.ts      login lockout after repeated failures
src/providers/           underwriting, bank-link, payments, capital, identity (mocks + skeletons)
src/servicing/policy.ts  servicing rules as data and pure functions, shared with the evals
src/controls/policy.ts   cooling-off, rescreen interval, retention, decision deadline
src/monitoring/          rules (pure), data layer, engine, policy with every threshold
src/services/            rent plans, payouts and holds, collections, returns, delinquency,
                         charge-off, provisioning, identity and screening, lease change
                         control, the circuit breaker
src/jobs/                the ten jobs below, cron, CLI
src/routes/              HTTP handlers grouped by resource
src/serializers.ts       Prisma rows to API shapes from @cashflow/shared
src/test/                integration test harness
```

## Jobs

`job:run` runs all of them in this order for one date. `--only <name>` runs one. Each is
idempotent for a given date and records a `JobRun`. The reasoning for the order is in
`src/jobs/index.ts`; the rules are in `ARCHITECTURE.md` under "The life of a rent payment".

| Order | Name                   | What it does                                                                                          |
| ----: | ---------------------- | ----------------------------------------------------------------------------------------------------- |
|     1 | `rescreen`             | Screens active businesses, owners and landlords again once their screening is 30 days old             |
|     2 | `lease-changes`        | Applies landlord and payout changes whose cooling-off period has ended                                |
|     3 | `reunderwrite`         | Monthly review of each active plan on fresh bank data. Freezes a plan that has deteriorated           |
|     4 | `reconcile-payments`   | Polls the payments provider for returns and reverses each returned installment or payout              |
|     5 | `age-receivables`      | Delinquency bucket per plan, `LATE` marks, audit event on each change, charge-off at 90 days past due |
|     6 | `generate-periods`     | Next month's payout and installments, 30 days ahead, for active plans that are not frozen             |
|     7 | `process-payouts`      | Pays, holds, releases, or cancels each landlord payout that is due                                    |
|     8 | `collect-installments` | Scheduled debits (days 0, 3, and 6, after a balance check), then settles operating cash with the pool |
|     9 | `provision`            | Sets the allowance for credit losses by bucket. Posts on the first run of each calendar month         |
|    10 | `monitor`              | Runs every monitoring rule, opens and resolves alerts, trips the circuit breaker on a critical breach |

To see the unhappy paths in the sandbox, point a bank account or a landlord at a mock
payments keyword. `mock_acct_fail` rejects every debit. `mock_acct_return_r01` accepts a
debit and returns it two days later for insufficient funds; any two digit code works
(`return_r02` is a closed account). `late_return_r10` returns it three weeks later as
unauthorized. Adding `_once` returns only the first payment. A lease whose payout token
contains `return_r03` has its landlord payout sent back. The mock remembers pending returns
for the life of one process, so they show up when the jobs run inside the API server, the
seed, or a test, and not across separate `job:run` invocations.

The seed has one business in each state: Blue Door Bakery is current, Cedar Street Cycles is
delinquent with a held payout, and Juniper Print Studio was charged off and has since paid
one of its two written off installments. Under `sam@cashflow.local`, Alder & Ash Florist has
a landlord payout change inside its cooling-off period with the payout held, Meridian Supply
is in review on a possible screening match, and Tidewater Sign Works has been in review for
34 days. The seed replays the `monitor` job with the others, so the open alerts (at least one
of each severity) were raised by the rules, not inserted.

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

| Route                                          | Role     | What it does                                                                                     |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `GET /v1/admin/whoami`                         | reviewer | The role and actor the API resolved                                                              |
| `POST /v1/admin/jobs/run`                      | admin    | Run all jobs as of `{ asOf }`, or one with `{ only }`                                            |
| `POST /v1/admin/capital/fund`                  | admin    | Add capital to the mock pool                                                                     |
| `POST /v1/admin/circuit-breaker/reset`         | admin    | Reset the circuit breaker, with a reason                                                         |
| `GET /v1/admin/circuit-breaker`                | reviewer | Whether it is tripped, by which rule, and when                                                   |
| `GET /v1/admin/monitoring/summary`             | reviewer | Open alerts by severity, category and type, the breaker, the last run of every job and rule      |
| `GET /v1/admin/alerts`                         | reviewer | List, filtered by `status`, `severity`, `category`, `type`, `subjectType`, `subjectId`; paged    |
| `GET /v1/admin/alerts/:id`                     | reviewer | One alert with its subject, its rule, related alerts, and the audit trail                        |
| `POST /v1/admin/alerts/:id/acknowledge`        | reviewer | Acknowledge, with optional notes                                                                 |
| `POST /v1/admin/alerts/:id/resolve`            | reviewer | Resolve with a disposition and notes                                                             |
| `GET /v1/admin/lease-changes`                  | reviewer | Landlord and payout changes, `PENDING` by default                                                |
| `POST /v1/admin/lease-changes/:id/decide`      | reviewer | Approve a pending change early, or reject it                                                     |
| `GET /v1/admin/screening/hits`                 | reviewer | Screening hits: `open` by default, or `cleared`, or `all`                                        |
| `POST /v1/admin/screening/:id/clear`           | reviewer | Clear a hit with a reason. A `MATCH` needs the admin role                                        |
| `GET /v1/admin/businesses/:id/identity`        | reviewer | Verification state of a business and its owners                                                  |
| `GET /v1/admin/reviews`                        | reviewer | Applications the engine referred, with its recommendation, the triggers, and the integrity flags |
| `POST /v1/admin/applications/:id/review`       | reviewer | Record a decision: `{ decision, reasonCodes, notes }`. See `UNDERWRITING.md`                     |
| `POST /v1/admin/rent-plans/:id/release-freeze` | reviewer | Lift a freeze, with `{ reason }`. Refused while a screening hit is open                          |
| `POST /v1/admin/payouts/:id/resend`            | reviewer | Send a returned landlord payout again, once corrected details have applied                       |
| `GET /v1/admin/delinquency`                    | reviewer | Plans and principal by bucket, the allowance, charge-offs, recoveries, held payouts              |
| `GET /v1/admin/ledger/trial-balance`           | reviewer | Every account with debits, credits, and balance                                                  |
| `GET /v1/admin/ledger/accounts`                | reviewer | The chart of accounts                                                                            |
| `GET /v1/admin/capital`                        | reviewer | The pool's available balance                                                                     |
| `GET /v1/admin/audit-events`                   | reviewer | The audit trail for one record: `?subjectType=...&subjectId=...`                                 |

Owner routes added in this area: `PATCH /v1/leases/:id` now returns `pendingChange` and
`pendingRentIncrease` (see "Lease change control" in `ARCHITECTURE.md`), and
`POST /v1/leases/:id/pending-change/cancel` cancels a pending landlord change.

## Rate limiting and lockout

`RATE_LIMIT_MAX` requests per client address per `RATE_LIMIT_WINDOW_SECONDS` on every route
(300 a minute by default), and `RATE_LIMIT_AUTH_MAX` (10) on register, login and refresh,
each counted on its own. `/health` is exempt. `LOGIN_MAX_FAILURES` wrong passwords in a row
(5) lock an account for `LOGIN_LOCKOUT_MINUTES` (15) and write a `LOGIN_LOCKED` audit event.
The integration tests run with rate limiting off.

See `DEPLOY.md` for Docker, Fly.io, and Render.

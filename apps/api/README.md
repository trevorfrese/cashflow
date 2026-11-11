# @cashflow/api

Fastify API for CashFlow. Postgres via Prisma, Zod validation on every route, OpenAPI docs at
`/docs`, and seven scheduled jobs that pay landlords, collect installments, handle returned
payments, age and write off receivables, and book loss provisions. Every provider that
touches money is a mock by default.

## Run it

From the repo root, with Docker running:

```sh
pnpm setup                        # Postgres up, migrate, seed demo data
pnpm --filter @cashflow/api dev   # http://localhost:4000, docs at /docs
```

If port 5432 is taken on your machine, set `POSTGRES_PORT=5433` in the root `.env` and update
`DATABASE_URL` in `apps/api/.env` to match.

Demo login after seeding: `demo@cashflow.local` / `demo-password-123`.

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
src/providers/           underwriting, bank-link, payments, capital (mocks + skeletons)
src/servicing/policy.ts  servicing rules as data and pure functions, shared with the evals
src/services/            rent plans, payouts and holds, collections, returns, delinquency,
                         charge-off, provisioning
src/jobs/                the seven jobs below, cron, CLI
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
|     1 | `reunderwrite`         | Monthly review of each active plan on fresh bank data. Freezes a plan that has deteriorated           |
|     2 | `reconcile-payments`   | Polls the payments provider for returns and reverses each returned installment or payout              |
|     3 | `age-receivables`      | Delinquency bucket per plan, `LATE` marks, audit event on each change, charge-off at 90 days past due |
|     4 | `generate-periods`     | Next month's payout and installments, 30 days ahead, for active plans that are not frozen             |
|     5 | `process-payouts`      | Pays, holds, releases, or cancels each landlord payout that is due                                    |
|     6 | `collect-installments` | Scheduled debits (days 0, 3, and 6, after a balance check), then settles operating cash with the pool |
|     7 | `provision`            | Sets the allowance for credit losses by bucket. Posts on the first run of each calendar month         |

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
one of its two written off installments.

## Admin routes

With `ENABLE_ADMIN=true` (the local default) these unauthenticated routes exist for demos:

- `POST /v1/admin/jobs/run` with optional `{ "asOf": "YYYY-MM-DD" }`: run all jobs as of a date.
- `GET /v1/admin/ledger/trial-balance`: every account with debits, credits, and balance.
- `GET /v1/admin/capital` and `POST /v1/admin/capital/fund`: inspect and top up the mock pool.
- `GET /v1/admin/reviews`: applications the engine referred, with its recommendation, the
  referral triggers, and the integrity flags.
- `POST /v1/admin/applications/:id/review` with `{ reviewer, decision, reasonCodes, notes }`:
  record a reviewer's decision. See "Escalation and manual review" in `UNDERWRITING.md`.
- `GET /v1/admin/audit-events?subjectType=application&subjectId=...`: the audit trail for one
  record. Servicing events are written with `subjectType=rent_plan`.
- `GET /v1/admin/delinquency`: plans and principal by delinquency bucket with the reserve
  each calls for, the allowance, charge-offs and recoveries to date, held payouts, and frozen
  plans.
- `POST /v1/admin/rent-plans/:id/release-freeze` with `{ reviewer, reason }`: lift a freeze
  set by a periodic review, an unauthorized return, or a returned payout.

Never enable them on a public deployment.

See `DEPLOY.md` for Docker, Fly.io, and Render.

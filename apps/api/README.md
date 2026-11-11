# @cashflow/api

Fastify API for CashFlow. Postgres via Prisma, Zod validation on every route, OpenAPI docs at
`/docs`, and three scheduled jobs that pay landlords and collect installments. Every provider
that touches money is a mock by default.

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
prisma/seed.ts           demo data with three months of replayed history
src/app.ts               Fastify factory: plugins, error handling, routes
src/index.ts             server entry, starts the scheduler when JOBS_ENABLED=true
src/config.ts            environment parsing and safety rails
src/auth/                scrypt passwords, JWT access tokens, rotating refresh tokens
src/ledger/              double-entry ledger: accounts, validation, posting, trial balance
src/providers/           underwriting, bank-link, payments, capital (mocks + skeletons)
src/services/            rent plan creation, landlord payouts, installment collection
src/jobs/                reunderwrite, generate-periods, process-payouts, collect-installments, cron, CLI
src/routes/              HTTP handlers grouped by resource
src/serializers.ts       Prisma rows to API shapes from @cashflow/shared
src/test/                integration test harness
```

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
  record.

Never enable them on a public deployment.

See `DEPLOY.md` for Docker, Fly.io, and Render.

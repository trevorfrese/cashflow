# Deploying the API

The API is a single Node process plus Postgres. It runs TypeScript directly with tsx, applies
Prisma migrations on boot, and runs its scheduled jobs in process. Everything below keeps the
mock providers, so no real money can move.

## Environment

Copy `.env.example` and set at least:

- `DATABASE_URL`: a Postgres connection string.
- `JWT_SECRET`: `openssl rand -base64 48`.
- `CORS_ORIGIN`: the origins your clients run on, or `*` for a demo.
- `ENABLE_ADMIN=false` on anything public. The admin routes are unauthenticated and let callers
  run jobs and fund the mock pool.

## Docker

Build from the repo root so the workspace packages are included:

```sh
docker build -f apps/api/Dockerfile -t cashflow-api .
docker run --rm -p 4000:4000 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/cashflow \
  -e JWT_SECRET=change-me-with-openssl-rand \
  cashflow-api
```

The container runs `prisma migrate deploy` and then starts the server.

## Fly.io

`fly.toml` is included. From the repo root:

```sh
fly launch --no-deploy --copy-config --config apps/api/fly.toml
fly postgres create                      # then attach it, which sets DATABASE_URL
fly postgres attach <your-pg-app> --config apps/api/fly.toml
fly secrets set JWT_SECRET="$(openssl rand -base64 48)" --config apps/api/fly.toml
fly deploy --config apps/api/fly.toml --dockerfile apps/api/Dockerfile .
```

Seed demo data once with `fly ssh console -C "pnpm db:seed"`.

## Render

1. Create a Postgres instance and copy its internal connection string.
2. Create a Web Service from the repo with **Docker** as the runtime, **Dockerfile path**
   `apps/api/Dockerfile`, and **Docker build context** `.` (the repo root).
3. Set `DATABASE_URL`, `JWT_SECRET`, and `ENABLE_ADMIN=false` in the environment tab.
4. Health check path: `/health`.

## Scaling note

Jobs run inside the API on a cron schedule and never overlap within one process. If you run
more than one instance, set `JOBS_ENABLED=false` everywhere and trigger
`pnpm --filter @cashflow/api job:run` from a single external scheduler instead. The jobs are
idempotent, so an accidental double run is safe, but there is no distributed lock.

# Build from the repo root so the workspace is available:
#   docker build -f apps/api/Dockerfile -t cashflow-api .
# The API runs TypeScript directly with tsx; there is no separate compile step.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @cashflow/api... --prod=false

FROM deps AS app
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @cashflow/api exec prisma generate

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
EXPOSE 4000
WORKDIR /repo/apps/api

# Apply migrations, then start. Keep JOBS_ENABLED=true for a single instance, or disable it and
# run `pnpm job:run` from an external scheduler if you run more than one replica.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm start"]

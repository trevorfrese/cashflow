# CLAUDE.md

CashFlow is an open source "buy now, pay later" product for small business rent, released as a build-in-public showcase after the startup behind it wound down. CashFlow pays the landlord in full on the due date and the business repays in installments (two per month by default).

There is no real capital behind this repo. Everything that touches money or risk runs in mock or sandbox mode by default and must never move real funds.

## Repo layout

```
apps/web          Next.js one page marketing site for splitmylease.com (Vercel)
apps/ops          Next.js operations console for staff: queues, alerts, portfolio, customers, audit, policy. Local only, never deployed
apps/mobile       Expo app: auth, onboarding, underwriting, lease linking, rent plan
apps/api          Fastify API: Prisma + Postgres, Zod, provider interfaces, underwriting engine, scheduled jobs
packages/shared   Zod schemas, enums, types, brand tokens, pure installment math
docker/           Postgres init SQL for docker compose
dev               The one command entry point (sh wrapper around scripts/dev/cli.mjs)
scripts/          Repo-level scripts: the dev CLI and supervisor (scripts/dev), em dash check
.github/          CI workflow
```

Package names are scoped: `@cashflow/shared`, `@cashflow/api`, `@cashflow/web`, `@cashflow/ops`, `@cashflow/mobile`. Use them with `pnpm --filter`.

## Tooling

- Node 22 (`.nvmrc`), pnpm 10 (`packageManager` in `package.json`), Turborepo.
- TypeScript strict everywhere, extending `tsconfig.base.json`.
- ESLint flat config and Prettier at the root. Packages run `eslint .` and pick up the root config.
- Vitest for all tests.
- `@cashflow/shared` exports TypeScript source directly. Consumers compile it: tsx for the API (dev and Docker), Next `transpilePackages`, and Metro for Expo.

## Commands

Run from the repo root unless noted.

```sh
./dev                        # one command: install, .env files, Postgres, migrate, seed, start everything
./dev --detach               # the same in the background, returns when healthy (use this from an agent)
./dev status --json          # what is running, ports, pids, health, simulated date, log paths
./dev smoke                  # scripted happy path over HTTP, exits non-zero on a failed step
./dev stop                   # stop what ./dev started
./dev help                   # every command and flag
pnpm install                 # install only
pnpm setup                   # the older three steps by hand: Postgres (docker), migrate, seed
pnpm dev                     # API + web in parallel, without the supervisor
pnpm dev:mobile              # Expo dev server for a phone (separate terminal)
pnpm dev:ops                 # operations console on :3200 (separate terminal, needs apps/ops/.env.local)
pnpm build                   # build all packages
pnpm lint                    # eslint across packages + em dash check
pnpm typecheck               # tsc --noEmit across packages
pnpm test                    # vitest across packages
pnpm format                  # prettier --write
pnpm db:up / db:down         # Postgres container
pnpm db:reset                # drop volume, recreate, migrate, seed
pnpm check:copy              # fail on any em dash in tracked files
```

Per package: `pnpm --filter @cashflow/api dev`, `pnpm --filter @cashflow/shared test`, and so on. API specific commands (`db:migrate`, `db:seed`, `job:run`) are documented in `apps/api/README.md`. Mobile specifics (sandbox bank scenarios, `EXPO_PUBLIC_API_URL`) are in `apps/mobile/README.md`. The operations console (session cookie, proxy, pages) is in `apps/ops/README.md`.

`AGENTS.md` has the full run, verify, drive and teardown loop for an agent, the personas, and common failure signatures. This file stays the source for conventions.

Docs to read before changing behavior: `ARCHITECTURE.md` (providers, data model, ledger postings, payment lifecycle, jobs), `apps/api/CREDIT_POLICY.md` (the credit policy and its change control), `apps/api/UNDERWRITING.md` (the underwriting mechanics and the veracity checks), `apps/api/DATA_CONNECTIONS.md` (how data is obtained), `apps/api/evals/README.md` (the portfolio evaluation and its gates), and `COMPLIANCE.md` (what is and is not settled legally, and the questions for counsel).

## Conventions

- Money is always integer cents (`amountCents`). Never floats. Rates are basis points (`feeBps`).
- Dates that are calendar dates (due dates, periods) are `YYYY-MM-DD` strings. Timestamps are ISO 8601 in UTC.
- Validate every API input and output with the Zod schemas in `packages/shared`. Add the schema there first, then use it on both sides.
- Keep `packages/shared` free of runtime dependencies other than `zod`.
- Prefer small, focused commits with imperative subject lines: `Add installment schedule math`.
- Tests live beside the code as `*.test.ts`. Integration tests that need Postgres are named `*.int.test.ts`.
- No em dashes in copy, docs, comments, or code. Use a comma, colon, or period instead.
- Do not commit secrets. Every app has a `.env.example`; real `.env` files are gitignored.

## Money and provider rules

- Every external dependency that touches money or risk is an interface in `apps/api/src/providers/<name>/` with `types.ts`, a mock or in-house implementation, and an `index.ts` factory that picks the implementation from an environment variable. The mock or in-house implementation is always the default.
  - `UnderwritingProvider` (`UNDERWRITING_PROVIDER`, default `cashflow`: the in-house cash flow engine in `apps/api/src/underwriting/`, documented in `apps/api/UNDERWRITING.md` and `apps/api/CREDIT_POLICY.md`)
  - `BankLinkProvider` (`BANK_LINK_PROVIDER`): an aggregator, never a credentialed bank login
  - `CommerceDataProvider` (`COMMERCE_PROVIDER`): read-only OAuth to Square, Shopify, Stripe, Clover
  - `DelegatedSeatProvider` (`DELEGATED_SEAT_PROVIDER`): CashFlow's own read-only seat on platforms without an API (Toast)
  - `IdentityProvider` (`IDENTITY_PROVIDER`): business and owner verification, sanctions screening
  - `PaymentsProvider` (`PAYMENTS_PROVIDER`)
  - `CapitalProvider` (`CAPITAL_PROVIDER`)
- Data for underwriting is pulled by CashFlow through a connection the owner authorized, stored as an append-only snapshot, and checked for veracity (`apps/api/src/veracity/`). No uploaded statements. Platform tokens are sealed by `src/crypto/token-vault.ts` and never returned, logged, or audited. See `apps/api/DATA_CONNECTIONS.md`.
- A credit policy, pricing, PD table, or servicing change is a new policy version, and ships only when `pnpm --filter @cashflow/api eval:portfolio --strict` passes every gate, committed with the regenerated `evals/report.md` and `evals/baseline.json`. No gate threshold is loosened to make a change pass. See `apps/api/CREDIT_POLICY.md`, "Change control".
- All money movements (landlord payouts, installment collections, fees, pool replenishment) post a `LedgerTransaction` with balanced `LedgerEntry` rows. The ledger service rejects unbalanced transactions. Balances are derived from entries, never stored.
- Status changes and their ledger postings happen in the same database transaction.
- Scheduled jobs are idempotent and record a `JobRun`.
- Never add a real payment, bank, or capital integration that is active by default. Skeleton adapters may exist but must refuse to run without explicit configuration.

## Dev tools

- Everything that can impersonate a user, reset data, or move the clock lives under `apps/api/src/dev/` and `/v1/dev`, behind `ENABLE_DEV_TOOLS` (default off, refused when `NODE_ENV=production`, routes not registered when off). The app's side is `apps/mobile/src/dev/`, behind `EXPO_PUBLIC_DEV_TOOLS`. Keep new dev-only code behind the same two flags and add a test that it is absent with the flag off.
- Personas are defined in one file, `apps/api/src/dev/personas.ts`. The seed, the dev routes, the dev menu, the CLI and the dev home page all read it.
- "Today" comes from `todayIso()` and `clockNow()` in `apps/api/src/dates.ts`, never from `new Date()`, for anything that is business behavior. That is what lets the simulated clock work.

## Brand

Design tokens live in `packages/shared/src/brand.ts` and come from the final board of the CashFlow brand canvas. Coin Gold `#F4B323` and Bright Gold `#FFD43B` carry the brand on Paper `#FAF8F3` with Ink `#14120E` text. Azure `#0A7CFF` is the accent for primary actions and the app icon. The mark is a flat gold coin with a cents symbol. The wordmark is Archivo at 125% width, weight 800. Product state colors: Paid green, Due soon amber, Late red. Use the tokens, not ad hoc hex values.

## Working with the owner

- Ask before adding any paid service or making a decision that is hard to reverse.
- After finishing a phase of work, stop, summarize what was built, and suggest a commit message before continuing.

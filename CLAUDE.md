# CLAUDE.md

CashFlow is an open source "buy now, pay later" product for small business rent, released as a build-in-public showcase after the startup behind it wound down. CashFlow pays the landlord in full on the due date and the business repays in installments (two per month by default).

There is no real capital behind this repo. Everything that touches money or risk runs in mock or sandbox mode by default and must never move real funds.

## Repo layout

```
apps/web          Next.js one page marketing site for splitmylease.com (Vercel)
apps/mobile       Expo app: auth, onboarding, underwriting, lease linking, rent plan
apps/api          Fastify API: Prisma + Postgres, Zod, provider interfaces, underwriting engine, scheduled jobs
packages/shared   Zod schemas, enums, types, brand tokens, pure installment math
docker/           Postgres init SQL for docker compose
scripts/          Repo-level scripts (em dash check)
.github/          CI workflow
```

Package names are scoped: `@cashflow/shared`, `@cashflow/api`, `@cashflow/web`, `@cashflow/mobile`. Use them with `pnpm --filter`.

## Tooling

- Node 22 (`.nvmrc`), pnpm 10 (`packageManager` in `package.json`), Turborepo.
- TypeScript strict everywhere, extending `tsconfig.base.json`.
- ESLint flat config and Prettier at the root. Packages run `eslint .` and pick up the root config.
- Vitest for all tests.
- `@cashflow/shared` exports TypeScript source directly. Consumers compile it: tsx for the API (dev and Docker), Next `transpilePackages`, and Metro for Expo.

## Commands

Run from the repo root unless noted.

```sh
pnpm install                 # install everything
pnpm setup                   # start Postgres (docker), migrate, seed demo data
pnpm dev                     # API + web in parallel
pnpm dev:mobile              # Expo dev server (separate terminal)
pnpm build                   # build all packages
pnpm lint                    # eslint across packages + em dash check
pnpm typecheck               # tsc --noEmit across packages
pnpm test                    # vitest across packages
pnpm format                  # prettier --write
pnpm db:up / db:down         # Postgres container
pnpm db:reset                # drop volume, recreate, migrate, seed
pnpm check:copy              # fail on any em dash in tracked files
```

Per package: `pnpm --filter @cashflow/api dev`, `pnpm --filter @cashflow/shared test`, and so on. API specific commands (`db:migrate`, `db:seed`, `job:run`) are documented in `apps/api/README.md`. Mobile specifics (sandbox bank scenarios, `EXPO_PUBLIC_API_URL`) are in `apps/mobile/README.md`.

Docs to read before changing behavior: `ARCHITECTURE.md` (providers, ledger, payment lifecycle) and `apps/api/UNDERWRITING.md` (the cash flow underwriting model).

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
  - `UnderwritingProvider` (`UNDERWRITING_PROVIDER`, default `cashflow`: the in-house cash flow engine in `apps/api/src/underwriting/`, documented in `apps/api/UNDERWRITING.md`)
  - `BankLinkProvider` (`BANK_LINK_PROVIDER`)
  - `PaymentsProvider` (`PAYMENTS_PROVIDER`)
  - `CapitalProvider` (`CAPITAL_PROVIDER`)
  - `CommerceDataProvider` (`COMMERCE_PROVIDER`)
  - `IdentityProvider` (`IDENTITY_PROVIDER`)
- All money movements (landlord payouts, installment collections, fees, pool replenishment) post a `LedgerTransaction` with balanced `LedgerEntry` rows. The ledger service rejects unbalanced transactions. Balances are derived from entries, never stored.
- Status changes and their ledger postings happen in the same database transaction.
- Scheduled jobs are idempotent and record a `JobRun`.
- Never add a real payment, bank, or capital integration that is active by default. Skeleton adapters may exist but must refuse to run without explicit configuration.

## Brand

Design tokens live in `packages/shared/src/brand.ts` and come from the final board of the CashFlow brand canvas. Coin Gold `#F4B323` and Bright Gold `#FFD43B` carry the brand on Paper `#FAF8F3` with Ink `#14120E` text. Azure `#0A7CFF` is the accent for primary actions and the app icon. The mark is a flat gold coin with a cents symbol. The wordmark is Archivo at 125% width, weight 800. Product state colors: Paid green, Due soon amber, Late red. Use the tokens, not ad hoc hex values.

## Working with the owner

- Ask before adding any paid service or making a decision that is hard to reverse.
- After finishing a phase of work, stop, summarize what was built, and suggest a commit message before continuing.

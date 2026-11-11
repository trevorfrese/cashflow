# CashFlow

Buy now, pay later for small business rent. CashFlow pays the landlord in full on the due date and the business repays in two installments, on the 1st and the 15th, plus a flat fee.

This was a startup. It wound down, and the whole product is released here as a reference implementation: Expo app, Fastify API, underwriting engine, double entry ledger, scheduled jobs, and the marketing site. MIT licensed.

No real money moves in this code. Every bank, payment, and capital integration is an interface with a mock implementation that is selected by default.

## Stack

- pnpm workspaces, Turborepo, Node 22, TypeScript strict, ESLint, Prettier, Vitest
- `apps/api`: Fastify 5, Prisma 7 on Postgres, Zod validated routes, OpenAPI at `/docs`, node-cron jobs
- `apps/mobile`: Expo SDK 58, Expo Router, TanStack Query
- `apps/web`: Next.js static export, one page
- `packages/shared`: Zod schemas, enums, brand tokens, installment math

## Run it

Requires Node 22, pnpm 10, and Docker.

```sh
git clone https://github.com/trevorfrese/cashflow.git
cd cashflow
pnpm install
pnpm setup        # Postgres in Docker, migrate, seed
pnpm dev          # API :4000, web :3000
pnpm dev:mobile   # Expo dev server, second terminal
```

Sign in with the seeded demo account, `demo@cashflow.local` / `demo-password-123`. It owns five businesses: one with an active $10,000 rent plan and payment history, one that has fallen behind and has a landlord payout on hold, one whose plan was charged off and closed, one declined for overdrafts, and one that still needs a bank. Or register and pick a sandbox bank scenario to walk through every underwriting outcome.

Other commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm db:reset`, and `pnpm --filter @cashflow/api job:run --as-of YYYY-MM-DD` to run the payout and collection jobs for a given day.

## How it works

1. A business registers, connects a bank (mock), and submits an application.
2. The underwriting engine scores twelve months of transactions and returns approved, declined, or needs info, with reasons and a rent limit. See [`apps/api/UNDERWRITING.md`](apps/api/UNDERWRITING.md).
3. The business links a lease and starts a rent plan.
4. `generate-periods` creates next month's landlord payout and installments 30 days ahead.
5. `process-payouts` reserves capital and pays the landlord on the due date.
6. `collect-installments` charges each installment on its date, retries failures, and marks late after three days.

Every money movement posts a balanced ledger transaction in the same database transaction as the status change. Balances are derived from entries, never stored. The jobs are idempotent.

## Provider seams

| Interface              | Env var                 | Default                           |
| ---------------------- | ----------------------- | --------------------------------- |
| `UnderwritingProvider` | `UNDERWRITING_PROVIDER` | `cashflow`, the in-house engine   |
| `BankLinkProvider`     | `BANK_LINK_PROVIDER`    | `mock`, synthetic histories       |
| `PaymentsProvider`     | `PAYMENTS_PROVIDER`     | `mock`, fails if token has `fail` |
| `CapitalProvider`      | `CAPITAL_PROVIDER`      | `mock`, a pool in the ledger      |

Each lives in `apps/api/src/providers/<name>/` with `types.ts`, the mock, and an `index.ts` factory. Plaid and Stripe shaped skeletons show where a real adapter goes; they refuse to run without configuration.

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md): providers, ledger, and the payment lifecycle
- [`apps/api/UNDERWRITING.md`](apps/api/UNDERWRITING.md): the cash flow underwriting model
- [`apps/api/README.md`](apps/api/README.md), [`apps/mobile/README.md`](apps/mobile/README.md), [`apps/web/README.md`](apps/web/README.md): per package notes
- [`CLAUDE.md`](CLAUDE.md): conventions and commands

## License

[MIT](LICENSE)

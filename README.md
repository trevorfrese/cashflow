# CashFlow

Buy now, pay later for small business rent. CashFlow pays the landlord in full on the due date and the business repays in two installments, on the 1st and the 15th, plus a flat fee.

This was a startup. It wound down, and the whole product is released here as a reference implementation: Expo app, Fastify API, underwriting engine, double entry ledger, scheduled jobs, and the marketing site. MIT licensed.

No real money moves in this code. Every bank, payment, and capital integration is an interface with a mock implementation that is selected by default.

## Stack

- pnpm workspaces, Turborepo, Node 22, TypeScript strict, ESLint, Prettier, Vitest
- `apps/api`: Fastify 5, Prisma 7 on Postgres, Zod validated routes, OpenAPI at `/docs`, node-cron jobs
- `apps/mobile`: Expo SDK 58, Expo Router, TanStack Query
- `apps/web`: Next.js static export, one page
- `apps/ops`: Next.js operations console for staff, local only
- `packages/shared`: Zod schemas, enums, brand tokens, installment math

## Run it

```sh
git clone https://github.com/trevorfrese/cashflow.git
cd cashflow
./dev
```

That is the whole setup. It needs Node 22 and Docker, and enables pnpm through corepack if you do not have it. A first run takes one to two minutes, most of it installing dependencies (45 seconds with a warm pnpm store); after that it is up in under ten seconds. On Windows, run it inside WSL.

`./dev` checks your machine and tells you exactly what to fix if something is missing, installs, writes the local `.env` files with fresh secrets, starts Postgres in Docker, migrates, seeds thirteen demo accounts with five months of replayed history, starts everything, and prints a status board:

| What           | Where                   |                                                       |
| -------------- | ----------------------- | ----------------------------------------------------- |
| The app        | <http://localhost:8099> | Expo on web. `pnpm dev:mobile` for a phone            |
| API            | <http://localhost:4000> | OpenAPI at `/docs`                                    |
| Ops console    | <http://localhost:3200> | staff side: sign in with a token from `apps/api/.env` |
| Marketing site | <http://localhost:3100> |                                                       |
| **Dev home**   | <http://localhost:4100> | health, personas, the clock, job runs, logs           |

Sign in as `demo@cashflow.local` / `demo-password-123`, or use the dev menu.

### The dev menu

In the app, tap the coin five times (the CashFlow wordmark on the welcome screen), or press <kbd>Ctrl</kbd>+<kbd>`</kbd> on web. Pick who to be: a customer with an active plan and history, one that is delinquent with its landlord payout held, one that was charged off, a landlord change in its cooling-off period, a decline, a missing bank, two kinds of manual review, an approval for less than the rent, or one of four fresh applicants whose onboarding is preset to end in a chosen decision. Then move the simulated clock a day, a week, or to the next thing that happens to that business, and watch the jobs pay landlords, collect, age and write off.

It exists only when the local `.env` files turn it on, which `./dev` does. The API refuses to start with it in production.

### Commands

| Command                          | What it does                                                                |
| -------------------------------- | --------------------------------------------------------------------------- |
| `./dev`                          | Set up and start everything. Ctrl+C stops it                                |
| `./dev --only api,mobile`        | Start a subset: `api`, `mobile`, `ops`, `web`. Or leave one out: `--no-web` |
| `./dev --detach`                 | Start in the background and return when healthy (automatic without a TTY)   |
| `./dev --reseed`                 | Wipe the database and rebuild the demo data on the way up                   |
| `./dev --no-dev-tools`           | Run with the dev menu, personas and simulated clock off                     |
| `./dev --open`                   | Open the dev home page when everything is up                                |
| `./dev --timeout 300`            | Seconds to wait for services to be healthy (default 240)                    |
| `./dev status [--json]`          | The status board again, or the same as JSON                                 |
| `./dev wait`                     | Block until every started service is healthy                                |
| `./dev logs api --tail 50`       | A service log. `--follow` to keep reading. Files are in `.dev/logs/`        |
| `./dev stop`                     | Stop what `./dev` started, and nothing else                                 |
| `./dev personas [--json]`        | Every persona and its state right now                                       |
| `./dev session <persona>`        | Sign in as a persona. `--token` prints an access token for curl             |
| `./dev clock`                    | The simulated date                                                          |
| `./dev advance --days 7`         | Move the clock, running every job for each day. Or `--to DATE`, `--next P`  |
| `./dev reset [--persona <key>]`  | Rebuild the demo data, or one persona                                       |
| `./dev smoke [--reset] [--json]` | The happy path scripted over HTTP, register to trial balance. Fails loudly  |
| `./dev doctor`                   | The preflight checks only                                                   |

Ports and the database name come from the environment when you need a second copy or a port is taken: `API_PORT`, `MOBILE_PORT`, `OPS_PORT`, `WEB_PORT`, `DEV_HOME_PORT`, `POSTGRES_PORT`, `POSTGRES_DB`, or `DATABASE_URL` for a Postgres you already run. `pnpm dev:up` is the same as `./dev`.

Also: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Working with a coding agent: [`AGENTS.md`](AGENTS.md) has the run, verify, drive and teardown loop.

## How it works

1. A business registers, connects a bank (mock), and submits an application.
2. The underwriting engine scores twelve months of transactions and returns approved, declined, or needs info, with reasons and a rent limit. See [`apps/api/UNDERWRITING.md`](apps/api/UNDERWRITING.md).
3. The business links a lease and starts a rent plan.
4. `generate-periods` creates next month's landlord payout and installments 30 days ahead.
5. `process-payouts` reserves capital and pays the landlord on the due date.
6. `collect-installments` charges each installment on its date, retries failures, and marks late after three days.

Every money movement posts a balanced ledger transaction in the same database transaction as the status change. Balances are derived from entries, never stored. The jobs are idempotent.

## Operations console

`apps/ops` is the staff side: the review queue for referred applications, monitoring alerts, lease changes, screening hits, the live portfolio, a customer view with plans, payments and the audit trail, the audit log, and the policy in force. It is a local tool and is not deployed.

`./dev` starts it on <http://localhost:3200> and generates its session secret. Sign in with your name and `ADMIN_API_TOKEN` or `REVIEWER_API_TOKEN` from `apps/api/.env`. The token is kept in an encrypted, httpOnly cookie and attached to API calls by the console's server, so the browser never holds it. See [`apps/ops/README.md`](apps/ops/README.md).

## Provider seams

| Interface              | Env var                 | Default                           |
| ---------------------- | ----------------------- | --------------------------------- |
| `UnderwritingProvider` | `UNDERWRITING_PROVIDER` | `cashflow`, the in-house engine   |
| `BankLinkProvider`     | `BANK_LINK_PROVIDER`    | `mock`, synthetic histories       |
| `PaymentsProvider`     | `PAYMENTS_PROVIDER`     | `mock`, fails if token has `fail` |
| `CapitalProvider`      | `CAPITAL_PROVIDER`      | `mock`, a pool in the ledger      |
| `IdentityProvider`     | `IDENTITY_PROVIDER`     | `mock`, hits on name keywords     |

Each lives in `apps/api/src/providers/<name>/` with `types.ts`, the mock, and an `index.ts` factory. Plaid and Stripe shaped skeletons show where a real adapter goes; they refuse to run without configuration.

## Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md): providers, ledger, and the payment lifecycle
- [`apps/api/UNDERWRITING.md`](apps/api/UNDERWRITING.md): the cash flow underwriting model
- [`apps/api/README.md`](apps/api/README.md), [`apps/mobile/README.md`](apps/mobile/README.md), [`apps/web/README.md`](apps/web/README.md), [`apps/ops/README.md`](apps/ops/README.md): per package notes
- [`CLAUDE.md`](CLAUDE.md): conventions and commands
- [`AGENTS.md`](AGENTS.md): running and driving the system from a coding agent, personas, failure signatures

## License

[MIT](LICENSE)

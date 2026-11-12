# CashFlow

Buy now, pay later for small business rent. CashFlow pays the landlord the whole month's rent on the due date, and the business repays it in two installments (the 1st and the 15th for rent due on the 1st) plus a fee of 1.5% to 4% of the rent.

This was a startup. It wound down, and the whole product is released here as a build-in-public reference: the owner's app, the API with its underwriting engine and double entry ledger, the scheduled jobs that service the book, the staff console, and the marketing site. MIT licensed.

**No real money moves in this code, and none ever did.** Every bank, payment, capital and identity integration is an interface with a sandbox implementation that is selected by default. The real adapters are skeletons that refuse to run without explicit configuration. No real lending happened through this repository.

## What is in it

- **Cash flow underwriting.** A transparent eight factor scorecard over a year of bank data, knockout rules, expected loss pricing with a fee cap, a limit ladder and exposure caps. Every decision stores the policy version, its inputs and its reasons. See [`apps/api/UNDERWRITING.md`](apps/api/UNDERWRITING.md) and the policy itself in [`apps/api/CREDIT_POLICY.md`](apps/api/CREDIT_POLICY.md).
- **Evals and gates.** A portfolio simulation runs every policy version through the real engine on the same 10,000 synthetic applicants and plays the plans forward a year. No policy change ships unless all eleven gates pass. See [`apps/api/evals/README.md`](apps/api/evals/README.md).
- **Data veracity.** CashFlow reads only data it pulled itself, through read-only OAuth or an aggregator, stored as append-only hashed snapshots, then checks that the data is the business's own, complete and unaltered. No uploaded statements, no bank passwords. See [`apps/api/DATA_CONNECTIONS.md`](apps/api/DATA_CONNECTIONS.md).
- **Servicing.** Balance checks before each debit, a retry schedule, ACH return code handling, a stop-advance on landlord payouts while past due, delinquency buckets, charge-off at 90 days, recoveries and monthly loss provisioning, all as balanced ledger postings.
- **The pass-through plan.** A business declined for capacity can still have CashFlow pay its landlord, free: CashFlow collects the rent first and pays once it settles. After three on time months it is re-underwritten and can graduate to a financed plan.
- **Transparency and notices.** The applicant sees why: principal reasons in plain words with what would change each, and adverse action notices stored append only. See [`COMPLIANCE.md`](COMPLIANCE.md) for what this does and does not settle.
- **Monitoring.** Fraud, payments, portfolio, books and compliance rules raise alerts, and a circuit breaker sends every new approval to a reviewer when the book leaves what the policy was evaluated for.
- **The operations console.** A local staff app for the review queue, alerts, lease changes, screening hits, the live portfolio, customers and the audit log. See [`apps/ops/README.md`](apps/ops/README.md).
- **Dev mode.** 24 personas in every state, a simulated clock that runs the real jobs day by day, and the app in a phone frame at <http://localhost:4100/phone>.

## Run it

```sh
git clone https://github.com/trevorfrese/cashflow.git
cd cashflow
./dev
```

That is the whole setup. It needs Node 22 and Docker, and enables pnpm through corepack if you do not have it. A first run takes one to two minutes, most of it installing dependencies; after that it is up in under ten seconds. On Windows, run it inside WSL.

`./dev` checks your machine and says exactly what to fix if something is missing, installs, writes the local `.env` files with fresh secrets, starts Postgres in Docker, migrates, seeds 24 demo accounts with five months of replayed history, starts everything, and prints a status board:

| What           | Where                         |                                                       |
| -------------- | ----------------------------- | ----------------------------------------------------- |
| The app        | <http://localhost:8099>       | Expo on web. `pnpm dev:mobile` for a phone            |
| Phone view     | <http://localhost:4100/phone> | The app in a phone frame, with a persona picker       |
| API            | <http://localhost:4000>       | OpenAPI at `/docs`                                    |
| Ops console    | <http://localhost:3200>       | Staff side: sign in with a token from `apps/api/.env` |
| Marketing site | <http://localhost:3100>       |                                                       |
| **Dev home**   | <http://localhost:4100>       | Health, personas, the clock, job runs, logs           |

Sign in as `demo@cashflow.local` / `demo-password-123`, or use the dev menu.

### The dev menu

In the app, tap the coin five times (the CashFlow wordmark on the welcome screen), or press <kbd>Ctrl</kbd>+<kbd>`</kbd> on web. Pick who to be: a customer with an active plan and history, one that is delinquent with its landlord payout held, one that was charged off, a landlord change in its cooling-off period, three pass-through customers (current, a missed month, a graduation offer) and one just offered the plan, a decline, a missing bank, an incomplete application, three kinds of referral, an approval for less than the rent, a point of sale that pays out to an account not connected, a Toast seat waiting to be checked, or one of seven fresh applicants whose onboarding is preset to end in a chosen decision. Then move the simulated clock a day, a week, or to the next thing that happens to that business, and watch the jobs pay landlords, collect, age and charge off.

It exists only when the local `.env` files turn it on, which `./dev` does. The API refuses to start with it in production.

### Commands

| Command                          | What it does                                                                |
| -------------------------------- | --------------------------------------------------------------------------- |
| `./dev`                          | Set up and start everything. Ctrl+C stops it                                |
| `./dev help`                     | Every command and flag                                                      |
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

Ports and the database name come from the environment when you need a second copy or a port is taken: `API_PORT`, `MOBILE_PORT`, `OPS_PORT`, `WEB_PORT`, `DEV_HOME_PORT`, `POSTGRES_PORT`, `POSTGRES_DB`, or `DATABASE_URL` for a Postgres you already run.

Also: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm --filter @cashflow/api eval:portfolio` for the evaluation. Working with a coding agent: [`AGENTS.md`](AGENTS.md) has the run, verify, drive and teardown loop.

## How it works

1. A business registers, connects its bank (and optionally its point of sale) through a sandbox, and submits an application.
2. The engine checks the data, scores it, and returns approved, declined, referred to a reviewer, or needs information, with reasons. A decline for capacity alone is offered the free pass-through plan.
3. The business links a lease and starts a rent plan.
4. Thirteen jobs run in a fixed order for each day: screening, lease changes, data refresh, monthly re-underwriting, graduation, returns, aging, next month's periods 30 days ahead, landlord payouts, collections, provisioning, notices, and monitoring.

Every money movement posts a balanced ledger transaction in the same database transaction as the status change. Balances are derived from entries, never stored. The jobs are idempotent. See [`ARCHITECTURE.md`](ARCHITECTURE.md).

## The evaluation, in numbers

The current policy, `cashflow-v4`, on the default run (five seeds of 2,000 synthetic applicants, each plan played for 12 rent periods), from [`apps/api/evals/report.md`](apps/api/evals/report.md):

| Measure                                         | Value                 |
| ----------------------------------------------- | --------------------- |
| Gates passed                                    | 11 of 11              |
| Approved on usable terms                        | 39.9% of applicants   |
| Referred to a reviewer                          | 3.7%                  |
| Bad rate (30 days past due or charged off)      | 3.7%                  |
| Net loss                                        | 19 bps of rent volume |
| Net margin                                      | 79 bps of rent volume |
| AUC of the score, every scored honest applicant | 0.873                 |
| Fraud applicants approved, after review         | 1.6%                  |

**The population is synthetic.** These numbers show that the policy, the servicing rules and the unit economics are coherent with each other under the simulation's assumptions. They are not a forecast of how real businesses would perform, and the policy would need recalibrating on real outcomes before any real capital.

## Repo map

```
apps/api          Fastify API: Prisma + Postgres, underwriting engine, veracity checks, ledger, servicing, jobs, monitoring
apps/api/evals    Portfolio evaluation: report, gates, baseline
apps/mobile       Expo app for business owners: onboarding, connections, decisions, rent plan
apps/ops          Next.js operations console for staff. Local only, never deployed
apps/web          Next.js one page marketing site
packages/shared   Zod schemas, enums, reason catalog, installment math, brand tokens
scripts/dev       The ./dev supervisor, dev home page and phone view
docker/           Postgres init SQL
```

Stack: pnpm workspaces, Turborepo, Node 22, TypeScript strict, Vitest; Fastify 5, Prisma 7 on Postgres, Zod validated routes with OpenAPI; Expo with Expo Router and TanStack Query; Next.js.

## Docs

| Document                                                       | What it covers                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [`ARCHITECTURE.md`](ARCHITECTURE.md)                           | System map, provider seams, data model, ledger postings, payment lifecycle, jobs, monitoring, security |
| [`apps/api/CREDIT_POLICY.md`](apps/api/CREDIT_POLICY.md)       | The credit policy: eligibility, escalation, authority, servicing, provisioning, change control         |
| [`apps/api/UNDERWRITING.md`](apps/api/UNDERWRITING.md)         | The underwriting mechanics and the evidence for each number                                            |
| [`apps/api/DATA_CONNECTIONS.md`](apps/api/DATA_CONNECTIONS.md) | How data is obtained, tokens, snapshots                                                                |
| [`apps/api/evals/README.md`](apps/api/evals/README.md)         | The portfolio evaluation, its gates, assumptions and limits                                            |
| [`COMPLIANCE.md`](COMPLIANCE.md)                               | What the system does for compliance, what is unresolved, and the questions for counsel                 |
| [`apps/api/README.md`](apps/api/README.md)                     | API routes, jobs, sandbox keywords, operator routes, dev tools                                         |
| [`apps/ops/README.md`](apps/ops/README.md)                     | The operations console                                                                                 |
| [`apps/mobile/README.md`](apps/mobile/README.md)               | The app                                                                                                |
| [`apps/web/README.md`](apps/web/README.md)                     | The marketing site                                                                                     |
| [`apps/api/DEPLOY.md`](apps/api/DEPLOY.md)                     | Docker, Fly.io and Render notes                                                                        |
| [`AGENTS.md`](AGENTS.md)                                       | Running and driving the system from a coding agent, personas, failure signatures                       |
| [`CLAUDE.md`](CLAUDE.md)                                       | Conventions                                                                                            |

Nothing in this repository is legal advice.

## License

[MIT](LICENSE)

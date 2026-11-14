# CashFlow

Buy now, pay later for small business rent. CashFlow pays the landlord the whole month's rent on the due date, and the business repays it in two installments (the 1st and the 15th for rent due on the 1st) plus a fee of 1.5% to 4% of the rent. A business that cannot qualify can still have CashFlow pay its landlord for free, and graduate to the financed plan once it has a record.

CashFlow was a startup. It wound down, and the whole product is released here, MIT licensed, as a build-in-public reference: the owner's app, an API with a cash flow underwriting engine and a double entry ledger, the scheduled jobs that service the book, the staff console, and the marketing site.

**No real money moves in this code, and none ever did.** Every bank, payment, capital and identity integration is an interface with a sandbox implementation selected by default. The real adapters are skeletons that refuse to run without explicit configuration.

## What's inside

- **Cash flow underwriting.** An eight factor scorecard over a year of bank data, knockout rules, expected loss pricing with a fee cap, a limit ladder and exposure caps. Every decision stores its policy version, inputs and reasons. [UNDERWRITING.md](apps/api/UNDERWRITING.md)
- **A written credit policy** with an escalation matrix, reviewer authority, servicing and reserve rules, and change control. [CREDIT_POLICY.md](apps/api/CREDIT_POLICY.md)
- **Evals that gate every policy change.** Each policy version runs through the real engine on 10,000 synthetic applicants and plays a year forward. Nothing ships unless all 11 gates pass, and CI checks it. [evals/README.md](apps/api/evals/README.md)
- **Data veracity.** CashFlow reads only data it pulled itself, through read-only OAuth or an aggregator, stored as append-only hashed snapshots. No uploaded statements, no bank passwords. [DATA_CONNECTIONS.md](apps/api/DATA_CONNECTIONS.md)
- **Servicing as ledger postings.** Balance checks before each debit, retries, ACH return codes, payout holds while past due, delinquency buckets, charge-off at 90 days, recoveries and monthly provisioning. [ARCHITECTURE.md](ARCHITECTURE.md)
- **The pass-through plan.** A business declined for capacity can have CashFlow pay its landlord free: rent is collected first and paid once it settles. After three on time months it is re-underwritten and can graduate. [CREDIT_POLICY.md, section 10](apps/api/CREDIT_POLICY.md#10-the-pass-through-plan-and-graduation)
- **Reasons and notices.** Applicants get principal reasons in plain words with what would change each, and adverse action notices are stored append only. [COMPLIANCE.md](COMPLIANCE.md) says what this does and does not settle.
- **Monitoring.** Fraud, payments, portfolio, books and compliance rules raise alerts. A circuit breaker sends every new approval to a reviewer when the book drifts outside what the policy was evaluated for.
- **The operations console.** A local staff app: review queue, alerts, lease changes, screening, late plans, portfolio, ledger, jobs, customers, audit log, policy, and tighten-only admin controls. [apps/ops/README.md](apps/ops/README.md)
- **Dev mode.** 24 personas in every state, a simulated clock that runs the real jobs day by day, and the app in a phone frame. [AGENTS.md](AGENTS.md)

## Run it

```sh
git clone https://github.com/trevorfrese/cashflow.git
cd cashflow
./dev
```

That is the whole setup. It needs Node 22 and Docker, and enables pnpm through corepack if needed. The first run takes one to two minutes (mostly installing); after that it is up in under ten seconds. On Windows, run it inside WSL.

`./dev` checks your machine and says what to fix, installs, writes local `.env` files with fresh secrets, starts Postgres in Docker, migrates, seeds 24 demo accounts with five months of replayed history, starts everything, and prints a status board:

| What               | Where                         | Notes                                                 |
| ------------------ | ----------------------------- | ----------------------------------------------------- |
| The app            | <http://localhost:8099>       | Expo on web. `pnpm dev:mobile` for a phone            |
| Phone view         | <http://localhost:4100/phone> | The app in a phone frame, with a persona picker       |
| API                | <http://localhost:4000>       | OpenAPI at `/docs`                                    |
| Operations console | <http://localhost:3200>       | Staff side: sign in with a token from `apps/api/.env` |
| Marketing site     | <http://localhost:3100>       |                                                       |
| **Dev home**       | <http://localhost:4100>       | Health, personas, the clock, job runs, logs           |

Sign in as `demo@cashflow.local` / `demo-password-123`, or use the dev menu.

**The dev menu.** In the app, tap the coin five times (the wordmark on the welcome screen), or press <kbd>Ctrl</kbd>+<kbd>`</kbd> on web. Pick a persona: an active plan, a delinquent or charged off customer, a landlord change on hold, pass-through customers, declines, referrals, counter offers, or a fresh applicant preset to end in a chosen decision. Then move the simulated clock a day, a week, or to that business's next event, and watch the jobs pay landlords, collect, age and charge off. The menu exists only when the local `.env` files turn it on, and the API refuses to start with it in production.

The commands you will use most:

| Command                  | What it does                                             |
| ------------------------ | -------------------------------------------------------- |
| `./dev`                  | Set up and start everything. Ctrl+C stops it             |
| `./dev --detach`         | The same in the background, returns when healthy         |
| `./dev status`           | The status board again (`--json` for scripts)            |
| `./dev advance --days 7` | Move the simulated clock, running every job for each day |
| `./dev stop`             | Stop what `./dev` started                                |

`./dev help` lists every command and flag; the full table is in [AGENTS.md, "Dev commands"](AGENTS.md#dev-commands). Checks: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## How it works

1. **Apply.** A business registers, connects its bank (and optionally its point of sale) through a sandbox, and submits an application.
2. **Decide.** The engine checks the data is the business's own, scores it, and returns approved, declined, referred to a reviewer, or needs information, with reasons. A decline for capacity alone is offered the free pass-through plan.
3. **Start a plan.** The business links a lease and opens a rent plan, rechecked against the exposure and pool rules on the day.
4. **Pay the landlord.** On the due date CashFlow pays the whole rent from its capital pool, unless a hold applies (past due, frozen, a landlord change cooling off).
5. **Collect.** Installments are debited after a balance check, retried on days 3 and 6, and reversed if the bank returns them.
6. **Service the book.** Thirteen idempotent jobs run in a fixed order every day: screening, lease changes, data refresh, monthly re-underwriting, graduation, returns, aging, next month's periods, payouts, collections, provisioning, notices, and monitoring.
7. **Keep the books honest.** Every money movement posts a balanced ledger transaction in the same database transaction as the status change. Balances are derived from entries, never stored.

The detail is in [ARCHITECTURE.md](ARCHITECTURE.md).

## The evaluation in numbers

The current policy, `cashflow-v5`, on the default run (five seeds of 2,000 synthetic applicants, each plan played for 12 rent periods), from [`apps/api/evals/report.md`](apps/api/evals/report.md):

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
| Pass-through graduates (bad rate, margin)       | 227 (8.4%, 72 bps)    |

**The population is synthetic.** These numbers show that the policy, the servicing rules and the unit economics are coherent with each other under the simulation's assumptions. They are not a forecast of how real businesses would perform, and the policy would need recalibrating on real outcomes before any real capital.

## Status: what is built and what is not

Built and tested end to end in the sandbox: onboarding, underwriting with veracity checks, financed and pass-through plans, graduation, servicing through charge-off and recovery, the ledger, monitoring, adverse action notices, the operations console, and the dev tooling.

Not done, and needed before any real customer:

| Area            | Gap                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendors         | Every bank, platform, payments, capital and identity provider is a sandbox. No real adapter has been exercised, and identity and capital have none  |
| Legal           | No counsel has signed off. [COMPLIANCE.md](COMPLIANCE.md) lists 27 open questions for counsel                                                       |
| State law       | No state commercial financing disclosures, no lending or broker licenses, no usury analysis                                                         |
| Notices         | Adverse action notices are delivered in the app only: no email or mail delivery and no E-SIGN consent flow. The creditor details are placeholders   |
| Fair lending    | No disparate impact or override pattern testing                                                                                                     |
| AML             | No BSA/AML program or suspicious activity reporting procedure. Whether one is required is open (COMPLIANCE.md question 14)                          |
| Calibration     | The scorecard weights, cutoff, PD table and reserve rates were set on synthetic data only. Periodic re-underwriting is not in the evaluation        |
| Graduates       | Priced on their own PD since `cashflow-v5`, but they still go bad about twice as often as first time approvals at the same scores                   |
| Operator access | The API and console use a shared role token per team with a typed name. No per-person credentials or SSO                                            |
| Mobile          | Exercised on Expo web and in the phone frame. Never run as a native build on an iOS or Android simulator or device                                  |
| Operations      | Alerts show in the console but are not assigned to anyone or pushed anywhere (no email, chat or paging). No outside heartbeat watches the scheduler |

## Repo map

```
apps/api          Fastify API: Prisma + Postgres, underwriting, veracity, ledger, servicing, jobs, monitoring
apps/api/evals    Portfolio evaluation: report, gates, baseline
apps/mobile       Expo app for business owners: onboarding, connections, decisions, rent plan
apps/ops          Next.js operations console for staff. Local only, never deployed
apps/web          Next.js one page marketing site
packages/shared   Zod schemas, enums, reason catalog, installment math, brand tokens
scripts/dev       The ./dev supervisor, dev home page and phone view
docker/           Postgres init SQL
.github/          CI: checks and smoke on every push, the strict portfolio eval nightly
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
| [`AGENTS.md`](AGENTS.md)                                       | Every `./dev` command, running the system from a coding agent, personas, failure signatures            |
| [`CLAUDE.md`](CLAUDE.md)                                       | Conventions                                                                                            |

Nothing in this repository is legal advice.

## License

[MIT](LICENSE)

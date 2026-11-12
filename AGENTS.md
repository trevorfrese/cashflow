# AGENTS.md

How a coding agent runs, verifies, drives and tears down this project without a terminal UI or a browser. Project conventions (layout, money rules, style) are in [CLAUDE.md](CLAUDE.md): read it first. This file does not repeat them.

## Hard rules

- Sandbox only. Never add code that can move real funds, and never make a real payment, bank or capital integration active by default.
- No secrets in git. `./dev` generates local secrets into gitignored `.env` files. Do not print them. `./dev status` says where they are, not what they are.
- No em dashes anywhere. `pnpm check:copy` enforces it.
- Shared schemas first: an API input or output is a Zod schema in `packages/shared` before it is used on either side.
- Money is integer cents, rates are basis points, calendar dates are `YYYY-MM-DD`.
- Do not change underwriting policy, eval gates, servicing rules or monitoring thresholds unless that is the task.
- Ask the owner before adding a paid service or doing something hard to reverse.

## The loop

```sh
./dev --detach            # bring everything up in the background. Returns when healthy, exit 1 with the reason if not
./dev status --json       # verify: services, ports, pids, health, database, simulated date, log paths
./dev smoke               # verify end to end: the happy path over HTTP. Exit 1 and the failing response on any failed step
./dev personas --json     # drive: who you can be
./dev session delinquent --token    # an access token for curl (stdout only; a local test token)
./dev advance --next delinquent     # move the simulated clock to that persona's next event
./dev reset               # rebuild the demo data and put the clock back
./dev stop                # tear down what ./dev started
```

Without a TTY `./dev` is non-interactive on its own: no prompts, no colors, no spinners, services detached. `--non-interactive` forces it. `--timeout <seconds>` bounds the wait (default 240). `./dev wait` blocks until healthy. `./dev --only api` is enough for API work and for `smoke`.

A second copy beside a running one (for example to test from a fresh clone) needs its own ports and database:

```sh
API_PORT=4500 MOBILE_PORT=8199 OPS_PORT=3299 WEB_PORT=3199 DEV_HOME_PORT=4199 POSTGRES_DB=cashflow_scratch ./dev --detach
```

Set the same variables for every later command against that copy.

Calling the API as a persona:

```sh
TOKEN=$(./dev session active-plan --token 2>/dev/null)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/v1/businesses
```

Operator routes need `ADMIN_API_TOKEN` from `apps/api/.env` and an `X-Admin-Actor` header. Read the token from the file into a variable; do not echo it.

## Logs

`.dev/logs/<service>.log` for `api`, `mobile`, `ops`, `web`, plus `setup.log` (install, migrate, seed output) and `supervisor.log`. `./dev logs api --tail 100` prints one without ANSI codes. State is in `.dev/state.json`. All of `.dev/` is gitignored.

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build && npx prettier --check .
```

One test file:

```sh
pnpm --filter @cashflow/api exec vitest run src/routes/dev.int.test.ts     # integration: needs Postgres up
pnpm --filter @cashflow/api exec vitest run --project unit src/dates.test.ts
pnpm --filter @cashflow/mobile exec vitest run src/dev/taps.test.ts
node --test scripts/dev/test/cli.test.mjs
```

Integration tests (`*.int.test.ts`) use the `cashflow_test` database (`DATABASE_URL_TEST`), which they wipe. They never touch the dev database.

## Migrations

Prisma, in `apps/api/prisma`. Write the SQL by hand in a new folder `prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`, timestamped later than the newest one, and update `schema.prisma` to match. Then:

```sh
pnpm --filter @cashflow/api exec prisma migrate deploy
pnpm --filter @cashflow/api exec prisma generate
```

Do not use `prisma migrate dev` or `prisma migrate reset` from an agent: they prompt and can drop data. `LedgerEntry`, `LedgerTransaction` and `AuditEvent` have triggers that reject UPDATE and DELETE, so nothing may rewrite those rows. `./dev` applies pending migrations on every start.

## Personas

Defined in `apps/api/src/dev/personas.ts`. Each is its own login (password `demo-password-123`) with one business.

| Key                      | Business             | What it demonstrates                                                                                     |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `active-plan`            | Blue Door Bakery     | Approved, a $10,000 plan, three months paid on time. Login `demo@cashflow.local`                         |
| `delinquent`             | Cedar Street Cycles  | Debits failing for a month, plan delinquent, latest landlord payout held                                 |
| `charged-off`            | Juniper Print Studio | Written off at 90 days past due, plan closed, one payment recovered                                      |
| `landlord-change`        | Alder & Ash Florist  | Landlord payout change in its cooling-off period, payout held                                            |
| `pass-through`           | Ridgeline Coffee     | Declined (too new), on the free pass-through plan, two months collected early and paid on time           |
| `pass-through-missed`    | Foundry Bike Works   | Pass-through: one month paid, the next not collected, so the landlord was not paid and the owner told    |
| `graduation-offer`       | Willow & Wren Bakery | Three on time pass-through months, re-underwritten with payment history, offered a financed plan         |
| `pass-through-offer`     | Larkspur Tailoring   | Just declined (four months in business) with a lease linked: start the free plan from the decision       |
| `declined`               | Northside Barbers    | Declined with principal reasons (overdrafts, too new, rent too high) and its adverse action notice       |
| `needs-info`             | Lakeview Yoga        | Applied with no bank linked                                                                              |
| `incomplete`             | Harbor Light Pilates | Applied 14 days ago with no bank linked; sent a notice of incompleteness with a date to respond by       |
| `manual-review`          | Tidewater Sign Works | Referred 34 days ago on a tax id mismatch, never reviewed: past the deadline                             |
| `identity-review`        | Meridian Supply      | Owner is a possible watchlist match: in review, nothing can be advanced                                  |
| `counter-offer`          | Sellwood Books       | Approved for less than the lease rent, so the plan cannot start                                          |
| `payout-account`         | Fernwood Outfitters  | Active plan; a Shopify connection pays out to an account not connected. The owner is asked to connect it |
| `ownership-review`       | Pinecrest Ceramics   | Referred: the bank reports the account as held by another business                                       |
| `toast-seat`             | Saltwater Taqueria   | Toast read-only seat invited and waiting: the steps, then Check connection                               |
| `fresh-approved`         | none yet             | Onboarding preset to end in an approval                                                                  |
| `fresh-declined`         | none yet             | Onboarding preset to end in a decline for overdrafts                                                     |
| `fresh-referred`         | none yet             | Onboarding preset to end in manual review (tax id ending 0000)                                           |
| `fresh-counter-offer`    | none yet             | Onboarding preset to end in an approval below the requested rent                                         |
| `fresh-payout-elsewhere` | none yet             | Preset: Square through the sandbox consent page, paying out elsewhere: needs info                        |
| `fresh-ownership`        | none yet             | Preset: a bank account held by another business: referred                                                |
| `fresh-toast`            | none yet             | Preset: Toast through a read-only seat: approved with two verified sources                               |

Other logins are `<key>@cashflow.local`. `active-plan`, `delinquent`, `charged-off`, `landlord-change`, `pass-through`, `pass-through-missed` and `graduation-offer` are months of replayed ledger history: they are rebuilt only by a full reset (`./dev reset`). The rest can be rebuilt one at a time (`./dev reset --persona <key>`), as a new account with new ids.

The clock is one clock for the whole book. Advancing it for one persona moves time for all of them, because the jobs run for every business. `./dev reset` is how you get back.

### Adding a persona

1. Append a definition to `PERSONAS` in `apps/api/src/dev/personas.ts`: key, title, group and section, what it demonstrates, screens, login email, landing screen, and a builder (`fresh`, `instant`, or `history`). Reuse the helpers in `apps/api/src/dev/builders.ts`. Make the builder throw if the engine did not produce the state the persona is for.
2. Add its key and expected state label to the tables in `apps/api/src/dev/personas.test.ts` and `apps/api/src/routes/dev.int.test.ts`.
3. Add a row to the table above.

Nothing in the app, the CLI or the dev home page needs to change: they list whatever the API returns.

## Failure signatures

| What you see                                                                | Cause and fix                                                                                                         |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `Stopped: Docker is installed but its daemon is not running`                | Start Docker, run `./dev` again                                                                                       |
| `Port 4000 is needed for API and is in use by pid ...`                      | Another program has the port. Stop it, or `API_PORT=4001 ./dev`. A process from this checkout is reused, not an error |
| `Something is listening on port 5432 but it is not this project's Postgres` | Another Postgres. `POSTGRES_PORT=5433 ./dev` and match `DATABASE_URL` in `apps/api/.env`                              |
| `The API ... is running without dev tools, so /v1/dev/... does not exist`   | `ENABLE_DEV_TOOLS=true` is missing from `apps/api/.env`, or the API was started with `--no-dev-tools`. Restart it     |
| `Refusing to start: ENABLE_DEV_TOOLS=true with NODE_ENV=production`         | By design. Dev tools never run in production                                                                          |
| `Refusing to start: ENABLE_ADMIN=true needs ADMIN_API_TOKEN`                | `apps/api/.env` is incomplete. Delete it and run `./dev` to regenerate, or add a 32+ character token                  |
| `PERSONA_NEEDS_FULL_RESET` (409)                                            | That persona is replayed ledger history. `./dev reset`                                                                |
| `DEV_BUSY` (409)                                                            | A reset or clock advance is already running. Wait and retry                                                           |
| Seed fails with `Expected ... to be approved, got ...`                      | The sandbox bank is anchored on today's date and a persona's inputs drifted. See `apps/api/src/dev/personas.ts`       |
| Integration tests fail to connect                                           | Postgres is down or `DATABASE_URL_TEST` points at the wrong port. `./dev --only api --detach` creates the database    |
| `429 RATE_LIMITED` while scripting                                          | 300 requests a minute per address, 10 on auth routes. Use `./dev session` (not rate limited) instead of logging in    |
| Expo web serves a blank page after a crash                                  | `./dev logs mobile --tail 80`. Restart with `./dev stop && ./dev --detach`                                            |

---
name: run
description: Launch, verify, drive and stop the CashFlow dev system (API, Expo web app, ops console, marketing site, Postgres) with the ./dev command. Use when asked to run or start the app, check that a change works in the running system, walk a persona or underwriting flow, move the simulated clock, or tear the system down.
---

# Run CashFlow

Everything goes through `./dev` at the repo root. It needs no TTY and no browser.

## Launch

```sh
./dev --detach
```

Returns when every service is healthy, or exits 1 with the reason and the end of the failing log. `./dev --only api --detach` is enough for API work. If a copy is already running from this checkout, `./dev` reuses it.

## Verify

```sh
./dev status --json     # .healthy, .services[].health, .postgres, .clock, .logs.files
./dev smoke             # scripted happy path over HTTP. Exit 1 on any failed step, with the response
```

`smoke` moves the simulated clock about two weeks forward. Add `--reset` to rebuild the demo data afterwards.

For a change in the app itself, open http://localhost:8099 with a browser tool. The dev menu opens with Ctrl+`(or five quick taps on the coin).`http://localhost:8099/?devPersona=<key>` signs the app in as a persona directly. The dev home page at http://localhost:4100 shows health, personas, job runs and logs.

## Drive

```sh
./dev personas --json               # keys, what each demonstrates, state now, next event
./dev session <key> --token         # access token on stdout, for curl -H "Authorization: Bearer ..."
./dev advance --days 7              # or --to YYYY-MM-DD, or --next <key>
./dev reset --persona <key>         # rebuild one persona (not the four with ledger history)
./dev reset                         # rebuild everything, clock back to the real date
./dev logs api --tail 100           # also mobile, ops, web, setup, supervisor
```

## Stop

```sh
./dev stop
```

Stops only what `./dev` started. Postgres stays up in Docker.

See `AGENTS.md` for personas, failure signatures, running one test file, and migrations.

# @cashflow/mobile

The CashFlow app for business owners, built with Expo and Expo Router. Sign in, set up a
business, connect a bank account, get an instant cash flow based underwriting decision,
link a lease, and manage the rent plan: next payment, pay now, payment history.

Everything runs against the local API in sandbox mode.

The look comes from the CashFlow design canvas: jet-age poster colors with neo-brutalist
lines (3px Ink borders, hard offset shadows, Archivo set wide). Tokens live in
`packages/shared/src/brand.ts` and `src/theme.ts`; the Archivo cuts in `assets/fonts` are
instanced from the Google Fonts variable font (SIL Open Font License, see `OFL.txt` there).

## Run

```sh
./dev                           # from the repo root: everything, with the app on http://localhost:8099
pnpm dev:mobile                 # for a phone or simulator: press i (iOS) or a (Android)
```

Copy `.env.example` to `.env` if the API is not on `http://localhost:4000`. On a physical
device use your computer's LAN address; on the Android emulator use `http://10.0.2.2:4000`.

Sign in with the demo account (`demo@cashflow.local` / `demo-password-123`) or tap
"Use the demo account": Blue Door Bakery, with an active plan and three months of history.
Every other state has its own login, reached through the dev menu.

## Dev menu

Hidden unless `EXPO_PUBLIC_DEV_TOOLS=true` (which `./dev` writes into `.env`) and the API runs
with `ENABLE_DEV_TOOLS=true`. Open it with five quick taps on the coin in the home title, or
on the CashFlow wordmark on the welcome screen (that screen has no coin), or with Ctrl+`on
web. It is a full screen modal: pick a persona to sign in as, move the simulated clock (one
day, one week, to the persona's next event) and read what changed, reset the persona or
everything, sign out, and jump to the ops console or the dev home page.

Fresh applicant personas prefill the business form, preselect the sandbox bank scenario, and
fill in months and rent, each with a notice saying so. Switching persona replaces the session
through `replaceSession` in `src/dev/session.ts`, which empties the query cache before the
app learns who the new user is. With the flag off `DevToolsProvider` and `DevTapTarget`
return their children untouched: no listener, no request, no menu.

## Layout

```
app/                 Expo Router routes
  (auth)/            sign-in, register
  (tabs)/            home, history, settings
  settings/          rent (cadence, pause), businesses, bank accounts
  business/new       business profile, tax id last 4, one owner
  bank/connect       sandbox bank picker (Plaid Link in production)
  application/new    underwriting application
  application/[id]   decision: score, grade, terms, reasons, cash flow summary
  lease/new          landlord, property, rent, payout details
  plan/new           installment cadence and first period preview
src/
  components/        Button, TextField, Card, Pill, Screen, TabBar, ScoreGauge, CoinMark, ...
  lib/api.ts         typed fetch with Zod validation and token refresh
  lib/auth.tsx       session provider backed by expo-secure-store
  lib/queries.ts     TanStack Query hooks, one per endpoint
  lib/stage.ts       where a business is in the journey, drives the home screen
  lib/forms.ts       money and date parsing for inputs
  dev/               the dev menu: flag, tap detector, persona grouping, session switch, UI
  theme.ts           colors, fonts, type scale, hard shadows, from the shared brand tokens
```

## Sandbox bank scenarios

The bank connect screen lets you pick the account history the fake bank returns so every
underwriting outcome can be demoed: healthy, growing, seasonal, thin margins, existing
debt, volatile, low balance, overdrafts, declining, new business. See
`apps/api/UNDERWRITING.md` for what each one does to the decision.

## Connected data

`Settings, Connected data` (and the dev landing for the data connection personas) lists every
connection: how it was made ("You approved read-only access on Square's site. We never see
your password."), its health, what it verified, and any action the owner needs to take, which
also shows on Home. Connecting a point of sale:

- Square, Shopify, Stripe, Clover: `Connect a point of sale` starts the OAuth connection and
  opens the sandbox stand-in for the platform's consent page, where you pick what the sandbox
  account looks like (healthy, pays out elsewhere, another business, new account, sales not
  paid out) and approve or decline. It mirrors a real redirect: the page hands back a code
  and the app finishes the connection.
- Toast: the seat instructions screen shows CashFlow's own reports user and the steps, then
  `Check connection`.

The keywords behind the sandbox choices are in `apps/api/README.md`, "Sandbox data connections".

## Sandbox identity keywords

The business profile asks for the last four digits of the tax id and one owner (name, title,
ownership share). The full tax id, a date of birth, or an id number is never asked for. The
API verifies and screens them against a sandbox identity provider that passes everything
unless a name carries a keyword:

- Tax id last 4 of `0000`, or `mismatch` in the business or owner name: the application goes
  to review instead of being approved.
- `unverifiable` in the business or owner name: the application is declined, with a message
  to check the details or contact support.
- `watchlist` or `sanctioned` in the business, owner, or landlord name: the application goes
  to review, and a running plan has its rent payments held.

The app is told only that the account is under review (`Business.verification`,
`LandlordPayout.heldMessage`), never why. The full table is in `apps/api/README.md`.

## Tests

```sh
pnpm --filter @cashflow/mobile test        # vitest: form parsing, stage derivation, dev menu logic
pnpm --filter @cashflow/mobile typecheck
pnpm --filter @cashflow/mobile lint
```

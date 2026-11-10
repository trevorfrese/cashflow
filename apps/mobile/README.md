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
pnpm setup                      # once: Postgres, migrations, demo data (from the repo root)
pnpm --filter @cashflow/api dev # terminal 1
pnpm dev:mobile                 # terminal 2, then press i (iOS), a (Android), or w (web)
```

Copy `.env.example` to `.env` if the API is not on `http://localhost:4000`. On a physical
device use your computer's LAN address; on the Android emulator use `http://10.0.2.2:4000`.

Sign in with the demo account (`demo@cashflow.local` / `demo-password-123`) or tap
"Use the demo account". It owns three businesses that show the three underwriting outcomes.

## Layout

```
app/                 Expo Router routes
  (auth)/            sign-in, register
  (tabs)/            home, history, settings
  business/new       business profile
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
  theme.ts           colors, fonts, type scale, hard shadows, from the shared brand tokens
```

## Sandbox bank scenarios

The bank connect screen lets you pick the account history the fake bank returns so every
underwriting outcome can be demoed: healthy, growing, seasonal, thin margins, existing
debt, volatile, low balance, overdrafts, declining, new business. See
`apps/api/UNDERWRITING.md` for what each one does to the decision.

## Tests

```sh
pnpm --filter @cashflow/mobile test        # vitest: form parsing, stage derivation
pnpm --filter @cashflow/mobile typecheck
pnpm --filter @cashflow/mobile lint
```

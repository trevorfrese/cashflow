# CashFlow

Buy now, pay later for small business rent. Open source.

CashFlow pays a small business's landlord the full rent on the due date, and the business pays CashFlow back in smaller installments over the month (two by default). This was a venture-backed startup idea that I am winding down and releasing in public as a complete, runnable reference implementation.

There is no real capital behind this repo. Every component that touches money or risk runs against a mock provider by default and never moves real funds. The point is to show the whole system end to end: underwriting, lease linking, landlord payouts, installment collection, and a double-entry ledger, with clean seams where a real capital source, bank data provider, and payment rails would plug in.

## What is here

| Path | What it is |
| --- | --- |
| `apps/web` | Marketing site for splitmylease.com. Next.js static export on GitHub Pages. |
| `apps/mobile` | Expo app. Sign up, onboard a business, apply for underwriting, link a lease, track your rent plan. |
| `apps/api` | Fastify API. Postgres via Prisma, Zod validation, scheduled payout and collection jobs. |
| `packages/shared` | Zod schemas, types, and pure installment math shared by all three. |

## Status

Scaffolding in progress. The sections below will fill in as each phase lands: setup, architecture diagram, provider interfaces, and lessons learned from running this as a business.

## Contributing

Issues and pull requests are welcome. Read `CLAUDE.md` for repo layout, commands, and conventions. Never commit secrets or real financial data.

## License

[MIT](LICENSE)

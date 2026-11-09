# CashFlow

**Buy now, pay later for small business rent.** CashFlow pays a small business's landlord the full rent on the due date, and the business pays it back in two smaller installments over the month.

CashFlow was a startup. I am winding it down and releasing the complete product in public: the mobile app, the API, the underwriting and ledger logic, and the marketing site, all MIT licensed and runnable on a laptop. The repo is a reference for anyone who wants to build embedded finance for small businesses, or who is curious how a rent financing product actually works end to end.

No real money moves in this code. Every component that touches funds or risk runs against a mock provider by default. Read on for how a real capital source would plug in.

## The problem

Rent is the largest fixed cost for most small businesses, and it is due in one lump sum on the first of the month. Revenue does not arrive that way. A restaurant, a salon, a gym, or a retail shop earns money every day and pays its people every week or two. The result is a predictable squeeze at the start of each month: owners drain their operating account to make rent, then spend the next two weeks short on cash for inventory, payroll, and surprises.

The usual fixes are poor. Credit cards carry high rates and most landlords will not take them. Merchant cash advances are expensive and opaque. A bank line of credit takes months to open and is out of reach for most businesses under five years old. So owners pay late and eat the fee, borrow from friends, or simply keep less inventory than they should.

Landlords feel this too. Late rent means collections calls, uncertainty about their own mortgage payment, and strained relationships with tenants they would rather keep.

## What CashFlow does

1. **A business applies in minutes** from the mobile app. It shares basic information, connects its bank account, and gets an underwriting decision in seconds, not weeks.
2. **It links a lease**: landlord, rent amount, due date, and where the landlord gets paid.
3. **On the due date, CashFlow pays the landlord in full.** The landlord sees a normal on-time payment. Nothing changes on their side.
4. **The business repays in two installments** over the month, timed to when revenue actually comes in, plus a small flat fee per month.

The business gets smoother cash flow and never pays a late fee. The landlord gets paid in full, on time, every month. CashFlow earns a transparent fee that is a fraction of what a card, an advance, or a late penalty would cost.

## Where the money comes from

Fronting rent for thousands of businesses takes capital, and this is the part of the business that matters most.

In the live product, landlord payouts are funded from a dedicated capital pool, typically a credit facility from a specialty lender or a fund set up for this purpose. The economics are attractive for a capital partner:

- **Short duration.** Each advance is outstanding for two to four weeks. Capital turns over roughly twice a month, so a modest pool supports a large volume of rent.
- **Small, predictable fee per turn.** A fee of a few percent of rent per month compounds into a strong annualized return for the pool while still being far cheaper than the alternatives for the business.
- **Underwriting on real bank data.** Decisions use connected bank balances and cash flow, not just stated revenue, and limits are set relative to verified monthly deposits.
- **Collections aligned to deposits.** Installments are drawn from the same operating account that receives the business's revenue, shortly after it arrives.

In this repository, that capital pool is a mock: a database-backed fund that fronts payouts and is replenished by installment collections, with every movement recorded in a double-entry ledger. The `CapitalProvider` interface marks the exact seam where a real facility, fund, or balance sheet would connect. The same is true for bank data (Plaid-shaped) and payment rails (Stripe-shaped). Swapping a provider is a configuration change, not a rewrite.

## Why open source

Most fintech products are a black box. The interesting parts, underwriting rules, payment scheduling, ledgering, provider abstractions, are exactly the parts nobody shares. Releasing CashFlow whole is more useful than another blog post about lessons learned, and it gives the idea a chance to live on with someone who has the capital relationships to run it.

If you fork it and take it to market, I would love to hear about it.

## Try it locally

You need Node 22, pnpm, and Docker.

```sh
git clone https://github.com/trevorfrese/cashflow.git
cd cashflow
pnpm install
pnpm setup      # starts Postgres, runs migrations, seeds demo data
pnpm dev        # API on :4000, marketing site on :3000
pnpm dev:mobile # Expo dev server, in a second terminal
```

Sign in to the mobile app with the seeded demo account to walk through an approved business with a live rent plan and payment history.

## Repository tour

- `apps/mobile` is the Expo app a business owner uses.
- `apps/api` is the Fastify service behind it, with the underwriting, scheduling, ledger, and provider code.
- `apps/web` is the one page marketing site at splitmylease.com.
- `packages/shared` holds the schemas and installment math shared across all three.

`ARCHITECTURE.md` explains the provider interfaces, the ledger, and the rent payment lifecycle in detail. `CLAUDE.md` covers repo conventions and commands for contributors.

## Contributing

Issues and pull requests are welcome. Keep in mind the one hard rule: nothing in this repo may move real money by default.

## License

[MIT](LICENSE)

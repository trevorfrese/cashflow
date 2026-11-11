# Portfolio evals

A simulation that answers one question before any credit or servicing rule changes: on a
book of plausible applicants, does this policy make money, and does it stay inside the risk
appetite?

It draws a synthetic population, runs every applicant through the real `decide()` in
`src/underwriting/engine.ts`, opens a plan for each approval, and plays the plans forward day
by day against simulated bank accounts and a finite capital pool. Nothing touches the
database, the network, or a clock. The same seed always gives the same report.

## Run it

```sh
pnpm --filter @cashflow/api eval:portfolio                    # default run, about 10 seconds
pnpm --filter @cashflow/api eval:portfolio --n 10000          # tighter estimates, under a minute
pnpm --filter @cashflow/api eval:portfolio --seed 7 --horizon 6 --out /tmp/evals
pnpm --filter @cashflow/api eval:portfolio --strict           # exit 1 if any gate fails
```

| Flag        | Default          | Meaning                                         |
| ----------- | ---------------- | ----------------------------------------------- |
| `--n`       | 2000             | Number of applicants                            |
| `--seed`    | 1                | Seed for the population and every bank account  |
| `--horizon` | 12               | Rent periods each approved plan is played       |
| `--out`     | `apps/api/evals` | Directory for the output files                  |
| `--strict`  | off              | Exit non zero when a gate fails (for CI, later) |

Output:

- `report.md`: headline numbers, gates, cuts by grade, score band, archetype, and industry,
  the stress table, the pool by month, and the illustrative challengers.
- `report.json`: every metric for base, mild stress, and severe stress.
- `baseline.json`: headline metrics and gate results. Written only by a run with the default
  `--n`, `--seed`, and `--horizon`, and checked in, so a policy change shows up as a diff.

The command exits 0 when gates fail unless `--strict` is passed. Today's policy is expected
to fail several gates. That is the finding, not a bug.

## How it works

| Piece                                     | What it does                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/providers/bank-link/business-sim.ts` | Day stepping bank account simulator. The sandbox `generateHistory` and the forward `simulateBusiness` share it.    |
| `src/providers/commerce/synthetic.ts`     | `generateSalesFromPath` turns the simulator's daily sales into point of sale data, so both sources tell one story. |
| `src/evals/population.ts`                 | Draws applicants: continuous parameters around the sandbox archetypes, hidden health, dated hazards, fraud.        |
| `src/servicing/policy.ts`                 | Servicing rules as data: grace, retries, payout holds, write off. `BASELINE_SERVICING_POLICY` is today's behavior. |
| `src/evals/portfolio.ts`                  | The calendar loop: decisions, landlord payouts from the pool, installment debits, aging, write offs.               |
| `src/evals/metrics.ts`                    | Economics and rank ordering from the simulation output.                                                            |
| `src/evals/gates.ts`                      | Pass or fail thresholds.                                                                                           |
| `src/evals/assumptions.ts`                | Cost of funds, servicing cost, pool size, growth, horizon, stress presets.                                         |
| `src/evals/run.ts`, `report.ts`, `cli.ts` | Orchestration, rendering, and the command.                                                                         |

Three properties matter:

1. **The future continues the past.** A business is simulated forward from a fixed start
   date. The engine reads the first part of that path; the plan is played on the rest of the
   same path. A unit test checks the prefix property.
2. **Default is emergent.** Once a plan opens, the landlord's rent debit is replaced by
   installment debits. A debit clears only if the simulated balance covers it, and paying
   it lowers the balance for everything after. Nobody is labeled a defaulter.
3. **The engine does not see what drives failure.** Each business has a latent health value.
   It shifts margin, cash buffer, growth, and debt, with noise, and it sets the odds of
   revenue shocks, slow declines, and closure after the decision. The score has to earn its
   rank ordering from the noisy, observable part.

## Gates (Balanced risk appetite)

Defined in `src/evals/gates.ts`. A policy change should not ship unless all pass on the
default run.

| Gate                     | Threshold                             | Why                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `net_loss_base`          | At or under 75 bps of rent volume     | Fees are 150 to 300 bps of rent. After funding and servicing about 90 bps is left, so losses above 75 bps consume the margin.                                                                                                |
| `net_margin_base`        | Above zero                            | Fees collected less cost of funds, servicing, and net losses.                                                                                                                                                                |
| `net_margin_mild_stress` | Above zero                            | The same, with revenue down 15% for six months across the book.                                                                                                                                                              |
| `bad_rate_monotonic`     | No inversions from A to D             | Pricing and limits step by grade, so worse grades must be riskier. Grades with fewer than 30 plans are skipped, and a better grade may sit up to 100 bps (one percentage point) above the next: sampling noise at this size. |
| `auc`                    | At or above 0.70                      | The score must separate plans that go bad from plans that do not.                                                                                                                                                            |
| `fraud_approval`         | Under 5% of fraud applicants approved | Covers all three fraud archetypes together.                                                                                                                                                                                  |
| `pool_funding`           | No payout unfunded on its due date    | At the planned growth rate, with the planned pool.                                                                                                                                                                           |
| `approval_floor`         | At or above 30% of all applicants     | Stops the other gates being passed by declining everyone. 55% of the default population comes from archetypes that are creditworthy by construction, so approving under 30% means turning away about half of those.          |

Definitions used by the gates and the report:

- **Volume**: rent paid to landlords.
- **Bad**: any installment reached 30 days past due, or was written off.
- **Net loss**: principal written off, less recoveries. Under a servicing policy that never
  writes off (today's), anything still unpaid 90 days past due when a plan's observation ends
  is counted as written off. Unpaid fees are never income, so they are not a loss either.
- **First payment default**: an installment of the first period reached 30 days past due.
- **Net profitable customer**: fees collected exceed that customer's cost of funds,
  servicing, and net loss.

## Assumptions

All in `src/evals/assumptions.ts`.

| Assumption    | Value                                  | Reasoning                                                                                                                                   |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Cost of funds | 12% APR on daily principal outstanding | A warehouse line for a young nonbank lender.                                                                                                |
| Servicing     | $12.00 per plan-month                  | About $1.50 payments, $1.50 bank data refresh, $9 support and operations. Roughly 0.28% of volume at the average plan rent of about $4,300. |
| Recovery      | 10% of written off principal           | Low end for unsecured small business credit without a personal guarantee. Taken at write off, with no delay.                                |
| Pool          | $7,500,000 per 2,000 applicants        | The planned peak day of payouts (about $5.8 million) plus roughly 30% headroom. Scales with `--n`.                                          |
| Growth        | 10% a month over 12 arrival months     | The pool is exercised by a growing book.                                                                                                    |
| Horizon       | 12 rent periods per plan               | Then 95 days of run off so every installment can reach the 90 day mark.                                                                     |
| Mild stress   | Revenue down 15% for 180 days          | Starts in month 7 of the arrival window, for every business at once.                                                                        |
| Severe stress | Revenue down 30% for 270 days          | Same start.                                                                                                                                 |

Cost of funds and servicing are profit and loss lines only. They are not taken out of the
pool, so pool cash obeys: starting pool, plus fees collected, less net losses, equals ending
pool plus receivables. A unit test asserts this.

## The population

Choices, not measurements. They live in `src/evals/population.ts`.

- **Archetype mix** (honest applicants): healthy 30, growing 8, thin margin 14, declining 5,
  volatile 7, overdrafts 6, heavy debt 7, seasonal 7, new business 6, low balance 6, no bank
  linked 1, batched settlement 3. Parameters are drawn continuously around each archetype.
- **Size and rent**: monthly revenue is log normal around an industry median ($22,000 to
  $50,000). Rent is log normal around 10% of revenue. About one honest applicant in ten is
  rent burdened, with rent 1.8 to 3 times that share.
- **Latent health** is normal around an archetype mean. It moves cash margin by 3 points per
  unit, plus growth, opening balance, and the owner's personal reserve, each with its own
  noise.
- **Forward hazards**, per month, at health 0: closure 0.22%, revenue shock 1% (20% to 60%
  deep, 30 to 120 days), slow decline 0.4% (20% to 50%, permanent), surprise bill 3%. Each
  falls exponentially with health. Closure is 1.5 times likelier under two years old and
  varies by industry (restaurants 1.25, professional services 0.7).
- **Costs are sticky.** When revenue falls, costs follow by 30% to 70% of the drop.
- **Owners top up, until they cannot.** An owner covers an overdraft or a returned
  installment from a personal reserve. When it is gone and two payrolls in a row are
  returned, the business closes. A closing business empties its account.
- **Survivorship.** An applicant whose business would have shut during its own history is
  redrawn. Dead businesses do not apply.
- **Point of sale**: 35% of honest applicants connect one. Its sales are the same sales the
  bank deposits come from.
- **Fraud**: 3% of applicants.
  - `inflated_revenue` (40%): states 1.25 to 2.2 times real revenue, with a lease sized to
    the story.
  - `round_trip` (35%): pads bank revenue by 40% to 90% for the three to five months before
    applying, with credits that leave two days later as transfers, and presents a lease of
    16% to 24% of real revenue.
  - `bust_out` (25%): 8 to 11 months of clean history, a requested rent 2.5 to 4 times the
    rent seen in the account, and the account is emptied 2 to 20 days after applying.

What that produces on today's policy, default run (2,000 applicants, seed 1): 6.8% of funded
plans go bad over 12 periods. By grade: A 2.9%, B 11.7%, C 13.0%, D 37.5%. Fraud plans:
bust out 100%, round trip 80%. A 10,000 applicant run gives 7.5% overall and A 3.2%, B 11.8%,
C 17.1%, D 26.2%. The population was calibrated to land in a plausible small business range
and then left alone. It was not tuned toward the gates.

## Limits

- **Synthetic borrowers.** Results show whether the policy is internally coherent under the
  assumptions above. They do not show that real businesses behave this way, and they are not
  a loss forecast. Before any real capital, the hazard rates and the score to default
  relationship need calibrating on real outcomes.
- **Sampling noise.** The default run has about 90 bad plans. AUC moved between 0.69 and
  0.77 across five seeds, and grade D has about 40 plans. Use `--n 10000` before reading
  much into a small change in rank ordering.
- **One account per business.** No second bank, no other creditors competing for the same
  cash beyond the modeled loan and advance payments.
- **Needs info is terminal.** An applicant asked for more information does not come back.
- **All rent is due on the first.** That is the worst case for the pool and matches the
  sandbox bank generator. Real due dates are more spread out.
- **Recoveries are immediate and flat.** No collections timeline, no cost of collection.
- **Fraud is three scripted behaviors** at an assumed 3% share. Real fraud adapts.
- **Closure is total.** A closing business pays nothing further. Real wind downs sometimes
  pay creditors in part.

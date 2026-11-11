# Portfolio evals

A simulation that answers one question before any credit or servicing rule changes: on a
book of plausible applicants, does this policy make money, and does it stay inside the risk
appetite?

It draws a synthetic population, runs every applicant through the real `decide()` in
`src/underwriting/engine.ts`, opens a plan for each approval, and plays the plans forward day
by day against simulated bank accounts and a finite capital pool. Nothing touches the
database, the network, or a clock. The same seeds always give the same report.

## Run it

```sh
pnpm --filter @cashflow/api eval:portfolio                    # default run: 5 seeds, about 2 minutes
pnpm --filter @cashflow/api eval:portfolio --seeds 1          # one seed, about 25 seconds
pnpm --filter @cashflow/api eval:portfolio --n 10000 --seeds 1,2   # tighter estimates
pnpm --filter @cashflow/api eval:portfolio --n 500 --seeds 7,8 --horizon 6 --out /tmp/evals
pnpm --filter @cashflow/api eval:portfolio --strict           # exit 1 if any gate fails
pnpm --filter @cashflow/api eval:calibrate                    # regenerate the PD table, about 1 minute
```

| Flag        | Default          | Meaning                                                            |
| ----------- | ---------------- | ------------------------------------------------------------------ |
| `--n`       | 2000             | Applicants per seed                                                |
| `--seeds`   | `1,2,3,4,5`      | Comma separated seeds. Each is its own population and its own pool |
| `--horizon` | 12               | Rent periods each approved plan is played                          |
| `--out`     | `apps/api/evals` | Directory for the output files                                     |
| `--strict`  | off              | Exit non zero when a gate fails                                    |

`--seed 7` is accepted as an alias for `--seeds 7`.

Output:

- `report.md`: the gates, the four configurations side by side, swap sets, then for the
  gated configuration the headline numbers and cuts by grade, score band, archetype, and
  industry, calibration, the stress table, the pool by month, and the challengers.
- `report.json`: every metric for base, mild stress, and severe stress, plus per seed
  headlines. Not checked in.
- `baseline.json`: headline metrics and gate results for every configuration. Written only
  by a run with the default `--n`, `--seeds`, and `--horizon`, and checked in, so a policy
  change shows up as a diff.

The command exits 0 when gates fail unless `--strict` is passed.

## What is gated, and what it is compared with

The gated configuration is the current credit policy (`CURRENT_POLICY` in
`src/underwriting/policy.ts`) under `STANDARD_SERVICING_POLICY`: hold the next landlord payout
while anything is more than 3 days past due, three collection attempts per installment, write
off at 90 days. The collection and payout services do not implement that policy yet. The
credit policy is judged under the servicing policy that will ship with it.

The same applicants are also run under three comparison configurations:

| Configuration | Decisions     | Servicing | Why it is there                           |
| ------------- | ------------- | --------- | ----------------------------------------- |
| `v1_baseline` | `cashflow-v1` | baseline  | The launch policy as first measured       |
| `v1_standard` | `cashflow-v1` | standard  | What the servicing change buys on its own |
| `v2_baseline` | current       | baseline  | What the credit policy buys on its own    |
| `v2_standard` | current       | standard  | Both. This is the one the gates decide on |

A single run of 2,000 applicants has about 60 bad plans, and AUC in particular moves several
points from seed to seed. So the default run uses five seeds, each a separate population with
its own pool, and **the gates judge the mean across seeds**. The report shows the mean and the
lowest and highest seed for every gate. Two gates are counts and are handled differently:
grade inversions are counted on bad rates pooled across the seeds, and unfunded payouts are
summed, because one on any seed is a failure. Tables of counts pool the five seeds into one
book of 10,000 applicants.

Five seeds of 2,000 is nine portfolio runs per seed (three scenarios for the gated
configuration, five for the comparisons, and one challenger; the swap sets reuse them) and
takes about a minute and a half. `--seeds 1` runs a single seed when a quick look is enough.

## How it works

| Piece                                     | What it does                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/providers/bank-link/business-sim.ts` | Day stepping bank account simulator. The sandbox `generateHistory` and the forward `simulateBusiness` share it.    |
| `src/providers/commerce/synthetic.ts`     | `generateSalesFromPath` turns the simulator's daily sales into point of sale data, so both sources tell one story. |
| `src/evals/population.ts`                 | Draws applicants: continuous parameters around the sandbox archetypes, hidden health, dated hazards, fraud.        |
| `src/servicing/policy.ts`                 | Servicing rules as data: grace, retries, payout holds, write off. Baseline is today's behavior, standard is next.  |
| `src/underwriting/policy.ts`              | Credit policies as data. The evals run `POLICY_V1` and `CURRENT_POLICY` through the same engine.                   |
| `src/underwriting/exposure.ts`            | The exposure rules. The simulator calls the same functions the services call, on its own in memory state.          |
| `src/evals/portfolio.ts`                  | The calendar loop: decisions, review, funding rules, landlord payouts, installment debits, aging, write offs.      |
| `src/evals/metrics.ts`                    | Economics, rank ordering, calibration, and pooling of seeds, from the simulation output.                           |
| `src/evals/gates.ts`                      | Pass or fail thresholds, judged on the mean across seeds.                                                          |
| `src/evals/assumptions.ts`                | Cost of funds, servicing cost, review catch rate, pool size, growth, horizon, stress presets.                      |
| `src/evals/calibrate.ts`                  | Regenerates the PD table in `src/underwriting/pd-table.ts` from a large run on separate seeds.                     |
| `src/evals/run.ts`, `report.ts`, `cli.ts` | Orchestration, rendering, and the command.                                                                         |

Five properties matter:

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
4. **Review is modeled simply, and the assumption is stated.** When the engine refers an
   application, a reviewer catches and declines 70% of fraud applicants and approves every
   other referral at the terms the engine recommended. Which fraud applicants are caught
   depends only on the applicant, so every run reviews them the same way. The reviewer has
   no information about honest applicants that the engine lacks, so review neither helps nor
   hurts them here: a referral of an honest applicant costs only the refer rate.
5. **The exposure rules are the real ones.** The simulator keeps the same state the services
   gather from the database (committed rent in total and by industry, pool cash,
   receivables) and passes it to the engine and to `checkFunding`. A plan the pool cannot
   take under the utilization, industry, or single name ceilings waits up to three rent
   dates and is then counted as approved but never funded. Each applicant is a new customer
   with one plan, so the ladder always sits on its first rung and the aggregate cap per
   business never binds.

## Gates (Balanced risk appetite)

Defined in `src/evals/gates.ts`. A policy change should not ship unless all pass on the
default run. No threshold has been loosened since the first evaluation; `refer_rate` was
added with the manual review path.

| Gate                     | Threshold                             | Why                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `net_loss_base`          | At or under 75 bps of rent volume     | Fees are 150 to 300 bps of rent. After funding and servicing about 90 bps is left, so losses above 75 bps consume the margin.                                                                                                             |
| `net_margin_base`        | Above zero                            | Fees collected less cost of funds, servicing, and net losses.                                                                                                                                                                             |
| `net_margin_mild_stress` | Above zero                            | The same, with revenue down 15% for six months across the book.                                                                                                                                                                           |
| `bad_rate_monotonic`     | No inversions from A to D             | Pricing and limits step by grade, so worse grades must be riskier. Grades with fewer than 30 plans are skipped, and a better grade may sit up to 100 bps (one percentage point) above the next. Counted on bad rates pooled across seeds. |
| `auc`                    | At or above 0.70                      | The score must separate plans that go bad from plans that do not.                                                                                                                                                                         |
| `fraud_approval`         | Under 5% of fraud applicants approved | Covers all three fraud archetypes together, and counts the final outcome: a fraud applicant who is referred and then approved by the reviewer counts as approved.                                                                         |
| `pool_funding`           | No payout unfunded on its due date    | At the planned growth rate, with the planned pool. Summed across seeds.                                                                                                                                                                   |
| `approval_floor`         | At or above 30% of all applicants     | Stops the other gates being passed by declining everyone. 55% of the default population comes from archetypes that are creditworthy by construction, so approving under 30% means turning away about half of those.                       |
| `refer_rate`             | At most 5% of applicants referred     | The product promises a decision in the same request. Nineteen applicants in twenty must get one, and a policy must not pass the fraud gate by handing its hard cases to a queue.                                                          |

**A warning about the AUC gate.** AUC is measured on funded plans, and it falls when
underwriting improves. Every predictable bad plan a policy stops funding (a business in
decline, a score under the cutoff) is a low scoring bad plan removed from the sample, which
leaves bad plans that are harder to tell from good ones. Version 2 lowers AUC under the same
servicing from 0.743 to 0.706 while it halves the loss rate. The gate passes by 0.006, and it
passes only because the 50 to 54 score band is funded: the `cutoff_55` challenger in the
report scores 0.686. That band is funded because it earns a positive margin under mild stress
(see `UNDERWRITING.md`), not to pass this gate, but anyone tightening the cutoff should
expect this gate to fail and should read it for what it measures.

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
| Manual review | Catches 70% of referred fraud          | An assumption, not a measurement. A reviewer who asks for the lease and calls the landlord stops most staged applications and misses some.  |
| Funding wait  | Up to 3 rent dates                     | A plan the pool cannot take under the exposure rules waits, then is counted as approved but never funded.                                   |
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

What that produces on the default run (five seeds of 2,000, pooled):

| Configuration | Funded plans that go bad | A    | B     | C     | D     | Fraud applicants funded |
| ------------- | -----------------------: | ---- | ----- | ----- | ----- | ----------------------- |
| `v1_baseline` |                     7.6% | 4.2% | 9.5%  | 17.3% | 23.4% | 118 of 258 (45.7%)      |
| `v1_standard` |                     8.8% | 4.3% | 10.8% | 20.6% | 34.6% | 118 of 258 (45.7%)      |
| `v2_standard` |                     4.8% | 3.0% | 7.3%  | 11.3% | 20.7% | 2 of 258 (0.8%)         |

The bad rate rises from `v1_baseline` to `v1_standard` on the same decisions because the
standard policy stops retrying after three attempts, so more installments reach 30 days past
due, while the money lost falls by a factor of eight because payouts stop.

Under version 1, bust outs that were funded went bad 100% of the time and round trips 47%.
Under version 2 none of either is funded. The population was calibrated to land in a
plausible small business range and then left alone. It was not tuned toward the gates, and
it was not changed for version 2.

## Calibrating the PD table

`pnpm --filter @cashflow/api eval:calibrate` runs the current policy under the standard
servicing policy on 10,000 applicants for each of the seeds `calibration-1` and
`calibration-2`, groups funded plans into five point score bands, measures the share that
went bad, pools neighboring bands where needed so PD never rises with score, and writes
`src/underwriting/pd-table.ts` with the run parameters. Loss given default and funded periods
per plan are measured in the same run. The seeds are not the ones the gates are judged on.
`--dry-run` prints the table without writing it; `--n` and `--seeds` change the run.

Rerun it whenever the scorecard, the cutoffs, or the servicing policy change, and give the
policy a new version. The report's calibration table then shows expected against realized by
band on the gate seeds.

## Limits

- **Synthetic borrowers.** Results show whether the policy is internally coherent under the
  assumptions above. They do not show that real businesses behave this way, and they are not
  a loss forecast. Before any real capital, the hazard rates and the score to default
  relationship need calibrating on real outcomes.
- **Sampling noise.** One seed has about 60 bad plans under version 2. AUC ran from 0.668 to
  0.752 across the five default seeds, grade D has about 30 plans a seed, and one seed of the
  five shows a grade inversion that the pooled book does not. The gates judge the mean for
  this reason. Use `--n 10000` before reading much into a small change in rank ordering.
- **The policy was tuned on this simulator.** The cutoff, the scorecard weights, the decline
  thresholds, and the PD table were chosen by looking at simulated outcomes. Tuning was done
  on seeds other than the five the gates use, which guards against fitting to sampling noise.
  It does not guard against fitting to the simulator itself: the gate seeds come from the
  same generator.
- **Fraud is three scripts, and the checks were written after reading them.** A request 2.5
  to 4 times observed rent, credits that leave two days later as same sized transfers, and
  an inflated stated revenue are each caught by a check aimed at exactly that. The fraud
  numbers show the checks work as designed. They say nothing about fraud that behaves
  differently, and nothing about false positives: every honest applicant here asks for the
  rent it already pays and never moves a deposit out again.
- **Review is an assumption.** Reviewers catch 70% of referred fraud and add nothing on
  honest applicants. Review time, reviewer error on honest applicants, and applicants who
  walk away while waiting are not modeled.
- **Periodic re-underwriting is not modeled.** The `reunderwrite` job re-scores active plans
  monthly and freezes a deteriorated one. Modeling it here would mean keeping a year of
  transactions for every active plan and running the engine about twelve more times per
  plan, roughly eight times the decisions of a run. It was left out, so the report shows
  the book without that protection.
- **One plan per business.** The ladder and the aggregate cap per business are unit tested
  but never bind here beyond the first rung.
- **Partial fronting.** When the limit is below the request the simulator fronts the limit
  and the business pays the rest of its rent itself. The product does not do that yet: a
  plan fronts the whole lease or nothing, so a counter offer below the lease rent cannot be
  used. Volume and fee income from counter offers (28% of approvals) are therefore
  overstated relative to the product as built.
- **One account per business.** No second bank, no other creditors competing for the same
  cash beyond the modeled loan and advance payments.
- **Needs info is terminal.** An applicant asked for more information does not come back.
- **All rent is due on the first.** That is the worst case for the pool and matches the
  sandbox bank generator. Real due dates are more spread out.
- **Recoveries are immediate and flat.** No collections timeline, no cost of collection.
- **Fraud share** is an assumed 3% of applicants.
- **Closure is total.** A closing business pays nothing further. Real wind downs sometimes
  pay creditors in part.

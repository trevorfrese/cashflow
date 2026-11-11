# Portfolio evals

A simulation that answers one question before any credit or servicing rule changes: on a
book of plausible applicants, does this policy make money, and does it stay inside the risk
appetite?

It draws a synthetic population, runs every applicant through the real `decide()` in
`src/underwriting/engine.ts`, opens a plan for each approval, and plays the plans forward day
by day against simulated bank accounts and a finite capital pool. Nothing touches the
database, the network, or a clock. The same seeds always give the same report.

**Current state: 8 of 9 gates pass. The AUC gate fails** (0.669 against 0.70) since the
simulator was brought into line with the product in Phase R3. Read "Where the gates stand"
below before relying on any number here.

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
  industry, calibration, the stress table, the pool by month, roll rates by delinquency
  bucket, the sensitivities, and the challengers.
- `report.json`: every metric for base, mild stress, and severe stress, plus per seed
  headlines. Not checked in.
- `baseline.json`: headline metrics and gate results for every configuration and each
  sensitivity. Written only by a run with the default `--n`, `--seeds`, and `--horizon`, and
  checked in, so a policy change shows up as a diff.

The command exits 0 when gates fail unless `--strict` is passed.

## What is gated, and what it is compared with

The gated configuration is the current credit policy (`CURRENT_POLICY` in
`src/underwriting/policy.ts`) under `STANDARD_SERVICING_POLICY`, which is the policy the
collection, payout, aging, and provisioning services run (`ACTIVE_SERVICING_POLICY` in
`src/servicing/policy.ts`). The simulator calls the same policy functions the services call,
in the order the jobs run, and models the product as built:

- **Whole lease or nothing.** `createRentPlan` refuses a lease above the approved limit, so
  an approval for less than the rent requested opens no plan. A third of approvals are
  counter offers (2,013 of 6,084 on the default run), and none of them is funded.
- **Stop-advance with release and cancel.** A payout is held while anything is more than 3
  days past due. The business leaves that month's rent to CashFlow. If it cures within 5
  days of the rent date the payout is released and its installments move out by the delay;
  otherwise the payout is cancelled and the business pays the landlord itself, late.
- **Balance check.** Before each scheduled debit the simulator reads the account balance as
  it stood that morning. A debit it cannot cover is put off a day and is not an attempt. The
  owner is assumed to react to being told the same way as to a returned debit.
- **Returns.** A debit the account cannot cover is booked as collected, as the services
  book it, and reversed two days later. Until then the plan is treated as paid up.
- **Charge-off.** At 90 days past due the whole unpaid balance of the plan is written off
  and the plan is closed.

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

Five seeds of 2,000 is eleven portfolio runs per seed (three scenarios for the gated
configuration, five for the comparisons, two sensitivities, and one challenger; the swap sets
reuse them) and takes about a minute and forty seconds. `--seeds 1` runs a single seed when a
quick look is enough.

## Where the gates stand

| Gate                     | Before Phase R3 (committed report) |                    Now | Result |
| ------------------------ | ---------------------------------: | ---------------------: | ------ |
| `net_loss_base`          |                  22 bps (20 to 24) |      18 bps (11 to 21) | PASS   |
| `net_margin_base`        |           $522,874 a seed (92 bps) |   $269,553 a seed (79) | PASS   |
| `net_margin_mild_stress` |                           $431,207 |               $221,098 | PASS   |
| `bad_rate_monotonic`     |                                  0 |                      0 | PASS   |
| `auc`                    |             0.706 (0.668 to 0.752) | 0.669 (0.569 to 0.714) | FAIL   |
| `fraud_approval`         |                               0.8% |                   0.8% | PASS   |
| `pool_funding`           |                                  0 |                      0 | PASS   |
| `approval_floor`         |              60.8% (all approvals) |    40.7% (usable only) | PASS   |
| `refer_rate`             |                               1.7% |                   1.7% | PASS   |

Nothing about the credit policy or the population changed between the two columns. What
changed is what the simulator funds and how it services:

| Simulator                                       |   AUC | Plans | Bad plans | Net loss bps | Margin bps |
| ----------------------------------------------- | ----: | ----: | --------: | -----------: | ---------: |
| As committed: counter offers fronted in part    | 0.706 | 6,084 |       294 |           22 |         92 |
| Plus the balance check before each debit        | 0.679 | 6,084 |       266 |           21 |         94 |
| Whole lease or nothing, no balance check        | 0.676 | 4,071 |       144 |           18 |         79 |
| Whole lease or nothing, with it (the gated run) | 0.669 | 4,071 |       141 |           18 |         79 |

Two things lower AUC, and both are the effect the warning under "Gates" describes. The
balance check collects from businesses that had the money a few days late, which removes
about 30 of the more predictable bad plans. Funding only whole leases removes every counter
offer, and counter offers are where the low grades are: of 4,071 funded plans 3,805 are
grade A, 249 are B, 17 are C, and none is D. With 141 bad plans across five seeds (about 28
a seed) and almost no spread of grades left, the score has little to separate. One seed
scores 0.569. Holds, releases, cancellations, return handling, and writing off the whole
balance at once do not move the numbers: with those alone the result is the committed one to
the basis point.

No threshold was changed, and the population was not touched. Two things could be decided
from here, and neither is decided in this repository: let the product front part of a rent,
which brings back the counter offer volume (the `partial_advance` sensitivity: 6,084 plans,
net loss 21 bps, margin 93 bps, AUC 0.678, which still fails); or accept that AUC on a book
that is 93% grade A is not the right test of the score and replace the gate with one that is
measured on all scored applicants. The PD table was not recalibrated: see "Calibrating the PD
table".

## How it works

| Piece                                     | What it does                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/providers/bank-link/business-sim.ts` | Day stepping bank account simulator. The sandbox `generateHistory` and the forward `simulateBusiness` share it.     |
| `src/providers/commerce/synthetic.ts`     | `generateSalesFromPath` turns the simulator's daily sales into point of sale data, so both sources tell one story.  |
| `src/evals/population.ts`                 | Draws applicants: continuous parameters around the sandbox archetypes, hidden health, dated hazards, fraud.         |
| `src/servicing/policy.ts`                 | Servicing rules as data and pure functions. Standard is what the services run. Baseline is how they behaved before. |
| `src/underwriting/policy.ts`              | Credit policies as data. The evals run `POLICY_V1` and `CURRENT_POLICY` through the same engine.                    |
| `src/underwriting/exposure.ts`            | The exposure rules. The simulator calls the same functions the services call, on its own in memory state.           |
| `src/evals/portfolio.ts`                  | The calendar loop: decisions, review, funding rules, returns, payouts and holds, debits, aging, write offs.         |
| `src/evals/metrics.ts`                    | Economics, rank ordering, calibration, and pooling of seeds, from the simulation output.                            |
| `src/evals/gates.ts`                      | Pass or fail thresholds, judged on the mean across seeds.                                                           |
| `src/evals/assumptions.ts`                | Cost of funds, servicing cost, review catch rate, pool size, growth, horizon, stress presets.                       |
| `src/evals/calibrate.ts`                  | Regenerates the PD table in `src/underwriting/pd-table.ts` from a large run on separate seeds.                      |
| `src/evals/run.ts`, `report.ts`, `cli.ts` | Orchestration, rendering, and the command.                                                                          |

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
added with the manual review path, and `approval_floor` was tightened in Phase R3 to count
only approvals that can be used.

| Gate                     | Threshold                             | Why                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `net_loss_base`          | At or under 75 bps of rent volume     | Fees are 150 to 300 bps of rent. After funding and servicing about 90 bps is left, so losses above 75 bps consume the margin.                                                                                                                                                                                                                                |
| `net_margin_base`        | Above zero                            | Fees collected less cost of funds, servicing, and net losses.                                                                                                                                                                                                                                                                                                |
| `net_margin_mild_stress` | Above zero                            | The same, with revenue down 15% for six months across the book.                                                                                                                                                                                                                                                                                              |
| `bad_rate_monotonic`     | No inversions from A to D             | Pricing and limits step by grade, so worse grades must be riskier. Grades with fewer than 30 plans are skipped, and a better grade may sit up to 100 bps (one percentage point) above the next. Counted on bad rates pooled across seeds.                                                                                                                    |
| `auc`                    | At or above 0.70                      | The score must separate plans that go bad from plans that do not.                                                                                                                                                                                                                                                                                            |
| `fraud_approval`         | Under 5% of fraud applicants approved | Covers all three fraud archetypes together, and counts the final outcome: a fraud applicant who is referred and then approved by the reviewer counts as approved.                                                                                                                                                                                            |
| `pool_funding`           | No payout unfunded on its due date    | At the planned growth rate, with the planned pool. Summed across seeds.                                                                                                                                                                                                                                                                                      |
| `approval_floor`         | At or above 30% of all applicants     | Stops the other gates being passed by declining everyone. Counts approvals the applicant can use: an approval for less than the rent requested opens no plan in the product, so it does not count. 55% of the default population comes from archetypes that are creditworthy by construction, so approving under 30% means turning away about half of those. |
| `refer_rate`             | At most 5% of applicants referred     | The product promises a decision in the same request. Nineteen applicants in twenty must get one, and a policy must not pass the fraud gate by handing its hard cases to a queue.                                                                                                                                                                             |

**A warning about the AUC gate.** AUC is measured on funded plans, and it falls when
underwriting or servicing improves. Every predictable bad plan that stops being funded (a
business in decline, a score under the cutoff, a counter offer that cannot be used), and
every one that stops going bad because it was collected a few days late, is a low scoring
bad plan removed from the sample, which leaves bad plans that are harder to tell from good
ones. Version 2 lowered AUC under the same servicing from 0.743 to 0.706 while it halved the
loss rate, and passed by 0.006. It now fails at 0.669, for the reasons set out in "Where the
gates stand". The `cutoff_55` challenger no longer tells the two apart: no plan under score
55 is funded once counter offers are excluded, so it scores the same 0.669.

Definitions used by the gates and the report:

- **Volume**: rent paid to landlords.
- **Bad**: any installment reached 30 days past due, or was written off.
- **Net loss**: principal written off, less recoveries. Under a servicing policy that never
  writes off (the baseline), anything still unpaid 90 days past due when a plan's observation
  ends is counted as written off. Unpaid fees are never income, so they are not a loss either.
- **Usable approval**: approved for at least the rent requested. An approval for less is a
  counter offer, and the product cannot open a plan on one.
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
| Returns       | 2 days                                 | A debit the account cannot cover is booked as collected and reversed two days later. Not applied under the baseline servicing policy.       |
| Balance check | The morning's balance                  | Read before the day's deposits. A debit it cannot cover is put off a day. The owner reacts to the notice as to a returned debit.            |
| Late rent     | Paid by the business on cancellation   | When a held payout is cancelled the business pays that month's rent itself, on that day.                                                    |
| Manual pay    | None in the gated run                  | A balance automatic debits never collect is assumed never to be paid by hand. The `manual_payment` sensitivity assumes 30% is.              |
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

| Configuration     | Funded plans | That go bad | A    | B     | Fraud applicants approved | Of those, funded |
| ----------------- | -----------: | ----------: | ---- | ----- | ------------------------- | ---------------: |
| `v1_baseline`     |        4,472 |        4.7% | 4.1% | 12.2% | 118 of 258 (45.7%)        |               52 |
| `v1_standard`     |        4,472 |        4.8% | 4.2% | 12.5% | 118 of 258 (45.7%)        |               52 |
| `v2_standard`     |        4,071 |        3.5% | 3.1% | 8.8%  | 2 of 258 (0.8%)           |                0 |
| `partial_advance` |        6,084 |        4.4% | 3.0% | 6.6%  | 2 of 258 (0.8%)           |                2 |

Grades C and D are left out: outside `partial_advance` at most 17 plans are funded in C and
none in D, because nearly every approval in those grades is a counter offer. Under
`partial_advance` they go bad at 8.6% and 15.9%.

The population was calibrated to land in a plausible small business range and then left
alone. It was not tuned toward the gates, it was not changed for version 2, and it was not
changed for Phase R3.

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

**The table is stale and was deliberately not regenerated in Phase R3.** It was calibrated
on a book in which counter offers were fronted in part, with several hundred funded plans
in every five point score band from 50 up. The calibration run now models the product, where
most of the plans below 75 do not exist. A dry run gives 8 funded plans in the 50 to 59 band (4 bad) and 223 from 60 to 74,
against several hundred in each before, and PDs of 12.6% for 60 to 74, 9.5% for 75 to 79,
5.1% for 80 to 84, 4.5% for 85 to 89, 3.1% for 90 to 94, and 1.6% for 95 to 100. Above 85,
where nearly all funded plans are, that is within a few tenths of a point of the table in
use. Below 75 there is too little data to price on. Regenerating it would change fees and
needs a new policy version, which is a credit policy decision, not a servicing one, and it
should wait until the counter offer question above is settled.

## Roll rates and the loss reserve

The report's "Roll to charge-off by bucket" table is where the reserve rates in
`STANDARD_SERVICING_POLICY.provisionRatesBps` come from. On the evening of the first of each
month, which is when the provision job runs, 0.36% of the principal outstanding in current
plans is later written off, 94.3% of the principal in delinquent plans, and 99.8% of the
principal in default. No plan is in grace on the first, because all rent here is due on the
first, so grace is measured on entry: 84.5% of principal in plans as they move into grace is
later written off. The policy uses those rounded up: 0.40%, 85%, 95%, and 100%.

The step from current to grace says more about the simulation than about lending. Owners
here cover a short account from savings until the business fails, and the balance check waits
for money that is a day or two late, so an installment that goes unpaid at all nearly always
belongs to a business that has closed. Real businesses cure from grace far more often.

## Sensitivities

Reported in their own table, never gated.

- `partial_advance`: counter offers are fronted in part, which the product does not do.
  Approval on usable terms 60.8% against 40.7%, 6,084 plans against 4,071, volume $283.7
  million against $170.2 million, net loss 21 bps against 18, net margin $2,649,924 (93 bps)
  against $1,347,764 (79 bps), AUC 0.678 against 0.669.
- `manual_payment`: 30% of installments still unpaid after the retries, at businesses still
  trading, are paid by hand between day 7 and day 30. It changes almost nothing: net loss
  $304,785 against $304,020, both 18 bps, with two more held payouts released. Nearly every
  installment that is unpaid after a week here belongs to a business that has already
  closed, and a closed business pays nothing. So the gated figure does not lean on the
  assumption that nobody pays by hand, and this simulation cannot say what manual payments
  would be worth with real borrowers, who fall behind for reasons other than closing.

## Limits

- **Synthetic borrowers.** Results show whether the policy is internally coherent under the
  assumptions above. They do not show that real businesses behave this way, and they are not
  a loss forecast. Before any real capital, the hazard rates and the score to default
  relationship need calibrating on real outcomes.
- **Sampling noise.** One seed has about 28 bad plans under version 2. AUC ran from 0.569 to
  0.714 across the five default seeds, grades C and D are all but empty, and one seed of the
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
- **A held payout assumes a patient tenant.** While a payout is held, the simulated business
  does not pay its landlord itself; it pays only once the payout is cancelled. A real owner
  told that the payout is on hold may pay the landlord at once, and a payout released
  afterwards would then pay the landlord twice. Only 5 of 328 held payouts are released in
  the gated run, so the numbers do not depend on it, but the product risk is real.
- **The balance check is better informed here than it would be.** It reads the true balance
  each morning, and a debit that passes it almost never fails later in the day: 16 debits
  are returned in the gated run against 20,445 put off. A real balance read is older and
  misses pending items. The check also means the cap of three attempts almost never binds.
- **Hard and unauthorized returns are not modeled.** Every failed debit here is
  insufficient funds. Closed accounts, disputes, and returned landlord payouts are handled
  by the services and covered by integration tests, not by the simulation.
- **Periodic re-underwriting is not modeled.** The `reunderwrite` job re-scores active plans
  monthly and freezes a deteriorated one. Modeling it here would mean keeping a year of
  transactions for every active plan and running the engine about twelve more times per
  plan, roughly eight times the decisions of a run. It was left out, so the report shows
  the book without that protection.
- **One plan per business.** The ladder and the aggregate cap per business are unit tested
  but never bind here beyond the first rung.
- **Counter offers.** The gated run funds a whole lease rent or nothing, as the product
  does, so a third of approvals open no plan. An applicant with a counter offer is assumed
  not to come back with a cheaper lease.
- **One account per business.** No second bank, no other creditors competing for the same
  cash beyond the modeled loan and advance payments.
- **Needs info is terminal.** An applicant asked for more information does not come back.
- **All rent is due on the first.** That is the worst case for the pool and matches the
  sandbox bank generator. Real due dates are more spread out.
- **Recoveries are immediate and flat.** No collections timeline, no cost of collection.
- **Fraud share** is an assumed 3% of applicants.
- **Closure is total.** A closing business pays nothing further. Real wind downs sometimes
  pay creditors in part.

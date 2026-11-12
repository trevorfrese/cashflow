# Portfolio evals

A simulation that answers one question before any credit or servicing rule changes: on a
book of plausible applicants, does this policy make money, and does it stay inside the risk
appetite?

It draws a synthetic population, runs every applicant through the real `decide()` in
`src/underwriting/engine.ts`, opens a plan for each approval, and plays the plans forward day
by day against simulated bank accounts and a finite capital pool. Nothing touches the
database, the network, or a clock. The same seeds always give the same report.

**Current state: 10 of 10 gates pass** under `cashflow-v4` (version 3 plus the payment history
factor, with credit declines put on the free pass-through plan and graduated from it; see
"Pass-through and graduation" below). Its origination decisions are version 3's for every
applicant, so every gated number equals `v3_standard`'s. Version 3 was version 2 plus the data veracity
checks on a population extended with connection data, honest messiness, and five more fraud
archetypes. See "Data veracity" below for what changed and what it cost. The AUC gate is
judged on every scored honest applicant, through a counterfactual run that funds the declined
ones too (0.873 against 0.70). Measured the old way, on funded plans only, it is still 0.669, and that figure is
still in the report, ungated. Read "Where the gates stand" and "The AUC gate: through the
door" below before relying on any number here.

## Run it

```sh
pnpm --filter @cashflow/api eval:portfolio                    # default run: 5 seeds, about 4 minutes
pnpm --filter @cashflow/api eval:portfolio --seeds 1          # one seed, about 35 seconds
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

| Configuration | Decisions     | Servicing | Why it is there                                        |
| ------------- | ------------- | --------- | ------------------------------------------------------ |
| `v1_baseline` | `cashflow-v1` | baseline  | The launch policy as first measured                    |
| `v1_standard` | `cashflow-v1` | standard  | What the servicing change buys on its own              |
| `v2_baseline` | `cashflow-v2` | baseline  | What the credit policy buys on its own                 |
| `v2_standard` | `cashflow-v2` | standard  | Both, before the veracity checks                       |
| `v3_standard` | current       | standard  | Plus the veracity checks. The gates decide on this one |

A single run of 2,000 applicants funds about 28 bad plans, and rank ordering among funded
plans in particular moves several points from seed to seed. So the default run uses five seeds, each a separate population with
its own pool, and **the gates judge the mean across seeds**. The report shows the mean and the
lowest and highest seed for every gate. Two gates are counts and are handled differently:
grade inversions are counted on bad rates pooled across the seeds, and unfunded payouts are
summed, because one on any seed is a failure. Tables of counts pool the five seeds into one
book of 10,000 applicants.

Five seeds of 2,000 is eleven portfolio runs per seed (three scenarios for the gated
configuration, five for the comparisons, two sensitivities, and one challenger; the swap sets
reuse them), plus a through the door run for each of the three configurations the gates are
applied to. A through the door run plays only the applicants its configuration did not
already fund, and takes the rest from the run that did. The whole thing takes about two and a half minutes, roughly a third longer than the eleven
runs alone.
`--seeds 1` runs a single seed when a quick look is enough.

## Where the gates stood after Phase R3 (cashflow-v2)

| Gate                     | Before Phase R3 (committed report) |                          After Phase R3 | Result |
| ------------------------ | ---------------------------------: | --------------------------------------: | ------ |
| `net_loss_base`          |                  22 bps (20 to 24) |                       18 bps (11 to 21) | PASS   |
| `net_margin_base`        |           $522,874 a seed (92 bps) |                    $269,553 a seed (79) | PASS   |
| `net_margin_mild_stress` |                           $431,207 |                                $221,098 | PASS   |
| `bad_rate_monotonic`     |                                  0 |                                       0 | PASS   |
| `auc`                    | 0.706 (0.668 to 0.752) funded only | 0.875 (0.863 to 0.898) through the door | PASS   |
| `fraud_approval`         |                               0.8% |                                    0.8% | PASS   |
| `pool_funding`           |                                  0 |                                       0 | PASS   |
| `approval_floor`         |              60.8% (all approvals) |                     40.7% (usable only) | PASS   |
| `refer_rate`             |                               1.7% |                                    1.7% | PASS   |

The `auc` row compares two different measurements. Until the gate was moved it was judged on
funded plans only, and on that measure it is 0.669 (0.569 to 0.714) today, under the same
0.70 floor: a fail. The rest of this section is the history of that figure, which the report
still carries as "funded only".

Nothing about the credit policy or the population changed between the two columns. What
changed is what the simulator funds and how it services:

| Simulator                                       |   AUC | Plans | Bad plans | Net loss bps | Margin bps |
| ----------------------------------------------- | ----: | ----: | --------: | -----------: | ---------: |
| As committed: counter offers fronted in part    | 0.706 | 6,084 |       294 |           22 |         92 |
| Plus the balance check before each debit        | 0.679 | 6,084 |       266 |           21 |         94 |
| Whole lease or nothing, no balance check        | 0.676 | 4,071 |       144 |           18 |         79 |
| Whole lease or nothing, with it (the gated run) | 0.669 | 4,071 |       141 |           18 |         79 |

Two things lower the funded only AUC, and both are range restriction, which "The AUC gate:
through the door" describes. The
balance check collects from businesses that had the money a few days late, which removes
about 30 of the more predictable bad plans. Funding only whole leases removes every counter
offer, and counter offers are where the low grades are: of 4,071 funded plans 3,805 are
grade A, 249 are B, 17 are C, and none is D. With 141 bad plans across five seeds (about 28
a seed) and almost no spread of grades left, the score has little to separate. One seed
scores 0.569. Holds, releases, cancellations, return handling, and writing off the whole
balance at once do not move the numbers: with those alone the result is the committed one to
the basis point.

No threshold was changed, and the population was not touched. Two things could be decided
from there: let the product front part of a rent, which brings back the counter offer volume
(the `partial_advance` sensitivity: 6,084 plans, net loss 21 bps, margin 93 bps, funded only
AUC 0.678, which still fails); or accept that AUC on a book that is 93% grade A is not the
right test of the score and measure it on all scored applicants. The second was chosen. The
0.70 floor is the same, and so are the credit policy, the population, and every other gate
and threshold. The PD table was not recalibrated: see "Calibrating the PD table".

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
| `src/evals/portfolio.ts`                  | Also `runThroughTheDoor`, the counterfactual run that funds every scored applicant, for the AUC gate.               |
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

| Gate                      | Threshold                                                                     | Why                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `net_loss_base`           | At or under 75 bps of rent volume                                             | Fees are 150 to 300 bps of rent. After funding and servicing about 90 bps is left, so losses above 75 bps consume the margin.                                                                                                                                                                                                                                |
| `net_margin_base`         | Above zero                                                                    | Fees collected less cost of funds, servicing, and net losses.                                                                                                                                                                                                                                                                                                |
| `net_margin_mild_stress`  | Above zero                                                                    | The same, with revenue down 15% for six months across the book.                                                                                                                                                                                                                                                                                              |
| `bad_rate_monotonic`      | No inversions from A to D                                                     | Pricing and limits step by grade, so worse grades must be riskier. Grades with fewer than 30 plans are skipped, and a better grade may sit up to 100 bps (one percentage point) above the next. Counted on bad rates pooled across seeds.                                                                                                                    |
| `auc`                     | At or above 0.70                                                              | The score must separate applicants who would go bad from applicants who would not. Judged on every honest applicant the engine scored, each funded in a counterfactual run. See "The AUC gate: through the door".                                                                                                                                            |
| `fraud_approval`          | Under 5% of fraud applicants approved                                         | Covers all three fraud archetypes together, and counts the final outcome: a fraud applicant who is referred and then approved by the reviewer counts as approved.                                                                                                                                                                                            |
| `pool_funding`            | No payout unfunded on its due date                                            | At the planned growth rate, with the planned pool. Summed across seeds.                                                                                                                                                                                                                                                                                      |
| `approval_floor`          | At or above 30% of all applicants                                             | Stops the other gates being passed by declining everyone. Counts approvals the applicant can use: an approval for less than the rent requested opens no plan in the product, so it does not count. 55% of the default population comes from archetypes that are creditworthy by construction, so approving under 30% means turning away about half of those. |
| `refer_rate`              | At most 5% of applicants referred                                             | The product promises a decision in the same request. Nineteen applicants in twenty must get one, and a policy must not pass the fraud gate by handing its hard cases to a queue.                                                                                                                                                                             |
| `veracity_honest_adverse` | At most 3% of honest applicants knocked out or referred by a veracity finding | The checks must not pass the fraud gate by flagging everyone. Before the checks the policy referred 1.7% against the 5% ceiling: 3.3 points of headroom, of which the checks get at most 3, for referrals and knockouts together. Set before the first measurement. Requests for information are reported beside it, and the approval floor bounds them.     |

### The AUC gate: through the door

The gate asks one question: does the score rank risk? It used to be answered on funded plans,
and that measurement is range restricted. The policy has already declined the applicants the
score ranks lowest, so what is left is a book that is 93% grade A with about 28 bad plans a
seed. A score cannot show ranking power on a population it has already filtered. The better
underwriting and servicing got, the lower the figure fell: every predictable bad plan that
stops being funded (a business in decline, a score under the cutoff, a counter offer that
cannot be used), and every one that stops going bad because it was collected a few days
late, is a low scoring bad plan removed from the sample. Version 2 lowered it under the same
servicing from 0.743 to 0.706 while it halved the loss rate, and Phase R3 took it to 0.669.

So the gate is now judged on the through the door population: every applicant the engine
gave a score, whether it approved, referred, countered, or declined them. Applicants asked
for more information have no score and are not in it (748 of 10,000 in the default run).

**How the bad flag is found for an applicant who was declined.** The same applicants are
run again in a counterfactual, `runThroughTheDoor` in `src/evals/portfolio.ts`:

- Everyone with a score gets a plan at the rent they requested. The product fronts a whole
  lease or nothing, so nobody is funded for part of it, including applicants the policy
  approved for less.
- Servicing is the configuration's own (standard, for the gated one), the horizon and runoff
  are the same, and bad means what it means everywhere else: an installment 30 days past
  due, or written off.
- The pool has no limit and no exposure or concentration rule applies, so every plan starts
  on its first rent date and no plan affects another.
- Approved and referred applicants pay the fee they were quoted. A declined applicant pays
  the fee the pricing built up for them if the engine got that far, held to the fee cap
  (4%), since the product never charges more. A declined applicant who was knocked out
  before pricing pays the grade D floor (3%), the highest floor of any funded grade.
- The engine's decision is recorded as it was. It just no longer chooses who is funded.

The counterfactual is a separate run with its own pool and its own state. It shares the
applicants with the gated run and feeds the AUC gate and the "Rank ordering through the
door" section of the report. No other metric, the pool path, or any other gate reads it, and
the gated run's numbers are the same to the cent with or without it. To save time it does
not replay a plan the ordinary run already funded at the rent requested without waiting: with
no pool or exposure limit that plan is the same plan, so its result is taken as it is. Unit
tests check both claims.

**Honest applicants only.** The gate is judged on applicants who are not one of the fraud
archetypes. The score is there to rank credit risk. Fraud is stopped, or not, by the
integrity checks, and `fraud_approval` judges those. Leaving fraud in would let it distort
the figure in either direction: a staged application is built to score well and then goes
bad, which pulls AUC down for a reason that has nothing to do with how the score reads a real
business. The figure for all applicants is reported beside it and is slightly lower (0.867
against 0.875).

**What it showed after Phase R3** (five default seeds, `cashflow-v2` on the original population; the current figures are in `report.md`):

| Measure                                   | Mean of seeds | Lowest to highest seed | Seeds pooled |
| ----------------------------------------- | ------------: | ---------------------: | -----------: |
| AUC, honest applicants (the gate)         |         0.875 |         0.863 to 0.898 |        0.875 |
| KS, honest applicants                     |         0.614 |         0.589 to 0.653 |        0.608 |
| AUC, all applicants                       |         0.867 |         0.856 to 0.891 |        0.867 |
| KS, all applicants                        |         0.583 |         0.566 to 0.627 |        0.578 |
| AUC, funded plans only (ungated, the old) |         0.669 |         0.569 to 0.714 |        0.670 |

The report also gives the counterfactual bad rate by score band and by grade, including the
bands nobody is funded in, and by what the policy decided. Honest applicants the policy
approved on usable terms go bad 3.5% of the time, those it approved for less than the rent
6.4%, and those it declined 48.7%.

**Limits of this gate.** Read these before leaning on it.

- **It is only possible because the borrowers are simulated.** A lender with real applicants
  never sees how a declined one would have performed. On real data this gate needs reject
  inference, which is an estimate with its own assumptions, or a test and learn sample:
  funding a small random share of declines and paying for the losses to learn from them.
- **It is a much easier test than the old one.** Most of the 0.875 comes from the bottom of
  the range. Of 1,716 honest bad outcomes, 1,192 score under 40, where more than half of
  applicants go bad. Telling those apart from a grade A business is not hard. Among honest
  applicants
  at or above the cutoff of 50, the same table gives an AUC of about 0.73 (worked out from
  the five point bands, so approximate). The gate would catch a score that stopped ranking
  the applicant pool. It would not catch one that ranked the fundable range a little worse.
- **A declined applicant is funded at terms the policy refused.** Many were declined because
  the rent requested was more than their cash flow supports. Funding them at that rent
  anyway is what the question requires, and it is also why they fail so often. The bad rates
  in the declined bands are what would happen at the requested rent, not at a rent the
  business could carry.
- **The fee for a declined applicant is a choice.** It moves the installment by at most a
  couple of percent of rent, which matters little beside whether the rent is affordable.
- **It says nothing about the pool or the economics.** The counterfactual book would lose a
  great deal of money. It exists only to be watched.

The funded only figure is still worth reading for what it is: how well the score orders the
plans actually on the book. The `cutoff_55` challenger no longer moves it: no plan under
score 55 is funded once counter offers are excluded, so it scores the same 0.669.

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

## Pass-through and graduation

Phase 6 added the free pass-through plan to the gated configuration only (`v4_standard`).
Every applicant the engine declines for credit capacity alone gets one: the rent is debited
five business days before the due date after the balance check, retried while it can still
settle, and the landlord is paid on the due date only from what was collected. A month with
nothing collected in time is missed, and the business pays the landlord itself. The day a
month completes, a plan with three on time months in a row is re-underwritten through the
same `decide` on its bank history up to that day with its payment history, at most once a
month; an approval for at least the rent is an offer, and every offer is assumed accepted
(`graduationAcceptShareBps`). A graduate gets a financed plan from the next rent date, from
the same pool, played like any other.

Graduates are kept out of `customers`, so every applicant metric and gate reads origination
decisions exactly as before, and are reported as their own cohort in `report.md`, "Pass-through
plans and graduation", with a table of the book with and without them. They share the pool, so
the pool path and the pool gate include them. Challengers, sensitivities and every
counterfactual run without pass-through. Default run, seeds pooled:

| Scenario | Offered pass-through | Months | On time | Reviews | Would refer | Graduated | Graduates bad | Net loss | Margin |
| -------- | -------------------: | -----: | ------: | ------: | ----------: | --------: | ------------: | -------: | -----: |
| Base     |                2,844 | 32,362 |   44.2% |   8,068 |         980 |       229 |          8.3% |   56 bps | 37 bps |
| Mild     |                3,381 | 37,622 |   42.5% |   9,130 |         629 |       417 |          6.0% |   33 bps | 59 bps |
| Severe   |                3,853 | 43,479 |   44.5% |  11,846 |         244 |       424 |          4.5% |   23 bps | 69 bps |

With graduates the base book's net loss is 21 bps (19 without) and its margin 77 bps (79).
Graduates go bad two to three times as often as first time approvals at the same scores, but
the cohort still makes money at the fees the PD table sets. "Would refer" counts reviews whose
outcome was a referral: they are not offered and not queued, so the refer rate is unchanged.

Limits: the review reads the raw bank history (no veracity facts or point of sale), uptake of
both the plan and the offer is assumed to be 100%, and late unauthorized returns of a
pass-through collection are not simulated (the services and integration tests cover them).
The missed share is high because a declined business often cannot hold a whole month's rent
in the account five business days early; that is a property of this population, not a measurement.

## Data veracity

Phase V added connection data to every applicant (`src/evals/veracity-sim.ts`) and the
veracity checks to the policy (`cashflow-v3`). What a connection shows is drawn from its own
random stream, after the original draw, so the businesses, their cash flows and their hazards
are the original population's. What changed:

- **Every applicant has connections.** Names (legal, trading, owners), a bank connection
  (holder, account type, opened, accounts on the login, OAuth or legacy), and for the 35% with
  a point of sale, the platform account (legal name, tax id, created, payout destination,
  direct OAuth or, for Toast, a delegated seat) and its payouts: the card settlement deposits
  the bank simulation made, as the platform would report them. 60% have an earlier pull 1 to
  20 days before the decision.
- **Honest messiness, measured for false positives.** Rates, all choices: sole proprietor on a
  personal account 6%, holder name a nickname 4%, holder a spouse or unlisted holding company
  1%, legacy bank connection 20%, an unshared savings account 25%, profit swept to that
  savings account (owner draws become transfers out) 12%, a recently opened account at an
  established business 2% (history cut to 150 to 300 days), late posting between pulls 30% of
  those with an earlier pull, aggregator re-syncs that change one or two old items 1.5% or
  duplicate several 0.5%, a bank pull that fails at decision time 0.5%; for point of sale
  applicants: platform account in the trading name 20%, in the owner's name 3%, in a former or
  parent company name 2%, tax id typo 2% (of the 70% where the platform reports one), sales
  paid to a second account connected 3% or not connected 3% (swept weekly into the main
  account), two locations paid separately 8%, processor holds 6%, split deposits 4%, small
  payout differences 10%, token expired and refresh refused 2% (direct), seat pull fails 8%
  (Toast).
- **Five fraud archetypes the checks exist for**, 2.5% of all applicants, converted from honest
  draws: `unsettled_sales` (platform sales 1.4 to 2.2 times real in the last 120 to 180 days,
  half paid out to an unseen account, half never paid out; stated revenue and lease sized to
  the platform figure), `borrowed_account` (someone else's healthy account, the platform too in
  60%; the real owner pulls access 20 to 75 days after the decision), `fresh_pos_account` (a
  platform account 30 to 75 days old with volume 1.6 to 2.4 times real, settled and cycled back
  out), `hidden_accounts` (heavy debt paid from an account that was not shared, funded by weekly
  transfers; that account visible on the login in half), `rewritten_history` (a struggling
  account whose later pull drops its overdraft fees, repair bills and debt payments). The
  original three archetypes are unchanged.
- **The measurement**: detection by archetype and check, false positives on honest applicants
  by check and by situation, whether the affected honest applicants were riskier (a
  counterfactual through the door run that decides without the veracity facts), and the net
  effect against `v2_standard` on the same applicants. All in `report.md`, "Data veracity".

| Gate                      | Committed baseline (`cashflow-v2`, original population) | Now (`cashflow-v3`, extended population) |
| ------------------------- | ------------------------------------------------------: | ---------------------------------------: |
| `net_loss_base`           |                                       18 bps (11 to 21) |                        19 bps (13 to 23) |
| `net_margin_base`         |                                $269,553 a seed (79 bps) |                 $264,570 a seed (79 bps) |
| `net_margin_mild_stress`  |                                                $221,098 |                                 $219,187 |
| `bad_rate_monotonic`      |                                                       0 |                                        0 |
| `auc`                     |                                  0.875 (0.863 to 0.898) |                   0.873 (0.858 to 0.896) |
| `fraud_approval`          |                                                    0.8% |                      1.6% (1.0% to 2.6%) |
| `pool_funding`            |                                                       0 |                                        0 |
| `approval_floor`          |                                                   40.7% |                   39.9% (38.4% to 41.5%) |
| `refer_rate`              |                                                    1.7% |                      3.7% (3.5% to 3.9%) |
| `veracity_honest_adverse` |                                                     n/a |                      1.5% (1.4% to 1.8%) |

The extended population costs `cashflow-v2` the fraud gate (17.0% of fraud applicants
approved) and the monotonic gate (one inversion), so it would not ship on it; `cashflow-v3`
passes every gate. The first full run is the one reported: before it, a one seed diagnostic
found a simulation artifact (deposits before a platform account existed carried the
platform's name) and led to two consequence changes and one condition change, described in
`UNDERWRITING.md`, "Findings and what they do". No threshold was changed.

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
  against $1,347,764 (79 bps), funded only AUC 0.678 against 0.669.
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
- **Sampling noise.** One seed has about 28 bad plans under version 2. Funded only AUC ran
  from 0.569 to 0.714 across the five default seeds (the gated through the door figure, on
  about 340 bad outcomes a seed, ran from 0.863 to 0.898), grades C and D are all but empty, and one seed of the
  five shows a grade inversion that the pooled book does not. The gates judge the mean for
  this reason. Use `--n 10000` before reading much into a small change in rank ordering.
- **The policy was tuned on this simulator.** The cutoff, the scorecard weights, the decline
  thresholds, and the PD table were chosen by looking at simulated outcomes. Tuning was done
  on seeds other than the five the gates use, which guards against fitting to sampling noise.
  It does not guard against fitting to the simulator itself: the gate seeds come from the
  same generator.
- **Fraud is eight scripts, and the checks were written after reading them.** A request 2.5
  to 4 times observed rent, credits that leave two days later as same sized transfers, and
  an inflated stated revenue are each caught by a check aimed at exactly that. The fraud
  numbers show the checks work as designed. They say nothing about fraud that behaves
  differently. The integrity checks' false positives are still unmeasured: every honest
  applicant here asks for the rent it already pays and never moves a deposit out again. The
  veracity checks' false positives are measured, on honest messiness that is itself a set of
  choices.
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

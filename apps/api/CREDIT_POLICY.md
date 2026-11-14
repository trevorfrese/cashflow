# Credit policy

This is CashFlow's credit policy, written the way a lending operation would write one for its
credit committee: what the product is, who qualifies, how a decision is made, who may change
it, how the book is serviced and reserved, and what has to be true before any of it changes.

It is a reference document for a sandbox. CashFlow never lent real money, every applicant in
its evaluation is synthetic, and every number below was set against a simulation. This is not
legal advice: where a rule follows a regulation it is a working reading, and the open questions
are in [`COMPLIANCE.md`](../../COMPLIANCE.md).

The code is the policy. Every number here is read from the file cited beside it, and where the
two disagree the code is right and this document is wrong. The mechanics behind each number
(features, curves, checks) are in [`UNDERWRITING.md`](UNDERWRITING.md); the servicing and
ledger mechanics are in [`ARCHITECTURE.md`](../../ARCHITECTURE.md); the evidence is in
[`evals/report.md`](evals/report.md).

**In short**

- **In force: `cashflow-v5`** under the `standard` servicing policy. Every change is a new
  version and ships only when all 11 evaluation gates pass in strict mode (section 14).
- **Financed plan:** one month's rent paid in full, repaid in two (or four) installments, fee
  1.5% to 4% of rent, never under $20, no late fees. Limits start at $10,000 a month and climb
  to $40,000 with on time history.
- **Decisions:** an eight factor scorecard (cutoff 50), knockout rules only where there is no
  innocent reading, referrals for anything a person could verify, and missing information is
  never a decline.
- **Authority:** a reviewer approves up to $10,000 a month; above that, and every tighten-only
  control, is an admin's. Overrides need a reason code and are audited (section 9).
- **Servicing:** 3 day grace, debits on days 0, 3 and 6, payouts held while past due, charge-off
  at 90 days, reserves at the measured roll rate plus 25% (section 11).

## Contents

1. [Policy in force and how versions work](#1-policy-in-force-and-how-versions-work)
2. [The product](#2-the-product)
3. [Eligibility and data requirements](#3-eligibility-and-data-requirements)
4. [The scorecard and grades](#4-the-scorecard-and-grades)
5. [Knockout rules](#5-knockout-rules)
6. [Pricing](#6-pricing)
7. [Limits and exposure](#7-limits-and-exposure)
8. [Escalation matrix](#8-escalation-matrix)
9. [Reviewer authority and overrides](#9-reviewer-authority-and-overrides)
10. [The pass-through plan and graduation](#10-the-pass-through-plan-and-graduation)
11. [Servicing](#11-servicing)
12. [Periodic re-underwriting](#12-periodic-re-underwriting)
13. [Monitoring and the circuit breaker](#13-monitoring-and-the-circuit-breaker)
14. [Change control](#14-change-control)
15. [Known gaps](#15-known-gaps)

## 1. Policy in force and how versions work

**In force: `cashflow-v5`** (`CURRENT_POLICY` in `src/underwriting/policy.ts`), under the
`standard` servicing policy (`ACTIVE_SERVICING_POLICY` in `src/servicing/policy.ts`).

| Version       | Status  | What it added                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------- |
| `cashflow-v1` | Retired | The launch policy. Kept so the evals can run it as the comparison                             |
| `cashflow-v2` | Retired | Integrity checks, earlier decline detection, expected loss pricing, exposure rules, referrals |
| `cashflow-v3` | Retired | The data veracity checks and a data depth factor that reads them                              |
| `cashflow-v4` | Retired | The payment history factor, and graduation from the pass-through plan. Otherwise version 3    |
| `cashflow-v5` | Current | Graduates of the pass-through plan priced on their own PD. Otherwise version 4                |

How versions work:

- Every number the engine uses lives on one `CreditPolicy` object. The engine takes the policy
  as an argument (`decide(input, policy)`), so the evals can run two versions on the same
  applicants.
- Every stored decision carries the `policyVersion` that made it and a snapshot of the
  thresholds in force (`thresholdsInForce`). `POLICIES` maps each version to its object, so a
  stored decision can always be read back against the rules that made it.
- A retired version is never edited. It documents history.
- A change to any number is a new version, and ships only through change control (section 14).

Version 4 decides exactly as version 3 for any applicant without payment history with
CashFlow: the factor is absent, not zero. Version 5 decides exactly as version 4 for everyone
but a graduation review. The evals check both (`v3_standard`, `v4_standard` and `v5_standard`
give the same origination decisions).

### Change log

**`cashflow-v5`, with the standard servicing reserve rates re-set** (November 2026). Measured
on the default evaluation (5 seeds of 2,000 applicants), before (`cashflow-v4`) and after:

| What                                              | Why                                                                                                                         | Before                                        | After                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| Graduate pricing (`graduation.graduatePricing`)   | Graduates went bad 2.1 to 2.3 times as often as first time approvals at the same scores, at first time prices               | 229 graduates, fee 158 bps, margin 37 bps     | 227 graduates, fee 195 bps, margin 72 bps     |
| Graduate bad rate against first time, same scores | Unchanged by design: version 5 prices the gap, it does not select it away                                                   | 8.3% against 4.0%                             | 8.4% against 3.8%                             |
| Reserve rates (`STANDARD_SERVICING_POLICY`)       | The CURRENT reserve (0.40%) had fallen below the measured roll to charge-off (0.42%, 0.44% on entry). Now measured plus 25% | 0.40%, 85%, 95%, 100%                         | 0.55%, 99.35%, 100%, 100%                     |
| Origination book, every gate                      | Unchanged: first time decisions are version 4's                                                                             | 11 of 11 pass, net loss 19 bps, margin 79 bps | 11 of 11 pass, net loss 19 bps, margin 79 bps |
| Book with graduates, base                         |                                                                                                                             | Net loss 21 bps, margin 77 bps                | Net loss 21 bps, margin 78 bps                |

The PD table was not regenerated: the scorecard, cutoffs and servicing that it was calibrated
under did not change, and the multiplier is measured against it. Grade B graduates still lose
money (20 plans, 20% bad, -67 bps), too few to price separately; see section 15. The same
release, outside the credit policy: a trust failure at periodic review now freezes the plan and
alerts (section 12), re-underwriting reads time in business on the review date, a freeze sends
an adverse action notice, and a pass-through return after the landlord was paid is serviced as
a receivable (section 10).

## 2. The product

**The financed plan.** CashFlow pays the landlord the whole month's rent on the due date from
its capital pool. The business repays that rent plus a fee in installments.

| Term             | Rule                                                                                       | Where                                         |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| What is financed | One month's rent on one lease, in full, or nothing                                         | `createRentPlan`, `src/services/rent-plan.ts` |
| Installments     | Two a month by default: the due date and 14 days later. Four (a week apart) when suggested | `packages/shared/src/money/schedule.ts`       |
| Fee              | A percentage of rent per period, 1.5% to 4%, never under $20                               | `src/underwriting/pricing.ts`                 |
| Late fees        | None                                                                                       |                                               |
| Smallest rent    | $500 in practice: the $20 minimum fee is 4% of $500                                        | `expectedLossPricing`, `policy.ts`            |
| Largest rent     | $10,000 a month for a new customer, up to $40,000 with history (section 7)                 | `exposure.ladder`, `policy.ts`                |
| Limit increments | Limits are rounded down to $100                                                            | `limitIncrementCents`                         |

**Whole lease or nothing.** An approval for less than the rent requested (a counter offer)
cannot open a plan on that lease: CashFlow does not pay part of a month's rent and leave the
tenant to pay the rest. A counter offer is therefore an adverse action, and the applicant gets
a notice if it is not taken up (see [`UNDERWRITING.md`](UNDERWRITING.md), "Notices").

**Installment cadence.** The engine suggests four installments a month for a business with
deposits on 15 or more days a month and either under 21 days of cash on hand or revenue that
varies more than 35% month to month (`recommendInstallments`, `src/underwriting/engine.ts`).
Everyone else gets two.

**The pass-through plan** is a separate, free product for applicants declined for credit
capacity. It extends no credit. See section 10.

## 3. Eligibility and data requirements

**Data.** CashFlow decides only on data it pulled itself through a connection the owner
authorized. There is no upload path. Details are in [`DATA_CONNECTIONS.md`](DATA_CONNECTIONS.md).

| Requirement                       | Rule                                                                                    | If not met                                       |
| --------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A connected business bank account | Required                                                                                | Needs info: connect a bank                       |
| Bank history                      | 6 full months of transactions (`minMonthsOfHistory`)                                    | Needs info                                       |
| Fresh data                        | A snapshot pulled within 1 day of the decision, newest item within 7 days (`freshness`) | Pulled again; on failure, needs info (reconnect) |
| Stated revenue                    | Within 50% above verified revenue (`maxStatedRevenueVarianceBps`)                       | Needs info: connect other accounts or correct it |
| A point of sale                   | Optional. Used for revenue only when it reconciles with the bank (section 4)            | Decided on the bank alone                        |
| Identity                          | The business and its owners verified, and screening clear (section 8)                   | Referred or declined                             |

Missing information is never a decline. It is a request for information
(`NEEDS_INFO`) that names what to provide.

**Eligibility rules.** All in `CreditPolicy` (`src/underwriting/policy.ts`). Each one declines
on its own; see section 5 for the full list.

| Rule             | Threshold                                                    |
| ---------------- | ------------------------------------------------------------ |
| Time in business | At least 6 months, as stated                                 |
| Verified revenue | At least $5,000 a month (mean of the last three full months) |
| Rent share       | Requested rent at most 40% of verified monthly revenue       |
| Free cash flow   | Positive after operating costs, owner draws and debt service |
| Score            | At least 50                                                  |

## 4. The scorecard and grades

A transparent scorecard, not a fitted model. Eight factors with weights summing to 100, each a
piecewise linear curve over one feature, each producing a reason the applicant can read
(`src/underwriting/scorecard.ts`). The curves and features are in
[`UNDERWRITING.md`](UNDERWRITING.md), "Features" and "Scorecard".

| Factor             | Weight | What earns full marks                                                             |
| ------------------ | -----: | --------------------------------------------------------------------------------- |
| Cash buffer        |     30 | 60 or more days of cash on hand, never under 30 in the last 90 days               |
| Cash flow coverage |     15 | Free cash covers the rent 2.0 times                                               |
| Account conduct    |     15 | No overdraft fees or negative balance days                                        |
| Rent affordability |     10 | Rent at or under 10% of verified revenue                                          |
| Revenue stability  |     10 | Month to month variation at or under 15%                                          |
| Revenue trend      |     10 | Up 10% or more, season adjusted when a year of history allows                     |
| Existing debt      |      5 | Debt service at or under 3% of revenue                                            |
| Data depth         |      5 | 12 months of bank history on a trusted connection, and a reconciled point of sale |

**Payment history** (version 4) sits outside the weights. A business with rent paid through
CashFlow in the last 12 months gains 2 points per month in its current run of on time months
(at most 8), and loses 4 per late month and 10 per missed month (at most 20)
(`PAYMENT_HISTORY_POLICY_V4`). Without history it is absent and changes nothing.

**Grades** (`gradeFloors`):

| Grade | Score     | Fee floor | Largest rent as a share of revenue |
| ----- | --------- | --------: | ---------------------------------: |
| A     | 80 to 100 |      1.5% |                                30% |
| B     | 68 to 79  |      2.0% |                                25% |
| C     | 55 to 67  |      2.5% |                                20% |
| D     | 45 to 54  |      3.0% |                                15% |
| F     | under 45  |           |                                 0% |

The cutoff is 50 (`minScore`), so the lower half of grade D is declined and the upper half
(50 to 54) is always referred (section 8). Why 50: it is the lowest five point band that kept a
positive net margin under mild stress in two independent simulation runs
([`UNDERWRITING.md`](UNDERWRITING.md), "The cutoff, and grade D").

**What the weights are.** Judgment informed by a simulation of synthetic businesses, not
coefficients fitted to real repayment. They must be refitted on real outcomes before real
capital is lent.

## 5. Knockout rules

Applied after scoring, in this order (`decide`, `src/underwriting/engine.ts`). Any one declines.
The scorecard reasons are still returned. The applicant is told at most four principal reasons,
chosen by `selectPrincipalReasons` (`packages/shared/src/adverse-action/principal.ts`).

**Trust knockouts.** No innocent reading, and nothing a reviewer could verify would change it.

| Knockout                                                                                                        | Source                                  | Applicant reason code             |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------- |
| Round trip deposits: 3 or more credits matched by a same sized transfer out within 4 days, 10% or more of sales | `ROUND_TRIP_DEPOSITS`, integrity        | `UNVERIFIED_DEPOSITS`             |
| A lease's landlord payout account is one of the business's own linked accounts                                  | `LANDLORD_IS_APPLICANT_ACCOUNT`         | `LANDLORD_ACCOUNT_MATCH`          |
| The identity provider could not find the business or an owner                                                   | `IDENTITY_VERIFICATION_FAILED`          | `IDENTITY_NOT_VERIFIED`           |
| Bank history rewritten between pulls (debits removed from a closed period)                                      | `HISTORY_REWRITTEN`, veracity           | `ACCOUNT_HISTORY_NOT_VERIFIED`    |
| Bank and platform both name another business as the account holder                                              | `BOTH_SOURCES_OTHER_BUSINESS`, veracity | `ACCOUNT_OWNERSHIP_NOT_CONFIRMED` |

**Credit knockouts.**

| Rule                                       | Threshold                                                                                                                                                         | Reason code                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Time in business                           | Under 6 months                                                                                                                                                    | `TIME_IN_BUSINESS`                                          |
| Verified revenue                           | Under $5,000 a month                                                                                                                                              | `REVENUE_TOO_LOW`                                           |
| Overdraft fees                             | More than 2 in 90 days                                                                                                                                            | `EXCESSIVE_OVERDRAFTS`                                      |
| Negative balance days                      | More than 10 in 90 days                                                                                                                                           | `NEGATIVE_BALANCE_DAYS`                                     |
| Rent share                                 | Over 40% of verified revenue                                                                                                                                      | `RENT_EXCEEDS_REVENUE_SHARE`                                |
| Quarter over quarter decline               | Last 3 full months more than 25% below the 3 before                                                                                                               | `REVENUE_DECLINING`                                         |
| Earlier decline, with a year of history    | Last 4 weeks down more than 15% on a year ago (or 1.5 times the business's own monthly variation, if larger), and last 12 weeks down at least 5% on the 12 before | `REVENUE_DECLINING`                                         |
| Earlier decline, without a year of history | Last 12 weeks down more than 20% on the 12 before                                                                                                                 | `REVENUE_DECLINING`                                         |
| Decline with a thin buffer                 | Under 14 days of cash and revenue down more than 10% on the same measure                                                                                          | `DECLINE_WITH_THIN_BUFFER`                                  |
| Free cash flow                             | Zero or negative                                                                                                                                                  | `NEGATIVE_FREE_CASH_FLOW`                                   |
| Score                                      | Under 50                                                                                                                                                          | `SCORE_BELOW_MINIMUM` (never a principal reason on its own) |

**Capacity and price declines** come after the limit is solved (sections 6 and 7):

| Outcome                                                | Reason code                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| No capacity at all                                     | `INSUFFICIENT_CAPACITY`                                                                              |
| The business already holds as much as one business may | `EXPOSURE_LIMIT_REACHED`                                                                             |
| The fee needed is above the 4% cap                     | `FEE_ABOVE_MAXIMUM`, or `RENT_BELOW_MINIMUM` when the fixed cost of servicing is what pushes it over |
| The limit is under half the rent requested             | `INSUFFICIENT_CAPACITY`, `RENT_NOT_VERIFIED`, or `EXPOSURE_LIMIT`, naming the cap that bound         |

The principle: decline automatically only on a pattern with no innocent reading. Anything an
honest business could explain goes to a reviewer, or limits the amount, or asks for
information.

## 6. Pricing

`src/underwriting/pricing.ts`, on `expectedLossPricing` in `policy.ts`. The fee is set from
expected loss and cost, then held to a floor and a cap.

```
fee = max(grade floor, expected loss + cost of funds + servicing + margin, $20 minimum)
      rounded up to 5 bps, per rent period
```

| Part          | Value                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| Expected loss | PD for the score band times loss given default (60% of one month's rent), over 11.7 expected periods |
| Cost of funds | 12% a year on the rent while it is out: about 24 bps with two installments, 35 bps with four         |
| Servicing     | $12 per plan per month, as a share of the rent                                                       |
| Margin        | 40 bps                                                                                               |
| Grade floor   | A 1.5%, B 2.0%, C 2.5%, D 3.0%                                                                       |
| Minimum fee   | $20 a period                                                                                         |
| Fee cap       | 4% of rent a period. A fee needed above it is a decline, never a capped approval                     |

**The PD table** (`src/underwriting/pd-table.ts`, `PD_TABLE_V2`) is generated by
`pnpm --filter @cashflow/api eval:calibrate` from 20,000 synthetic applicants on seeds the gates
are not judged on. It runs from 20.9% in the lowest funded band (50 to 54) to 1.7% in the highest
(95 to 100). It was calibrated under version 2 and has not been regenerated for versions 3 to 5;
the reasons are in [`UNDERWRITING.md`](UNDERWRITING.md), "The PD table". On the default
evaluation most fees are set by the grade floor; the build up binds on small rents.

**Fee at plan opening.** When a plan opens on a lease smaller than the approved limit, the rate
is raised if needed so the fee is still at least $20, and a lease too small to serve inside the
cap is refused.

## 7. Limits and exposure

The approved limit is the smallest of these (`approvedLimit`, `src/underwriting/exposure.ts`):

| Cap                | Rule                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The request        | An approval is for the lease in front of us, never more                                                                                               |
| Capacity           | The largest rent that is at most the grade's share of verified revenue (A 30%, B 25%, C 20%, D 15%) and that free cash covers 1.25 times with the fee |
| Observed rent      | At most 1.2 times the rent already seen leaving the bank account, unless a reviewer verified the lease                                                |
| The limit ladder   | Across all of a business's financed plans: $10,000 a month at first, $20,000 after 3 on time periods, $40,000 after 6                                 |
| Business aggregate | $40,000 a month across all of one business's plans and leases, whatever its history                                                                   |

An **on time period** for the ladder is a month of a financed plan whose landlord payout was
paid and whose installments were all paid inside the 3 day grace period with no payment ever
returned (`countOnTimePeriods`, `src/services/portfolio-state.ts`). Pass-through months do not
count toward the ladder.

If the limit is at least half the request (`minCounterOfferBps`, 50%), the decision is an
approval at the lower limit (a counter offer, `LIMIT_BELOW_REQUEST`). Below half it is a
decline naming the cap that bound.

**Funding rules.** These depend on the pool, not the business. Failing one never changes the
credit decision: the applicant is told the plan may wait (`FUNDING_QUEUE`), and the plan does
not open until there is room (`FUNDING_UNAVAILABLE`, `checkFunding`).

| Rule             | Ceiling                                            |
| ---------------- | -------------------------------------------------- |
| Pool utilization | Committed monthly rent at most 85% of pool capital |
| Industry share   | One industry at most 40% of pool capital           |
| Single name      | One business at most 5% of pool capital            |

"Committed" is monthly rent on active and paused financed plans. "Pool capital" is pool cash,
unswept operating cash, and receivables, read from the ledger.

**Rechecked at opening.** `createRentPlan` runs the limit, the ladder, the aggregate and the
three funding rules again on the day a plan opens, because a decision can be weeks old.

## 8. Escalation matrix

What each condition does to an application the engine would otherwise approve. Refer means the
application goes to the review queue (`IN_REVIEW`, decision `REFER`); the engine's
recommended terms are stored for the reviewer and not shown to the applicant. An application
the credit rules already decline is declined, not referred.

### Credit and amount

| Condition                                                                          | Action                                          | Trigger                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------ |
| Score under 55 (fewer than 5 points above the cutoff), read before payment history | Refer                                           | `SCORE_NEAR_CUTOFF`      |
| Limit above $10,000 a month (only reachable past the first ladder rung)            | Refer                                           | `AMOUNT_ABOVE_THRESHOLD` |
| Counter offer on a first plan                                                      | Not referred (`referCounterOfferBelowBps` is 0) |                          |
| Circuit breaker tripped                                                            | Refer every approval                            | `CIRCUIT_BREAKER`        |

### Integrity flags (`INTEGRITY_RULES`, `src/underwriting/integrity.ts`)

| Flag                                | Fires when                                                                      | Action     |
| ----------------------------------- | ------------------------------------------------------------------------------- | ---------- |
| `STATED_REVENUE_FAR_ABOVE_VERIFIED` | Stated revenue more than 50% above verified                                     | Needs info |
| `STATED_REVENUE_ABOVE_VERIFIED`     | More than 25% above                                                             | Inform     |
| `STATED_REVENUE_BELOW_VERIFIED`     | More than 40% below                                                             | Inform     |
| `POS_DEPOSIT_SHORTFALL`             | Bank deposits under 70% of point of sale net sales                              | Inform     |
| `POS_DEPOSIT_EXCESS`                | Bank deposits over 150% of point of sale net sales                              | Refer      |
| `ROUND_TRIP_DEPOSITS`               | See section 5                                                                   | Knockout   |
| `ROUND_TRIP_SUSPECTED`              | 2 or more round trips, 3% or more of sales                                      | Refer      |
| `NON_SALES_CREDIT_SHARE`            | Transfers in and loan proceeds over 30% of credits in 90 days                   | Refer      |
| `OWNER_TOP_UPS_BEFORE_APPLYING`     | Owner transfers in over 10% of monthly revenue in the last 30 days              | Inform     |
| `REVENUE_SPIKE`                     | Last 6 weeks more than 75% above the 20 before, not explained by last year      | Refer      |
| `SHORT_ACCOUNT_HISTORY`             | Account history more than 3 months shorter than time in business (up to a year) | Refer      |
| `RENT_ABOVE_OBSERVED`               | Requested rent more than 1.2 times the rent seen in the account                 | Cap        |
| `NO_RENT_OBSERVED`                  | No rent payments in the account                                                 | Refer      |
| `LANDLORD_IS_APPLICANT_ACCOUNT`     | See section 5                                                                   | Knockout   |
| `DUPLICATE_LANDLORD_ACCOUNT`        | Another user's business pays the same landlord account                          | Inform     |
| `DUPLICATE_BANK_ACCOUNT`            | Another user's business linked the same bank account                            | Refer      |
| `DUPLICATE_BUSINESS_IDENTITY`       | Another user has a business with the same legal name and address                | Refer      |

### Identity and sanctions screening

| Condition                                                                                           | Action                                                                                        |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Verification `FAILED` (the business or an owner not found)                                          | Decline (`IDENTITY_NOT_VERIFIED`, which the applicant can act on)                             |
| Verification in `REVIEW`, or never run (no tax id, no owner, a business that predates verification) | Refer (`IDENTITY_NOT_VERIFIED` flag)                                                          |
| Open possible match on the business, an owner, or a landlord                                        | Refer (`SCREENING_POSSIBLE_MATCH`)                                                            |
| Open match                                                                                          | Refer and hold (`SCREENING_MATCH`). Cannot be approved while open; only an admin can clear it |
| A hit on a running plan (business, owner, or landlord)                                              | The plan is frozen: no new period, payouts held                                               |
| A hit on the landlord of a new lease or a changed landlord                                          | No plan can open on that lease; a pending change cannot apply                                 |

A screening match is never a decline: declining would put what was found into the decline
reason. The applicant is told the application is in review and nothing else.

### Data veracity findings (`VERACITY_RULES`, `src/veracity/rules.ts`)

| Consequence             | Findings                                                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knockout                | `HISTORY_REWRITTEN`, `BOTH_SOURCES_OTHER_BUSINESS`                                                                                                                                                                          |
| Refer                   | `BANK_OWNER_MISMATCH`, `PLATFORM_NAME_MISMATCH`, `PLATFORM_TAX_ID_MISMATCH`, `SETTLEMENT_UNMATCHED`, `DEPOSITS_WITHOUT_PAYOUT`, `SALES_NOT_PAID_OUT`, `HISTORY_CHANGED`, `SALES_HISTORY_CHANGED`, `PLATFORM_NEW_WITH_SURGE` |
| Needs info              | `PAYOUT_ACCOUNT_NOT_CONNECTED`, `PAYOUTS_PARTLY_TO_UNSEEN_ACCOUNT`, `TRANSFERS_TO_UNSEEN_ACCOUNTS`, `BANK_DATA_UNAVAILABLE`                                                                                                 |
| Exclude the source only | `SETTLEMENT_LOW_MATCH`, `POS_REVENUE_NOT_IN_BANK`, `PLATFORM_DATA_UNAVAILABLE` (and every refer finding above that names a platform also excludes it)                                                                       |
| Reduce data depth       | `PLATFORM_ACCOUNT_RECENT`, `LEGACY_BANK_CONNECTION`                                                                                                                                                                         |
| Inform                  | `PERSONAL_ACCOUNT`, `UNSHARED_ACCOUNTS`, `TRANSFERS_FROM_UNSEEN_ACCOUNTS`, `HISTORY_MINOR_CHANGES`, `BANK_ACCOUNT_RECENT`, `DATA_GAP`, `DELEGATED_SEAT_SOURCE`                                                              |

A missing or failed connection is never a decline: a bank that cannot be pulled is a request to
reconnect; a platform is dropped from the decision. The full table with thresholds and
measured false positive rates is in [`UNDERWRITING.md`](UNDERWRITING.md), "Veracity".

### What the applicant is told

Never a flag, a finding, a trigger, a threshold or a score on a decline or referral. A referral
says the application is with a reviewer and when the answer is due. A decline gives at most four
principal reasons from the reason catalog with what would change each. See
[`UNDERWRITING.md`](UNDERWRITING.md), "Reasons and adverse action notices".

## 9. Reviewer authority and overrides

Operators reach the API with one of two tokens (`src/auth/admin.ts`). The person acting is named
in the `X-Admin-Actor` header and recorded on every audit event; no request body can set it.

| Action                                                                         |                        Reviewer                        |                Admin                |
| ------------------------------------------------------------------------------ | :----------------------------------------------------: | :---------------------------------: |
| Approve, decline, or request information on a referred or declined application |                          Yes                           |                 Yes                 |
| Approve a monthly limit above $10,000 (`reviewerApprovalCeilingCents`)         |                           No                           |                 Yes                 |
| Approve at terms other than the engine's                                       |                Yes, with a reason code                 |       Yes, with a reason code       |
| Approve a business that is not verified                                        |     Only with the `IDENTITY_VERIFIED` reason code      |              The same               |
| Clear a possible screening match                                               |                          Yes                           |                 Yes                 |
| Clear a screening match                                                        |                           No                           |                 Yes                 |
| Approve or reject a pending landlord change                                    |                          Yes                           |                 Yes                 |
| Lift a freeze on a plan                                                        | Yes, unless a screening hit is open or an admin set it | Yes, unless a screening hit is open |
| Send a returned landlord payout again                                          |        Yes, once corrected details have applied        |                 Yes                 |
| Reset the circuit breaker                                                      |                           No                           |         Yes, with a reason          |
| Pause new approvals (trip the circuit breaker by hand)                         |                           No                           |         Yes, with a reason          |
| Freeze a plan's next period                                                    |                           No                           |         Yes, with a reason          |
| Lower a business's limit, or take that cap off again                           |                           No                           |         Yes, with a reason          |
| Fund the pool, run jobs                                                        |                           No                           |                 Yes                 |

**Limits on any reviewer approval** (`src/services/reviews.ts`):

- The limit must be above zero and no more than the rent requested.
- The fee must be above zero and no more than the 4% cap. A reviewer may price below the
  engine's fee; that is an override and needs a reason code.
- No approval while the business has an open screening hit.
- Exposure and funding rules still apply when the plan opens.

**Dollar authority** (`reviewerApprovalCeilingCents` in `src/controls/policy.ts`). A reviewer
may approve a monthly limit up to $10,000. Above it only an admin approves, at the engine's
terms or the reviewer's. The check is on the limit actually approved, in the review service, so
a reviewer can still approve a lower limit (an override with `EXPOSURE_ADJUSTED`), decline, or
ask for information. The API answers `ABOVE_REVIEWER_AUTHORITY` (403) otherwise.

Why $10,000: it is the same line at which the engine stops approving alone (`referAmountCents`),
so a reviewer's authority reaches exactly as far as the engine's. A reviewer settles the flag or
the score that referred a case; an amount the engine would not approve on its own needs a
second, more senior person. One month fronted at $10,000 at the policy's loss given default is
about $6,000 lost if the plan goes bad, which is inside the single business cap on the sandbox
pool. The ceiling is its own number in the controls, not read from the credit policy, so a
credit policy change cannot quietly widen what one reviewer may approve. The console shows it
on the review page and the policy page.

**Tighten-only controls** (`src/controls/`). An admin can make the system stricter from the
operations console, and only stricter. Each control needs a typed reason, writes an audit event
in the same transaction as the change, is enforced by the API whatever the console shows, and
has an undo an admin can use:

| Control                | What it does                                                                                                                                                                           | Undo                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Pause new approvals    | Trips the circuit breaker with rule `manual` (section 13): an application the engine would approve is referred                                                                         | Reset the breaker                                  |
| Freeze a plan          | The periodic review's freeze, reason `OPERATOR_HOLD`: no new period, a payout that falls due is held                                                                                   | Release the freeze (admin only for this reason)    |
| Lower a business limit | Puts a cap on the business below its approved limit. The limit in force is the smaller of the two, for a new plan and for a rent increase. A running plan above the cap keeps its rent | Remove the cap: the decision's limit applies again |

A value at or above the limit in force is refused (`LIMIT_NOT_LOWER`). There is no route that
raises a limit: that is underwriting's, through a new application or a reviewer's decision.

**Overrides.** A review whose outcome, limit or fee differs from the engine's recommendation is
an override. It needs at least one reason code from `ReviewReasonCode`
(`packages/shared/src/schemas/underwriting.ts`):

| Code                            | Meaning                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `LEASE_VERIFIED`                | The lease was verified another way                             |
| `REVENUE_VERIFIED_OTHER_SOURCE` | Revenue was verified from another source                       |
| `IDENTITY_VERIFIED`             | Identity was verified another way; marks the business verified |
| `INTEGRITY_FLAG_CLEARED`        | The flag that referred it was explained                        |
| `INTEGRITY_FLAG_CONFIRMED`      | The flag was confirmed                                         |
| `FRAUD_SUSPECTED`               | Internal only                                                  |
| `DOCUMENTS_NOT_PROVIDED`        | The applicant did not provide what was asked                   |
| `COMPENSATING_FACTORS`          | Strengths the engine does not score                            |
| `EXPOSURE_ADJUSTED`             | The limit was changed                                          |
| `PRICING_ADJUSTED`              | The fee was changed                                            |
| `OTHER`                         | Internal only, with notes                                      |

These are internal. What the applicant is told on a reviewer's decline or request for
information must be picked from the reason catalog (`principalReasonCodes`), from the codes a
reviewer may give for that action; the review service refuses a decline without one.

**Override tracking.** An override is marked on the `ApplicationReview` row and on the decision
(`isOverride`), and writes its own audit event. Each review is a new current decision of kind
`REVIEW`; the engine's decision stays in the history. The audit log can be filtered by event
type and actor in the operations console.

## 10. The pass-through plan and graduation

**Who is offered it** (`passThroughEligibility`, `src/underwriting/pass-through.ts`): an engine
decline with at least one credit capacity reason and no trust reason. Never a referral, a
request for information, a reviewer's decision, or a decline with an integrity or veracity
knockout, a failed identity check, a landlord account that is the applicant's own, or a lease
far above the rent the account shows (`RENT_NOT_VERIFIED`). A pass-through plan moves the
business's money to a payee on its say so, so anything that questions who the business is or
whether the lease is real rules it out.

**Terms** (`STANDARD_PASS_THROUGH_POLICY`, `src/servicing/pass-through.ts`):

| Rule            | Value                                                                           |
| --------------- | ------------------------------------------------------------------------------- |
| Fee             | None. No late fee                                                               |
| Collection      | The whole rent, from 5 business days before the due date, after a balance check |
| Attempts        | At most 2, until 3 business days before the due date                            |
| Settlement      | 3 business days after the debit, before the landlord is paid                    |
| Landlord payout | On the due date, only from settled money                                        |
| Missed month    | CashFlow does not pay the landlord; the owner is told to pay directly           |
| Held payout     | Refunded to the business after 5 days                                           |

CashFlow advances none of its own money on a pass-through plan, so it carries no credit risk and
does not count toward the pool, the exposure caps, provisioning or the delinquency buckets. The
one way it can cost money is a collection returned after the landlord was paid (usually an
unauthorized return weeks later). Then the pool covers the rent and the business owes it: a
receivable (`LandlordPayout.passThroughPeriodId`, one installment of the rent, no fee, due the
day the return arrived) serviced exactly as a financed installment under section 11: retried on
the same schedule (after a hard or unauthorized code, only once the business links an account
again), aged through the buckets, provisioned, open to a manual payment, and charged off at 90
days past due with the same postings. While it is owed the plan collects and pays nothing new;
an unauthorized code also freezes it for a reviewer.

**Graduation** (`graduation` on `CURRENT_POLICY`, `src/services/graduation.ts`):

- After **3 on time pass-through months in a row**, the business is re-underwritten on freshly
  pulled data with its payment history, at most once a calendar month.
- An approval for at least the lease rent is an **offer, open 30 days**. A referral is not
  offered and not queued; the job looks again next month.
- A missed month withdraws an open offer.
- On acceptance the financed plan opens from the next month, through the same opening checks as
  any plan, and starts on the first rung of the ladder.

**Graduate pricing** (version 5, `graduation.graduatePricing`). Under version 4 graduates went
bad more than twice as often as first time approvals at the same scores (8.3% against 4.0%)
and earned 37 bps. A graduate is now priced on its own PD: the PD table at its score times
2.5, which is the expected loss in its fee, and the grade a first time applicant with that PD
would get, which sets its fee floor and largest rent share. The score and grade on the decision
stay the scorecard's. On the default evaluation 227 businesses graduate (229 before), pay 195
bps (158), and earn 72 bps (37); they still go bad at 8.4%.

## 11. Servicing

Everything after a landlord payout follows `STANDARD_SERVICING_POLICY` in
`src/servicing/policy.ts`. The services and the portfolio simulator call the same functions.

| Rule                | Standard policy                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Grace               | 3 days. An installment is `LATE` from day 4                                                                         |
| Delinquency buckets | `CURRENT` (nothing past due), `GRACE` (1 to 3 days), `DELINQUENT` (4 to 29), `DEFAULT` (30 and over), `CHARGED_OFF` |
| Days past due       | The age of the plan's oldest unpaid installment, derived on every read                                              |
| Collection attempts | At most 3 per installment per bank account, 3 days apart: days 0, 3 and 6. A newly linked account starts again      |
| Balance check       | Before every scheduled debit. A debit the balance cannot cover is put off a day and is not an attempt               |
| Stop-advance        | The next landlord payout is held while the business is more than 3 days past due on any plan                        |
| Release window      | A held payout is paid if released within 5 days of its date, otherwise cancelled, never paid late                   |
| Charge-off          | At 90 days past due. The plan's whole unpaid principal is charged off and the plan closed                           |
| Manual payment      | After the third attempt, the business can pay by hand (`POST /v1/repayments`), at any stage                         |
| Late fees           | None                                                                                                                |

**Other holds.** A payout is also held while the plan is frozen (periodic review, unauthorized
return, returned payout, screening hit), while a landlord change is in its 5 day cooling-off
period (`CONTROLS_POLICY`, `src/controls/policy.ts`), while a rent increase waits for a new
decision, and while the owner has paused the plan. The same 5 day release window applies.

**Return codes** (`RETURN_CODES`):

| Class        | Codes                             | Effect beyond reversing the payment                                      |
| ------------ | --------------------------------- | ------------------------------------------------------------------------ |
| Retryable    | R01, R09                          | None. The return counts as an attempt and the schedule continues         |
| Hard         | R02, R03, R04, R08, R13, R16, R20 | The bank link is disabled; no automatic debit until the business relinks |
| Unauthorized | R05, R07, R10, R29                | As hard, and the plan is frozen and a high severity alert opens          |

An unknown code is treated as hard. A month with any returned payment never counts as on time
for the ladder or payment history.

**Charge-off.** At 90 days past due the `age-receivables` job charges off the plan's unpaid
principal against the allowance, cancels unpaid payouts, closes the plan, suspends the business,
and freezes its other plans. Unpaid fees are never booked as revenue, so nothing is charged off
for them. A charged off balance is still owed.

**Recoveries.** A payment on a charged off installment books the principal to `recovery_income`
and the fee to `fee_revenue`. The plan stays closed. The evals assume a 10% recovery rate
(`recoveryRateBps`); the services book only what is actually paid.

**Provisioning.** On the first run of each calendar month the `provision` job sets the allowance
for credit losses to outstanding principal in each bucket times its reserve rate, and posts the
change:

| Bucket     | Reserve rate | Measured roll to charge-off (first of month / on entry) | Highest single seed |
| ---------- | -----------: | ------------------------------------------------------: | ------------------: |
| CURRENT    |        0.55% |                                           0.42% / 0.44% |               0.48% |
| GRACE      |       99.35% |                                             n/a / 79.5% |               94.3% |
| DELINQUENT |         100% |                                           92.6% / 86.6% |                100% |
| DEFAULT    |         100% |                                           99.4% / 98.6% |                100% |

The rule (`reserveRateFor`, `src/servicing/policy.ts`): the higher of the two measured roll
rates plus a margin of a quarter of it (`RESERVE_MARGIN_BPS`), rounded up to 5 bps and held to
100%. With that margin the allowance is above the measured loss on the pooled book and on every
single seed. The report's roll table shows the reserve beside each measured rate and whether it
covers it, and a unit test fails if a reserve falls below the checked in baseline's measured
roll. Until version 5 the rates were the roll rates rounded up with no margin, and the CURRENT
reserve (0.40%) had fallen below its measured 0.42%. A charge-off never takes the allowance
below zero: if the allowance is short, the same transaction tops it up first.

## 12. Periodic re-underwriting

The `reunderwrite` job (`src/services/reunderwriting.ts`) re-scores every active financed plan
once a calendar month on fresh bank data, with the plan's rent as the request. The result is
stored as a `PERIODIC_REVIEW` decision beside the original.

- **Freeze** when the score is under the watch score of 50 (`reunderwriting.watchScore`), or the
  review declines for a deterioration reason (`DETERIORATION_CODES`: overdrafts, negative days,
  revenue decline, thin buffer decline, revenue too low, rent share, no free cash flow, no
  capacity, score below minimum).
- **Freeze and alert** on a trust failure: a decline for round trip deposits, accounts held by
  someone else, or a rewritten bank history (`TRUST_CODES`), or a bank or sales history that
  changed between pulls (`REWRITE_FINDINGS`), even when the engine only referred. A
  `fraud.periodic_review_trust_failure` alert opens for a person, once per plan and month.
- Time in business is what was stated at application plus the months since.
- A freeze, by a review or by an operator's hold, stores a `PLAN_FROZEN` adverse action notice
  with its catalog reasons, in the same transaction, shown in the app.
- A decline for an origination rule (an exposure cap, the fee cap, rent not matching the
  account) does not freeze a customer who is repaying.
- A frozen plan gets no new period and its next payout is held: the freeze takes effect from
  the next period, never mid-cycle. Rent already paid to the landlord is still collected.
- A freeze is lifted only by a reviewer. The review needs data no more than 7 days old; a stale
  feed stores nothing and the job tries again the next day.
- Stated revenue checks are skipped. A request to connect a payout account is shown to the owner
  but does not stop the review; a bank that cannot be pulled does.

Separately, `refresh-connections` pulls every business with an active plan again once its last
pull is 7 days old, runs the veracity checks, and feeds the data monitoring rules.

## 13. Monitoring and the circuit breaker

Every threshold is in `MONITORING_POLICY` (`src/monitoring/policy.ts`), with its reasoning. The
`monitor` job runs last on every job run. The portfolio rules most relevant to credit:

| Rule                                                         | Warning                                               | Critical (trips the breaker) |
| ------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------- |
| First payment default, by origination month                  | 1.5% of plans                                         | 3%                           |
| Principal delinquent or in default                           | 5%                                                    | 10%                          |
| Month over month roll to delinquent                          | 3%                                                    | 8%                           |
| Realized against expected loss, cohorts 120 days old or more | 1.5 times                                             | 2.5 times                    |
| Committed rent against pool capital                          | 90% of the 85% ceiling                                | Above 100% of pool capital   |
| Industry and single name concentration                       | Over the cap (information at 75% of it, high at 150%) | Not a breaker rule           |

Portfolio rates are read only once 20 plans are in the denominator. Payment return rates are
watched against the network thresholds (see [`COMPLIANCE.md`](../../COMPLIANCE.md), "Payments
and Nacha").

**The circuit breaker** (`src/services/circuit-breaker.ts`). When any of the five breaker rules
opens or rises to critical, the breaker trips and every application the engine would approve is
referred instead (`CIRCUIT_BREAKER`). Declines and requests for information are unchanged, and a
reviewer can still approve. An admin can also trip it by hand from the operations console, with a
reason (rule `manual`, section 9). Only an admin can reset it, with a reason; trip and reset are
both audited. Approvals made before the trip stay valid and can still open a plan, subject to the
exposure and funding rules on the day.

Referring was chosen over stopping new plans because a breach says recent automatic decisions
may be wrong, and the remedy is a person on each new approval.

## 14. Change control

**No policy change ships without the evaluation gates passing in strict mode.** A policy change
is any change to a number in `src/underwriting/policy.ts`, `src/underwriting/pd-table.ts`,
`src/servicing/policy.ts`, `src/servicing/pass-through.ts`, or the scorecard curves.

The procedure:

1. Make the change as a **new policy version**: a new `CreditPolicy` object with a new `version`
   string, added to `POLICIES`, and `CURRENT_POLICY` pointed at it. Never edit a retired version.
2. If the scorecard, cutoffs or servicing changed, regenerate the PD table
   (`pnpm --filter @cashflow/api eval:calibrate`) or record why not.
3. Run the default evaluation in strict mode:
   ```sh
   pnpm --filter @cashflow/api eval:portfolio --strict
   ```
   It exits non-zero if any gate fails. The default run (5 seeds of 2,000 applicants, 12
   periods) rewrites `evals/baseline.json` and `evals/report.md`.
4. Commit the policy change together with the regenerated `report.md` and `baseline.json`, so the
   review shows the diff in every metric and gate.
5. Write down in [`UNDERWRITING.md`](UNDERWRITING.md) what changed and why, and update this
   document.
6. Monitoring thresholds that come from the credit policy (concentration and utilization caps,
   settlement match) follow automatically; others in `MONITORING_POLICY` are reviewed by hand.

No gate threshold may be loosened to make a change pass. A gate threshold change is itself a
policy change and needs its own written reason.

**The gates** (`GATE_THRESHOLDS`, `src/evals/gates.ts`), judged on the mean of 5 seeds. Current
results from [`evals/report.md`](evals/report.md), `cashflow-v5` under standard servicing:

| Gate                      | Threshold                                                                     | Current (mean) | Seeds                | Result |
| ------------------------- | ----------------------------------------------------------------------------- | -------------: | -------------------- | ------ |
| `net_loss_base`           | Net loss at or under 75 bps of rent volume                                    |         19 bps | 13 to 23             | Pass   |
| `net_margin_base`         | Net margin above zero                                                         |       $264,570 | $248,395 to $300,915 | Pass   |
| `net_margin_mild_stress`  | Net margin above zero, revenue down 15% for 180 days                          |       $219,187 | $190,712 to $268,255 | Pass   |
| `bad_rate_monotonic`      | No bad rate inversion from grade A to D (100 bps tolerance)                   |              0 | 0                    | Pass   |
| `auc`                     | AUC at or above 0.70, every scored honest applicant                           |          0.873 | 0.858 to 0.896       | Pass   |
| `fraud_approval`          | Under 5% of fraud applicants approved, after review                           |           1.6% | 1.0% to 2.6%         | Pass   |
| `pool_funding`            | No payout unfunded on its date                                                |              0 | 0                    | Pass   |
| `approval_floor`          | At least 30% of applicants approved on usable terms                           |          39.9% | 38.4% to 41.5%       | Pass   |
| `refer_rate`              | At most 5% of applicants referred                                             |           3.7% | 3.5% to 3.9%         | Pass   |
| `veracity_honest_adverse` | At most 3% of honest applicants knocked out or referred by a veracity finding |           1.5% | 1.4% to 1.8%         | Pass   |
| `adverse_action_reasons`  | Every decline and counter offer has a catalog reason with applicant text      |           100% | 100%                 | Pass   |

What the gates mean, and do not mean: they show the policy is coherent with the servicing rules
and the unit economics under the simulation's assumptions. They are not a loss forecast. Every
applicant is synthetic, the PD table and weights were set against the same simulator, and the
fraud the checks catch is the fraud they were written for. See
[`evals/README.md`](evals/README.md), "Limits".

**In CI.** Every push runs the gates on a small fixed seed sample of the policy in force (2
seeds of 600 applicants, `src/evals/ci-gates.test.ts`), with the same thresholds and a negative
control that the launch policy fails, inside the ordinary test step. The full strict evaluation
(about six to eight minutes) runs in `.github/workflows/eval.yml`: nightly, on demand, and on
any pull request that touches underwriting, servicing, veracity, the evals, or the shared money
and reason code. It fails on any gate, and fails if the committed `report.md` or
`baseline.json` is not what the code in the tree produces.

## 15. Known gaps

What a credit committee would ask about before lending real money, and the answer today.

- **Calibration.** The scorecard weights, the cutoff, the PD table and the reserve rates come
  from a synthetic population. All need refitting on real outcomes.
- **Reserve rates.** Re-set with version 5 at the measured roll rate plus a quarter (section
  11). The GRACE and DELINQUENT reserves are at or near 100% because simulated businesses that
  miss a payment have nearly always closed; real borrowers cure far more often.
- **Graduates.** Version 5 prices graduates on their own PD, but they still go bad about twice
  as often as first time approvals at the same scores, and the few grade B graduates lose
  money. A larger cohort, or real outcomes, should decide whether graduation needs a stricter
  rule than a price.
- **The PD table is version 2's.** Not regenerated for versions 3 to 5, by choice, with reasons
  in [`UNDERWRITING.md`](UNDERWRITING.md).
- **One dollar authority tier.** A reviewer approves up to $10,000 a month and an admin above
  it (section 9). There is no second approver (four eyes) on any single decision, and no
  further tiers by amount or by exposure.
- **No document handling.** A reviewer has nothing to verify a lease or revenue with beyond what
  the connections show; `LEASE_VERIFIED` and `REVENUE_VERIFIED_OTHER_SOURCE` record a check that
  happened outside the system.
- **No personal guarantee, collateral or collections agency.** Recovery after charge-off is
  whatever the business pays by hand.
- **Periodic review is not in the evaluation.** The simulation shows the book without that
  protection.

# Compliance

What CashFlow's code does that bears on lending, payments and data law, what it does not do,
and the questions a lawyer would have to answer before any of it touched a real customer.

**In short**

- Not legal advice, and no real lending ever happened here. Every reading of a law is a
  working assumption, and there are 27 open questions for counsel (section 14).
- Built: Regulation B style adverse action (a reason catalog, at most four principal reasons,
  stored notices with deadlines and monitoring), minimal identity data, KYB and sanctions
  screening with a 30 day rescreen, read-only data connections with sealed tokens, and ACH
  return rate monitoring.
- Not built: email or mail delivery of notices, fair lending testing, an AML program, state
  commercial financing disclosures, licensing, and real vendors.
- The biggest open questions: whether the pass-through plan is money transmission (question 1),
  which state disclosure, licensing and usury rules apply (16 to 18), and how notices must be
  delivered (4).

## Contents

1. [Scope and disclaimer](#1-scope-and-disclaimer)
2. [ECOA and Regulation B](#2-ecoa-and-regulation-b)
3. [FCRA](#3-fcra)
4. [Fair lending monitoring](#4-fair-lending-monitoring)
5. [BSA/AML, KYB and sanctions](#5-bsaaml-kyb-and-sanctions)
6. [Money transmission and the pass-through plan](#6-money-transmission-and-the-pass-through-plan)
7. [State lending, licensing and disclosure](#7-state-lending-licensing-and-disclosure)
8. [UDAAP, UDAP and marketing](#8-udaap-udap-and-marketing)
9. [Data protection](#9-data-protection)
10. [Payments and Nacha](#10-payments-and-nacha)
11. [Third party and vendor risk](#11-third-party-and-vendor-risk)
12. [Operating controls that read a rule](#12-operating-controls-that-read-a-rule)
13. [Where each per-document list lives](#13-where-each-per-document-list-lives)
14. [Questions for counsel](#14-questions-for-counsel)
15. [Sources](#15-sources)

## 1. Scope and disclaimer

**This is not legal advice.** It is an engineer's map of the rules the product would meet, written
to show where the code made a reading of a rule and where a reading is still owed. Every
conclusion about what a law requires is a working assumption, marked as one, and the open points
are collected in [section 14](#14-questions-for-counsel).

**No real lending ever happened in this repository.** CashFlow was a startup that wound down. The
code is released as a reference. It has never made a real loan, debited a real account, paid a
real landlord, pulled a real bank feed, or screened a real person. Every provider that could do
those things defaults to a sandbox, and the real adapters are skeletons that refuse to run
without explicit configuration (see [`ARCHITECTURE.md`](ARCHITECTURE.md), "Provider seams").

**Citations.** Federal citations were checked on primary sources in November 2026: the eCFR,
the CFPB's Regulation B pages, govinfo (US Code and Federal Register), FinCEN, OFAC, Nacha and
the FTC. Several state citations could be confirmed only from secondary sources; those are
marked "not confirmed from the primary source". Laws in this area change often (section 1071,
California's commercial financing rules and the federal beneficial ownership rule all moved in
2025 and 2026), so every citation here needs checking again on the day it matters.

**What the product is, for these purposes.** A **financed plan** is commercial credit: CashFlow
pays a business's landlord a month's rent and the business repays it in installments plus a fee
of 1.5% to 4% of the rent per period (see [`apps/api/CREDIT_POLICY.md`](apps/api/CREDIT_POLICY.md)).
Applicants are businesses applying for business purposes; some will be sole proprietors. A
**pass-through plan** extends no credit: CashFlow collects the rent from the business first and
then pays the landlord, for free.

| Area                           | Built                                                                                                          | Unresolved                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Adverse action (Regulation B)  | Reason catalog, at most four principal reasons, stored notices with deadlines, monitoring of deadlines         | Delivery, agency, creditor details, freeze notice wording |
| FCRA                           | No consumer report is pulled                                                                                   | Whether identity checks on owners are consumer reports    |
| Fair lending                   | No protected characteristics collected; plain, auditable scorecard                                             | No disparate impact testing exists                        |
| KYB and sanctions              | Verification of business and owners, screening of business, owners, landlord and payee, rescreen every 30 days | No real vendor; whether a formal AML program is needed    |
| Money transmission             | Pass-through funds held in a separate ledger account behind a liability                                        | Whether the pass-through plan is money transmission       |
| State disclosure and licensing | Fee shown in dollars and as a share of rent                                                                    | Commercial financing disclosures, licensing, usury        |
| Data protection                | Read-only connections, sealed tokens, append-only hashed snapshots, minimal identity data                      | Retention schedule, consent wording, platform terms       |
| Payments                       | Return codes classified, return rates monitored against the network thresholds                                 | Origination agreements, authorization wording             |

## 2. ECOA and Regulation B

The Equal Credit Opportunity Act (15 U.S.C. 1691 et seq.) and Regulation B (12 CFR part 1002)
apply to business credit as well as consumer credit. Regulation B defines business credit as
credit primarily for business or commercial purposes (1002.2(g)) and relaxes some notice rules
for it (1002.9(a)(3)). CashFlow's design treats the financed plan as credit under ECOA. Whether
the pass-through plan is credit is question 2.

### Adverse action notices

**What is built.** Described in full in [`apps/api/UNDERWRITING.md`](apps/api/UNDERWRITING.md),
"Reasons and adverse action notices". In short:

- **Reasons.** One catalog of 51 reasons in `packages/shared/src/adverse-action/catalog.ts`, each
  with plain applicant text and what would change it. Every applicant text is tested against a
  list of internal jargon. The engine chooses at most four principal reasons
  (`selectPrincipalReasons`), following the commentary to 1002.9(b)(2) that more than four is
  not likely to help the applicant. "Score below the minimum" is never a principal reason on
  its own: the reasons must be the factors actually scored.
- **Reviewer declines** must pick their applicant reasons from the catalog; the review service
  refuses a decline without one. Internal codes such as `FRAUD_SUSPECTED` stay internal.
- **Notices.** `AdverseActionNotice` stores every notice exactly as delivered: kind, principal
  reasons, full text, statement version, action date, deadline, delivery time and channel. The
  table is append only by database trigger and has no foreign keys, so deleting a business never
  deletes what it was told.

| Notice                     | When CashFlow sends it                                                | Deadline it is held to                                 |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| Decline                    | With the decision, in the same database transaction                   | 30 days after a completed application, 1002.9(a)(1)(i) |
| Counter offer not accepted | When the owner declines it, or 30 days pass with no plan opened on it | 90 days after the counter offer, 1002.9(a)(1)(iv)      |
| Incompleteness             | After 10 days waiting on information, giving 30 days to respond       | 1002.9(a)(1)(ii) and (c)                               |
| Incomplete, closed         | The day after that response date, if still incomplete                 | 30 days after closing it                               |
| Plan frozen                | With the freeze: a periodic review, or an operator's hold             | 30 days after the freeze, 1002.9(a)(1)(iii)            |

- **Content.** Every notice carries a statement of the action, the creditor's name and address
  (1002.9(a)(2)), the specific principal reasons (1002.9(b)(2)), and the ECOA statement in the
  words of 1002.9(b)(1), naming the Federal Trade Commission as the agency. The creditor details
  are placeholders marked `[PLACEHOLDER]` in `apps/api/src/adverse-action/policy.ts`. A notice
  names the application by a short reference number (the last six characters of its id), not
  the raw database id.
- **Timing.** Every notice is stored by the `adverse-action-notices` job the day it falls due or
  with the decision. Monitoring alerts on any notice not stored a day after it fell due (high,
  critical past its deadline), on any notice delivered late, and on any application undecided
  at 20 days (warning) and 30 days (critical).
- **Business credit, done conservatively.** 1002.9(a)(3) lets a creditor give a business with
  revenues of $1 million or less its reasons on request, orally or in writing, and gives larger
  businesses looser rules still (notice within a reasonable time; written reasons only if asked
  for within 60 days). CashFlow uses neither option: every adverse action gets specific reasons
  in writing on the 30 day timetable, whatever the business's revenue. A counter offer that is
  taken up is not adverse action and gets no notice.
- **Evaluation.** The `adverse_action_reasons` gate requires that every decline and counter offer
  in the portfolio simulation carries a catalog reason with applicant text: 100% today.

**What is not built.** Delivery is in the app only, with no email or mail and no E-SIGN consent
flow (question 4). A freeze of a running plan, by a periodic review or by an operator's hold, is
treated as an unfavorable change to existing credit and stores a notice with catalog reasons,
but whether one is owed, and whether its wording and the operator hold's reason ("plan under
review") are adequate, is for counsel (question 7). The creditor details are placeholders
(question 10).

### Record retention

1002.12(b) requires a creditor to keep application records for 25 months for consumer credit
and 12 months for business credit; for a business with revenues over $1 million it is 60 days,
extended to 12 months if the applicant asks in writing for reasons or for retention
(1002.12(b)(5)). CashFlow's floor is 12 months for every application (`retentionMonths` in
`apps/api/src/controls/policy.ts`). In practice nothing in the product deletes an application,
decision, notice, snapshot or audit event, and the `compliance.retention_violation` monitoring
rule alerts if an application decided inside the period disappears. A real retention schedule,
including when to delete, is question 12.

### Information about protected characteristics

1002.5(b) bars a creditor from asking an applicant's race, color, religion, national origin or
sex, with exceptions that include a self-test under 1002.15 and data collection required by
subpart B. CashFlow collects none of these. An owner record is a name, a title, an ownership
share and a reference to the identity provider's record; there is no date of birth or government
id number anywhere in the schema.

## 3. FCRA

The Fair Credit Reporting Act (15 U.S.C. 1681 et seq.) governs consumer reports on individuals.
CashFlow pulls no credit report on the business or its owners. The score reads only the
business's own bank and point of sale data, through connections the owner authorized.

Two points need a reading:

- **The identity provider.** Verifying owners and screening them against sanctions lists is done
  by a vendor. If any part of that is a consumer report on an owner and it contributes to an
  adverse action (an `IDENTITY_NOT_VERIFIED` decline, for example), the notice would need the
  disclosures of 15 U.S.C. 1681m(a). The notices do not include them today (question 3).
- **Owners' personal reports, if ever added.** FTC staff have taken the view that a lender has a
  permissible purpose for a report on an individual who is or will be personally liable, such as
  a guarantor, and not on an owner who is not (FTC staff report "40 Years of Experience with the
  Fair Credit Reporting Act", July 2011, discussing 15 U.S.C. 1681b(a)(3)(A) and (F)). CashFlow
  takes no personal guarantee. Adding a bureau score through `UnderwritingProvider` would need a
  guarantee or the owner's written authorization first (question 3).

## 4. Fair lending monitoring

**What exists.** A scorecard whose every factor, weight and threshold is in one file and stored on
every decision with its policy version, so any decision can be explained and reproduced. No
model is fitted, and no input is a demographic characteristic. Reason codes, overrides and their
reason codes, and every review are recorded and auditable. Overrides are marked on the decision
and the review (see [`apps/api/CREDIT_POLICY.md`](apps/api/CREDIT_POLICY.md), section 9).

**What does not exist.** There is **no disparate impact testing**, because no protected class
data is collected, and Regulation B limits collecting it (section 2). There is no proxy method
(such as surname and geography based estimation) and no analysis of whether a factor correlates
with a protected class. There is no testing of override patterns by reviewer. Inputs that could
act as proxies have not been examined: time in business, revenue level, account conduct, and the
industry used by the pool's concentration rule (which can delay a plan's start but never changes
the credit decision).

**What a real program would need**, as a working list: a fair lending risk assessment of each
factor; a decision on proxy methods and their limits; regular comparison of approval rates, terms
and overrides across estimated groups; review of the reason distribution; and a less
discriminatory alternative search when a factor shows disparity. The self-test privilege in
1002.15 is one route to collecting data for this.

**Section 1071.** Subpart B of Regulation B (12 CFR 1002.101 et seq.) will require covered
lenders to collect and report small business application data, including whether the business
is minority-owned or women-owned and the ethnicity, race and sex of its principal owners. The
rule was revised in 2026 (91 FR 23530, May 1, 2026): it is effective June 30, 2026 with a
compliance date of January 1, 2028, and covers lenders with at least 1,000 covered originations
to small businesses in each of the two prior years. A startup of CashFlow's size would fall
below that threshold, but a lender that crosses it would then hold the demographic data that
fair lending testing needs (question 13).

## 5. BSA/AML, KYB and sanctions

### What is built

`IdentityProvider` (`apps/api/src/providers/identity/`) answers three questions: is the business
a registered entity matching what it gave us, are its beneficial owners identifiable people, and
does a name appear on a sanctions list or watchlist. `apps/api/src/services/identity.ts` decides
when to ask and what to do with the answer. The only implementation is a sandbox; no real vendor
adapter or skeleton exists.

| When                                               | What runs                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| A business is created or an identity field changes | Verify the business and its owners; screen the business and each owner |
| An application is submitted                        | The same again                                                         |
| A lease is created or its landlord changes         | Screen the landlord and the payout account holder as payee             |
| Every 30 days (`rescreen` job)                     | Screen every active business, owner and landlord again                 |

- A business needs at least one owner, and ownership shares may not add up to more than 100%.
  The business stores the last four digits of its tax id, never the full number.
- Anything short of verified with clear screening is never approved automatically: a check in
  review or a possible match is referred, a failed verification is declined with a reason the
  applicant can act on, and a match is held in review and cannot be approved while open.
- A hit on a running plan's business, owner or landlord freezes the plan, so no landlord payout
  goes out. Clearing a possible match takes a reviewer, a match takes an admin, and every
  clearance records who and why.
- The applicant is never told what screening found.
- Monitoring alerts on open hits, on screening older than the rescreen interval plus 7 days, and
  on any business with a running plan that is not verified.

### What a real program would need, and the open question

**Is an AML program required?** The Bank Secrecy Act's program rules apply to "financial
institutions" as FinCEN defines them (31 CFR 1010.100(t)). Nonbank lenders appear there only as
"loan or finance companies", which FinCEN has limited to residential mortgage lenders and
originators (31 CFR 1010.100(lll) and part 1029). On that reading a nonbank commercial lender
has no general AML program rule of its own, and FinCEN's customer due diligence rule
(31 CFR 1010.230) reaches only the institutions listed in it. That changes if CashFlow is a money
transmitter (section 6), if a bank partner requires a program by contract, or if a state license
requires one. Question 14.

**Sanctions apply regardless.** OFAC's regulations (31 CFR chapter V) bind every US person,
whether or not it has an AML program (OFAC FAQ 11). Screening the business, its owners and the
landlord, before money moves and on a schedule, is the control for that. A real deployment would
need a screening vendor with list updates more often than CashFlow's 30 day batch, a documented
match review standard, and a blocking and reporting procedure for a true match (question 15).

**Beneficial ownership.** FinCEN's 2025 interim final rule exempted domestic companies from the
Corporate Transparency Act's reporting requirement (90 FR 13688, March 26, 2025), so a lender
cannot expect to rely on that registry for US businesses. CashFlow collects owners from the
applicant and verifies them through the vendor.

## 6. Money transmission and the pass-through plan

On a pass-through plan CashFlow debits the business's whole month's rent about a week before it
is due, holds it until the debit has settled, and pays it to the landlord on the due date. If
the month cannot be paid it refunds the business. That is receiving money from one person and
transmitting it to another, which is how FinCEN defines money transmission
(31 CFR 1010.100(ff)(5)(i)(A)) and how state money transmitter laws are framed. The plan being
free does not obviously change it.

**What is built.** Collected rent sits in its own ledger account, `pass_through_cash`, behind a
liability, `landlord_payable`, and is never swept into the capital pool. Two monitoring rules
check that the landlord is never paid without a settled collection and that both accounts equal
the months collected and not yet paid or returned. That is bookkeeping, not an answer.

**The exemptions that might apply,** each a question for counsel (question 1):

- **Payment processor.** FinCEN excludes a person that only facilitates payment for goods or
  services through a clearance and settlement system by agreement with the creditor or seller
  (31 CFR 1010.100(ff)(5)(ii)(B)). FinCEN's ruling FIN-2014-R009 lists the conditions, one of which
  is a formal agreement with, at a minimum, the seller or creditor. CashFlow has an agreement
  with the tenant and none with the landlord, so this exclusion does not obviously fit as built.
- **Agent of the payee.** The Conference of State Bank Supervisors' Money Transmission
  Modernization Act exempts an agent of a payee where there is a written agreement with the
  payee, the payee holds the agent out, and payment to the agent discharges the payor
  (section 3.01(b)). California has an agent of payee exemption (Cal. Fin. Code 2010(l)); the DFPI
  has found it unavailable where the contract did not appoint the agent or discharge the debt
  (DFPI opinion letter, October 4, 2018). New York requires a license to engage in the business of
  receiving money for transmission (N.Y. Banking Law 641). Using this route would mean agreements
  with landlords, which a tenant-chosen landlord may not sign.
- **A licensed partner.** Holding the funds in a for-benefit-of account at a bank or a licensed
  money transmitter, with CashFlow as its service provider.

## 7. State lending, licensing and disclosure

**Commercial financing disclosure laws.** Several states now require a provider of commercial
financing to give a disclosure of its cost at the offer. CashFlow's largest plan is $40,000 a
month, well under every threshold below, and its financed plan is closed-end installment
credit, which the general laws cover. Whether each applies, and what it requires CashFlow to
show, is question 16. These are citations to research, not conclusions:

| State       | Law                                                                                         | Threshold                            | Note                                                      |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| California  | Cal. Fin. Code 22800 et seq. (SB 1235, 2018); 10 CCR 900 to 956, effective December 9, 2022 | $500,000 or less (10 CCR 921)        | Statute text not confirmed from the primary source        |
| New York    | N.Y. Fin. Serv. Law article 8, sections 801 to 812; 23 NYCRR part 600                       | Exempts over $2.5 million (802(g))   | Compliance date not confirmed from the primary source     |
| Utah        | Utah Code title 7, chapter 27                                                               | Excludes over $1 million             | Also registration. Read from summaries, not the full text |
| Georgia     | O.C.G.A. 10-1-393.18 (SB 90, 2023)                                                          | Excludes over $500,000               | Codified text not confirmed                               |
| Florida     | Fla. Stat. 559.961 to 559.9615                                                              | Excludes over $500,000 (559.9612(7)) |                                                           |
| Kansas      | SB 345, 2024 Kan. Sess. Laws ch. 29                                                         | Exempts over $500,000                | Statute section number not confirmed                      |
| Missouri    | Mo. Rev. Stat. 427.300                                                                      | Exempts over $500,000                | Broker registration                                       |
| Virginia    | Va. Code 6.2-2228 to 6.2-2238                                                               | Excludes over $500,000               | Sales-based financing only: probably not this product     |
| Connecticut | Conn. Gen. Stat. 36a-861 to 36a-872 (P.A. 23-201)                                           | $250,000 or less                     | Sales-based financing only: probably not this product     |
| Texas       | Tex. Fin. Code chapter 398 (HB 700, 2025)                                                   | Under $1 million                     | Sales-based financing only: probably not this product     |

CashFlow shows the owner the fee in dollars and as a percentage of the rent, the installment
dates and amounts, and the reasons for its decision. It shows no annualized rate and has no
signed financing agreement. A fee of 1.5% to 4% of a month's rent, repaid within about two weeks
on average, is a high rate when annualized, which bears on both disclosure and usury
(question 17).

**Licensing.** The California Financing Law (Cal. Fin. Code 22000 et seq.) requires a license to
make loans in California, and defines a commercial loan as one of $5,000 or more for other than
personal, family or household purposes (22502; not confirmed from the primary source). CashFlow's
smallest plan is $500 a month, so many plans would be under $5,000. California enacted AB 2116 in
2026, reported to bring small business commercial financing of $500,000 or less under the
licensing regime from 2028; its text was not confirmed from the primary source. Other states have
their own lending and broker licensing laws. Question 18.

**Usury and the true lender question.** Many states cap rates on commercial loans differently
from consumer loans, some with criminal usury statutes. Whether CashFlow's fee is interest, and
which state's law governs, depends on the structure chosen: direct lending under state licenses,
or a bank partner originating the credit. The second raises the question of who the true lender
is. Question 17.

## 8. UDAAP, UDAP and marketing

**Federal.** The Consumer Financial Protection Act's prohibition of unfair, deceptive or abusive
acts (12 U.S.C. 5531, 5536) reaches "covered persons" offering consumer financial products, which
the Act defines as products for personal, family or household purposes (12 U.S.C. 5481(4) to
(6)). On that reading lending to businesses is generally outside it; that is an inference from
the definitions, not a CFPB statement. Section 5 of the FTC Act (15 U.S.C. 45) has no such limit,
and the FTC has used it against small business financing providers (FTC v. Yellowstone Capital
LLC, S.D.N.Y. 2020; FTC v. RCG Advances, LLC, S.D.N.Y. 2020).

**California.** The DFPI's regulations under Cal. Fin. Code 90009(e) make unfair, deceptive or
abusive practices unlawful in offering commercial financing to small businesses principally
directed from California, with an annual report (10 CCR 1060 to 1062).

**What the product does.** The marketing site is a single page with the name and a one line
description. In the app, every decision is explained in plain words, reasons are tested against
internal jargon, the score is shown only on an approval, the pass-through plan says plainly that
a missed month is not paid and the owner must pay the landlord, there are no late fees on either
plan, and an approval is never made at a fee above the cap. Before submitting, the application
says what data is used and that the applicant will be told the reasons in writing if the full
rent is not approved. Whether the product's copy, including "pay later" language for credit,
would pass review is part of question 19.

## 9. Data protection

**What is built.** Described in [`apps/api/DATA_CONNECTIONS.md`](apps/api/DATA_CONNECTIONS.md).

- **Read-only connections only.** Point of sale data through read-only OAuth with PKCE, or
  CashFlow's own read-only seat; bank data through an aggregator. No credentialed bank login and
  no uploaded statements, by design.
- **Token vault.** Platform and aggregator tokens are sealed with AES-256-GCM under a key derived
  from `CONNECTION_TOKEN_KEY`, bound to the business, and never returned, logged or audited
  (`apps/api/src/crypto/token-vault.ts`). Every real adapter refuses to start without the key.
- **Append-only snapshots.** Every pull is a `DataSnapshot` with a sha256 over its canonical
  payload, protected by a trigger. Each decision records the snapshots it read.
- **Minimal identity data.** Tax id last four; owners without date of birth or government id;
  passwords hashed with scrypt.
- **Retention.** The sandbox keeps everything forever. That suits a record of decisions and is
  wrong for minimization; a schedule is question 12.

**Which privacy rules apply** is not settled. The FTC Safeguards Rule (16 CFR part 314) applies
to non-bank financial institutions but protects information about consumers, defined as
individuals obtaining products for personal, family or household purposes (314.2(b)); on that
reading a lender to businesses holds little covered information, though sole proprietors and
owners are individuals under state privacy laws. The status of the federal personal financial
data rights rule under Dodd-Frank section 1033, and whether it reaches small business accounts,
was open when this was written. Questions 6, 8 and 20.

## 10. Payments and Nacha

CashFlow would debit businesses and pay landlords by ACH through a payments provider. The Nacha
Operating Rules set return rate levels for originators: unauthorized returns at 0.5% of debits
(Article Two, Subsection 2.17.2), and administrative returns at 3.0% and overall returns at 15.0%,
which trigger a review rather than a violation.

**What is built.** `MONITORING_POLICY.payments` (`apps/api/src/monitoring/policy.ts`) watches all
three over a trailing 60 days, warns at 80% of each level, and needs a minimum sample before a
rate counts (200 debits for unauthorized, 100 for administrative, 50 overall). Every
unauthorized return also raises an alert on its own and freezes the plan. Return codes are
classified in `apps/api/src/servicing/policy.ts`:

| Class        | Codes                             | What CashFlow does                                                    |
| ------------ | --------------------------------- | --------------------------------------------------------------------- |
| Retryable    | R01, R09                          | Counts as an attempt; at most 3 attempts, 3 days apart                |
| Hard         | R02, R03, R04, R08, R13, R16, R20 | Disables the bank link; no automatic debit until the business relinks |
| Unauthorized | R05, R07, R10, R29                | The same, freezes the plan, and opens a high severity alert           |

A balance check before each debit avoids presenting debits that would bounce. The 60 day window
and the thresholds are working assumptions to confirm with the originating bank, and the debit
authorization wording does not exist yet (question 21).

## 11. Third party and vendor risk

Every real dependency sits behind a provider interface with a sandbox default. None of the real
adapters has been exercised. Before one is turned on:

| Vendor                              | How CashFlow would use it                                         | Main risks to diligence                                                               |
| ----------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Square, Shopify, Stripe, Clover     | Read-only OAuth for sales and payouts (`COMMERCE_PROVIDER`)       | Developer terms on using merchant data for credit, app review, deletion on disconnect |
| Toast                               | CashFlow's own read-only reports seat (`DELEGATED_SEAT_PROVIDER`) | Whether automated access through a seat is permitted at all; layout changes           |
| Bank data aggregator (Plaid shaped) | Transactions, balances, account identity (`BANK_LINK_PROVIDER`)   | Permitted use for underwriting and monitoring, consent wording, data accuracy         |
| Payments (Stripe shaped)            | ACH debits and landlord payouts (`PAYMENTS_PROVIDER`)             | Originator status, return handling, holding of funds                                  |
| Identity and sanctions vendor       | Business and owner verification, screening (`IDENTITY_PROVIDER`)  | List coverage and update frequency, FCRA status of owner checks                       |
| Capital provider                    | The pool that funds landlord payouts (`CAPITAL_PROVIDER`)         | Concentration and eligibility covenants, reporting                                    |

If a bank partner is used, it would assess CashFlow as its third party under the Interagency
Guidance on Third-Party Relationships: Risk Management (88 FR 37920, June 9, 2023), and CashFlow
would in turn need the same discipline over its own vendors: due diligence before use, contracts
that cover data, audit and termination, ongoing monitoring, and exit plans.

## 12. Operating controls that read a rule

Numbers in the code that follow a regulation or a network rule, all working assumptions:

| Control                                             | Value                            | Where                                           | Reading                                |
| --------------------------------------------------- | -------------------------------- | ----------------------------------------------- | -------------------------------------- |
| Decision deadline                                   | 30 days                          | `CONTROLS_POLICY.decisionNoticeDays`            | 1002.9(a)(1)(i)                        |
| Record retention floor                              | 12 months                        | `CONTROLS_POLICY.retentionMonths`               | 1002.12(b), business credit            |
| Counter offer window                                | 30 days, notice within 90        | `NOTICE_POLICY`, `src/adverse-action/policy.ts` | 1002.9(a)(1)(iv)                       |
| Incompleteness                                      | Notice at 10 days, 30 to respond | `NOTICE_POLICY`                                 | 1002.9(a)(1)(ii), (c)                  |
| Plan freeze notice                                  | With the freeze, within 30 days  | `NOTICE_POLICY.existingAccountNoticeDays`       | 1002.9(a)(1)(iii)                      |
| Rescreen interval                                   | 30 days                          | `CONTROLS_POLICY.rescreenIntervalDays`          | No rule; the floor for a batch program |
| Return rate window                                  | 60 days                          | `MONITORING_POLICY.payments`                    | Nacha, to confirm with the bank        |
| Unauthorized, administrative, overall return levels | 0.5%, 3%, 15%                    | `MONITORING_POLICY.payments`                    | Nacha Operating Rules 2.17.2           |

## 13. Where each per-document list lives

Questions first raised in other documents are kept there in context and collected below:
[`apps/api/UNDERWRITING.md`](apps/api/UNDERWRITING.md), "Reasons and adverse action notices"
and "Pass-through plans"; [`apps/api/DATA_CONNECTIONS.md`](apps/api/DATA_CONNECTIONS.md), "For
counsel and platform partnership review"; and comments in `apps/api/src/controls/policy.ts`,
`apps/api/src/monitoring/policy.ts`, `apps/api/src/monitoring/rules/compliance.ts`,
`apps/api/src/adverse-action/policy.ts` and `apps/api/src/providers/delegated-seat/toast.ts`.

## 14. Questions for counsel

Every open question in the repository, deduplicated. "Arises in" points to where the question
comes from in the code or the docs.

1. **Is the pass-through plan money transmission**, federally and in each state where it would
   operate, and if so which route fits: payment processor, agent of the payee with landlord
   agreements, or a licensed partner holding the funds? Arises in: `UNDERWRITING.md`,
   "Pass-through plans"; section 6 here; `apps/api/src/services/pass-through.ts`.
2. **Is a financed plan "credit" under ECOA, and is the pass-through plan?** The financed plan
   defers a debt (1002.2(j)); the pass-through plan advances nothing and is treated as not
   credit, so its offer and its end send no notice. Arises in: `UNDERWRITING.md`, "Questions for
   counsel" 2.
3. **FCRA and the identity provider.** Is any part of owner verification or screening a consumer
   report, and if it contributes to an adverse action must the notice carry the 1681m(a)
   disclosures? And what is needed before an owner's report is ever pulled (a guarantee, or
   written authorization)? Arises in: `UNDERWRITING.md` 3; section 3 here.
4. **In-app delivery of notices.** Is a notice delivered only in the app delivered under
   1002.9, or is E-SIGN consent (15 U.S.C. 7001(c)) or a mailed or emailed copy needed? Arises in:
   `UNDERWRITING.md` 4; `AdverseActionNotice.channel`.
5. **Counter offers.** Is a 30 day window before the notice reasonable, and should the counter
   offer and the notice go out together instead? Arises in: `UNDERWRITING.md` 5;
   `NOTICE_POLICY.counterOfferValidDays`.
6. **Incomplete applications.** Is sending a closing notice after an unanswered notice of
   incompleteness harmless, and are 10 days then 30 days reasonable? Arises in:
   `UNDERWRITING.md` 6; `NOTICE_POLICY`.
7. **Periodic reviews and freezes.** Freezing advances on a running plan, after a monthly
   review or by an operator's hold, is treated as an unfavorable change in terms
   (1002.2(c)(1)(ii)) and a `PLAN_FROZEN` notice is stored with the freeze. Is one owed, or does
   the delinquency exception (1002.2(c)(2)(ii)) cover a freeze for deterioration? Is the notice
   wording adequate, and is "plan under review" a specific enough reason for a hold an operator
   placed for a reason that cannot be disclosed? Should it also go by email or mail? Arises in:
   `UNDERWRITING.md` 7; `src/services/reunderwriting.ts`; `src/controls/operator-actions.ts`.
8. **Reasons drawn from fraud and veracity controls.** Is "we could not verify the revenue" or
   "account holder does not match" specific enough (commentary 9(b)(2) allows "unable to
   verify"), how can such reasons be worded without disclosing fraud controls, and is withholding
   the real reason ever acceptable? Arises in: `UNDERWRITING.md` 8; `DATA_CONNECTIONS.md` 7.
9. **Screening holds.** An application held on a watchlist match is never declined by the
   engine. If a reviewer declines it, what may the reason say? Arises in: `UNDERWRITING.md` 9;
   section 5 here.
10. **The creditor on the notice.** The name, address and contact are placeholders, and the
    agency named is the FTC under appendix A to Regulation B. Would a bank or capital partner, or a
    state license, change the agency or add one? Arises in: `UNDERWRITING.md` 1 and 10;
    `apps/api/src/adverse-action/policy.ts`.
11. **Deadlines and periods in the code.** Confirm the 30 day decision deadline and the readings
    in section 12, which `CONTROLS_POLICY` and the compliance monitoring rules measure against.
    Arises in: `apps/api/src/controls/policy.ts`; `apps/api/src/monitoring/rules/compliance.ts`.
12. **Record retention.** What must be kept, for how long, and when it must be deleted:
    applications and decisions (CashFlow keeps everything, with a 12 month floor, though it gives
    every applicant consumer-style notices), notices, audit events, and the raw snapshots that are
    the evidence for each decision, against data minimization. Arises in: `CONTROLS_POLICY.retentionMonths`;
    `DATA_CONNECTIONS.md` 6.
13. **Section 1071 and fair lending testing.** Would CashFlow be covered under the revised
    subpart B, and short of that, should it collect demographic data through a 1002.15 self-test
    or use a proxy method to test for disparate impact? Arises in: section 4 here.
14. **AML program.** Does a nonbank commercial lender of this shape need a BSA/AML program, by
    rule, by state license, or by a partner's contract, and would the answer change if the
    pass-through plan is money transmission? Arises in: section 5 here.
15. **Sanctions program.** Is a 30 day rescreen with a vendor batch adequate, what is the review
    standard for a possible match, and what are the blocking and reporting steps for a true
    match? Arises in: `CONTROLS_POLICY.rescreenIntervalDays`; section 5 here.
16. **Commercial financing disclosures.** Which state disclosure laws apply to this product
    (California, New York, Utah, Georgia, Florida, Kansas, Missouri and others), what must be
    disclosed and when, including any estimated annualized rate, and do the sales-based
    financing laws (Virginia, Connecticut, Texas) reach it? Arises in: section 7 here.
17. **Usury, rate structure and the true lender.** Is the fee interest, which state's usury law
    governs a plan, how does the annualized cost compare with commercial rate caps, and if a bank
    partner originates, who is the true lender? Arises in: section 7 here;
    `apps/api/src/underwriting/pricing.ts`.
18. **Licensing.** Which state lending or broker licenses are needed, in particular under the
    California Financing Law for plans under $5,000 and under California's 2026 changes for small
    business financing? Arises in: section 7 here.
19. **UDAP and marketing.** Review of the product copy and the app's descriptions of both plans
    under section 5 of the FTC Act and state law, including California's commercial financing
    UDAAP rules. Arises in: section 8 here.
20. **Personal accounts and privacy law.** Does reading a sole proprietor's personal account
    bring consumer protections into scope, and which privacy laws apply to owners' information?
    Arises in: `DATA_CONNECTIONS.md` 8; section 9 here.
21. **ACH origination.** The return rate thresholds and the 60 day window are to be confirmed
    with the originating bank, along with the debit authorization wording, CashFlow's role
    (originator or a third party behind the processor), and how pass-through debits are
    authorized. Arises in: `apps/api/src/monitoring/policy.ts`; section 10 here.
22. **Delegated seat access.** Do each platform's terms permit a third party's user, invited by
    the merchant, to sign in programmatically and export reports, does that need the platform's
    consent or a partner agreement, and could it be treated as unauthorized access? Assumed not
    permitted until confirmed in writing. Arises in: `DATA_CONNECTIONS.md` 1;
    `apps/api/src/providers/delegated-seat/toast.ts`.
23. **Platform API terms.** Each platform's developer terms for using merchant data in credit
    decisions, app review, and deletion on disconnect. Arises in: `DATA_CONNECTIONS.md` 2.
24. **Aggregator agreements.** Permitted use for underwriting and ongoing monitoring, the consent
    wording the aggregator requires, retention and deletion, and liability for accuracy. Arises
    in: `DATA_CONNECTIONS.md` 3.
25. **Open banking rule.** The status and effective dates of the personal financial data rights
    rule under Dodd-Frank section 1033, whether it reaches small business accounts, and the
    authorized third party obligations it would impose. Arises in: `DATA_CONNECTIONS.md` 4.
26. **Consent wording.** What the owner must be told before connecting (what is read, for what,
    how long, how to revoke), on the platform's consent screen and in the app. Arises in:
    `DATA_CONNECTIONS.md` 5.
27. **Cross-border data.** Platforms report a country; data from accounts outside the US is out
    of scope until reviewed. Arises in: `DATA_CONNECTIONS.md` 9.

## 15. Sources

Primary sources consulted, by section. Federal regulations are cited to the eCFR as of
November 2026.

- Regulation B, 12 CFR 1002.2, 1002.5, 1002.9, 1002.12, 1002.15, and subpart B (1002.101 et
  seq.): consumerfinance.gov/rules-policy/regulations/1002/ and ecfr.gov.
- Small Business Lending Under the Equal Credit Opportunity Act (Regulation B), 91 FR 23530 (May
  1, 2026): govinfo.gov; consumerfinance.gov/1071-rule/.
- FCRA, 15 U.S.C. 1681b and 1681m: govinfo.gov. FTC staff report, "40 Years of Experience with
  the Fair Credit Reporting Act" (July 2011): ftc.gov.
- 31 CFR 1010.100(t), (ff), (lll); 1010.230; part 1029: ecfr.gov. FinCEN ruling FIN-2014-R009
  (August 27, 2014): fincen.gov. OFAC FAQ 11: ofac.treasury.gov. Beneficial Ownership
  Information Reporting Requirement Revision, 90 FR 13688 (March 26, 2025): govinfo.gov.
- CSBS Money Transmission Modernization Act: csbs.org. DFPI opinion letter on the agent of payee
  exemption (October 4, 2018): dfpi.ca.gov. N.Y. Banking Law 641: nysenate.gov.
- California commercial financing disclosure regulations, 10 CCR 900 to 956: dfpi.ca.gov. N.Y.
  Fin. Serv. Law article 8: nysenate.gov. Va. Code 6.2-2228 et seq.: law.lis.virginia.gov. Fla.
  Stat. 559.961 et seq.: leg.state.fl.us. Mo. Rev. Stat. 427.300: revisor.mo.gov. Kansas 2024
  Sess. Laws ch. 29: kssos.org. Connecticut registration guidance: portal.ct.gov/dob. Texas HB 700
  bill analysis: capitol.texas.gov.
- 12 U.S.C. 5481, 5531, 5536; 15 U.S.C. 45: govinfo.gov. FTC v. Yellowstone Capital LLC and FTC
  v. RCG Advances, LLC: ftc.gov. California commercial financing UDAAP regulations, 10 CCR 1060
  to 1062: dfpi.ca.gov.
- 16 CFR part 314; 15 U.S.C. 6801 et seq.: ecfr.gov, govinfo.gov.
- Nacha Operating Rules, ACH network risk and enforcement topics: nacha.org.
- Interagency Guidance on Third-Party Relationships: Risk Management, 88 FR 37920 (June 9,
  2023): govinfo.gov.

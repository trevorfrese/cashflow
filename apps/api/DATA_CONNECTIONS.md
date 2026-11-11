# Data connections and veracity

How CashFlow gets a business's bank and sales data, how it knows the data is the business's
own and has not been altered, and what it does when it cannot tell. The checks themselves,
and what each one does to a decision, are in [`UNDERWRITING.md`](UNDERWRITING.md),
"Veracity". This note covers the connections.

Everything here runs on sandbox providers by default. The real adapters are compile-only
skeletons that refuse to start without explicit configuration, and nothing in this
repository has been exercised against a real platform, aggregator, or bank.

## The rule: we pull it ourselves, or we do not use it

Underwriting reads only data CashFlow fetched from the source, through a connection the owner
authorized. There is no upload path for statements or exports, and none is planned: a file
the applicant hands over is a file the applicant could have edited, and checking one well
(fonts, metadata, arithmetic, issuer templates) is a business of its own. A business that
cannot connect is asked to connect; it is not asked for a PDF.

## Three ways to connect

Every connection records its access method (`ConnectionAccessMethod`) as a first-class
field. The method decides the trust tier, what the owner is told, and what an operator sees.

| Method           | Used for                                         | How it works                                                                                                                                                                                                                           | Method tier                                                      |
| ---------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `DIRECT_OAUTH`   | Square, Shopify, Stripe, Clover                  | The owner approves read-only access on the platform's own site. The platform redirects back with a code; CashFlow exchanges it (with the PKCE verifier where the platform supports PKCE) for tokens and calls the platform API itself. | HIGH                                                             |
| `DELEGATED_SEAT` | Toast, and any platform without a self-serve API | The owner invites CashFlow's own service user onto their account as a read-only reports user. CashFlow's agent signs in with CashFlow's credentials for that seat and pulls reports.                                                   | MEDIUM                                                           |
| `AGGREGATOR`     | Banks                                            | A bank data aggregator's connection (Plaid shaped). Large banks connect through the bank's own OAuth; the aggregator reports whether this connection did.                                                                              | HIGH when the bank authorized it, MEDIUM for a legacy connection |

The tier after the checks is lower when a check excluded or referred the source (LOW), and
NONE when it could not be pulled. The applicant never chooses a tier.

### Excluded on purpose

- **Credentialed bank login.** CashFlow does not take, store, or use anyone's bank username
  and password, and there is no code path for it, not even a skeleton. Screen scraping a
  customer's bank on their credentials puts their account at risk, breaks most banks' terms,
  and is being displaced by bank-authorized OAuth through aggregators. Where a bank offers no
  OAuth, the aggregator's own legacy connection is used, and the connection is marked so
  (tier MEDIUM).
- **Uploaded statements.** See above.
- **The merchant's platform password.** A delegated seat is CashFlow's own user on the
  merchant's account. The merchant never shares their login.

## What each connection records

All of it comes from the platform or the aggregator at connect time and on every pull, never
from what the applicant typed.

| Field            | Bank (`BankLink`)                                                 | Platform (`CommerceLink`)                                         |
| ---------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| Access method    | `AGGREGATOR`                                                      | `DIRECT_OAUTH` or `DELEGATED_SEAT`                                |
| Account identity | Holder names, account type (business or personal), opened         | Legal name, platform account id, country, created, tax id last 4  |
| Where money goes | Every account visible on the login, shared or not                 | Payout destinations (institution, last 4, reference)              |
| Authorization    | Bank-authorized (OAuth) or legacy, consent scopes, consent expiry | Scopes granted, token expiry, seat service user and when verified |
| Health           | `HEALTHY`, `PENDING`, `REAUTH_REQUIRED`, `ERROR`, `REVOKED`       | The same                                                          |
| Pulls            | Last successful pull, last error                                  | The same                                                          |
| Revocation       | Revoked at, tokens deleted                                        | The same                                                          |

**Why extend the two link tables rather than add one connection table.** Collections,
returns, monitoring, the operator views, and the application all point at `BankLink` and
`CommerceLink` already, and a bank connection and a platform connection carry different
identity fields. A shared table would have meant a migration of every foreign key and a
polymorphic identity column for one small saving. The two tables gained the same provenance
columns instead, the snapshot table refers to either, and the customer and operator views
present them as one list of connections.

## Tokens

- Platform and aggregator tokens (access, refresh) and the PKCE verifier of an authorization
  in flight are sealed with AES-256-GCM under a key derived by HKDF-SHA256 from
  `CONNECTION_TOKEN_KEY`, with a fresh IV each time and the business id bound in as
  additional data (`src/crypto/token-vault.ts`, unit tested). A ciphertext moved to another
  business's row does not open.
- Without a key the vault uses a fixed, public sandbox key so that the mocks work out of the
  box. `loadConfig` refuses to start when any real adapter is configured without
  `CONNECTION_TOKEN_KEY`, and each skeleton refuses again in its constructor.
- A token is opened only for the call that needs it and dropped. No response, log line, or
  audit payload carries a token or a sealed token; the integration tests decrypt every stored
  token and assert that none of them appears in any response or audit row. An operator sees
  only whether one is stored and when it expires.
- Tokens are refreshed `TOKEN_REFRESH_LEAD_DAYS` (3) before expiry by the `refresh-connections`
  job, and on demand before a pull. A refused refresh marks the connection `REAUTH_REQUIRED`.
- Disconnecting revokes at the platform (or the aggregator) and deletes the tokens. The row
  and its snapshots stay, as evidence.
- `providerAccountToken` on a bank link is the payments processor's debit token, which
  existed before this phase. It is still stored as an opaque string and never returned; it is
  not sealed by the vault, because the payments provider owns it. See "For a production
  deployment" below.

## OAuth, as built

1. `POST /v1/connections/oauth/start` with the business and platform. CashFlow makes a random
   `state` and a PKCE verifier, stores the authorization (verifier sealed) for 15 minutes,
   and returns the platform's authorization URL with read-only scopes, the state, and the S256
   challenge.
2. The owner approves on the platform's site. In the sandbox the URL points at CashFlow's own
   stand-in, `POST /v1/connections/oauth/mock-authorize`, which answers with the redirect a
   real platform would send (code and state in the query). Tests and the app follow it
   without a browser.
3. `POST /v1/connections/oauth/callback` with the state and code. The authorization is
   consumed atomically (a code is exchanged once), must belong to the caller, and must not have
   expired. The code is exchanged with the verifier, the platform's identity and payout
   destinations are recorded, and the first pull is taken.

Read-only scopes per platform are in `providers/commerce/mock.ts` (`READ_ONLY_SCOPES`) and in
each skeleton's notes. No scope that can move money is ever requested.

## Delegated seats

For platforms that offer no self-serve API (Toast), the owner adds CashFlow's service user to
their account as a read-only reports user, and CashFlow's agent pulls reports through it.
`providers/delegated-seat/` defines `DelegatedSeatProvider` (invitation, seat check) and a
`ReportPuller`; the sandbox implements both on the mock platform's data. The real puller is a
skeleton that refuses to run. **No browser automation exists in this repository.**

The design a real puller must follow:

- **The seat is ours and read only.** CashFlow's own user, created per platform, invited by
  the merchant, with a role limited to reports. The seat check refuses a seat with any write
  permission. CashFlow never asks for, receives, or stores the merchant's credentials.
- **Credentials for the seat live in a secret store.** The configuration carries a reference
  (`TOAST_SEAT_CREDENTIALS_REF`), never a password in the environment or the database. Second
  factor enrollment for the service user is CashFlow's, held in the same store.
- **Session isolation per merchant.** One browser or agent context per merchant per pull,
  never reused across merchants, discarded after the pull, with no shared cookies or cache.
  A pull for one merchant cannot see another's data even if the platform would allow the
  seat to switch accounts.
- **Rate and politeness limits.** At most one pull per merchant per day outside a decision,
  serialized per platform, with a delay between page loads, during off-peak hours, and with a
  backoff on any throttling (`RATE_LIMITED` fails the pull and it is retried on a later run).
- **Fail closed on layout change.** Every export is parsed against a pinned layout (columns,
  headers, totals that must add up). Any difference throws `ReportPullError('LAYOUT_CHANGED')`:
  nothing from that pull is stored, the connection goes to `ERROR`, the owner is asked to
  reconnect, and an alert opens for a business with an active plan. Never partial data.
- **Every pull is audited** (`DATA_PULLED` or `DATA_PULL_FAILED`, with the snapshot id, hash,
  counts and the failure reason), and the snapshot is kept.
- **Terms.** Automated access through a seat must be permitted by the platform's terms of
  service and any partner agreement. That is a question for counsel before a single real pull
  (see below). A platform partnership with API access replaces the seat as soon as one exists.

## Banks

`BankLinkProvider` reports, beyond transactions and balance: the account holder and account
type, the open date where the aggregator has one, every account visible on the login (so an
applicant cannot share a clean account and hide the one with the debts in it, within one
login), whether the bank authorized the connection through OAuth, and the item's health. The
Plaid skeleton's notes map each to the product that provides it (Identity, Accounts, Item,
Assets) and are marked not exercised.

## Snapshots

Every pull is stored as a `DataSnapshot`: the connection, when it was pulled (on the
project's clock helpers, so simulated dates work), the window it covers, the normalized
payload, record counts, and a sha256 over a canonical serialization of the payload (keys
sorted at every level). The table is append only: a trigger rejects UPDATE and DELETE, as on
the audit table, and its ids are plain columns, so deleting a business never has to delete its
evidence. A re-pull is a new row.

Underwriting reads only through snapshots. Each decision's snapshot stores the ids and hashes
of the snapshots its veracity assessment read, so a decision can be reproduced from them, and
anyone can check that they were not altered (`verifySnapshot` recomputes the hash).

**The freshness rule.** A decision uses a snapshot pulled within the policy's
`maxSnapshotAgeDays` (1) of the decision date; otherwise it pulls again first. If that pull
fails, the source has no current snapshot: a bank becomes `NEEDS_INFO` (reconnect), a platform
is dropped from the decision and the owner is asked to reconnect it. Nothing is decided on
stale data. Applications, periodic reviews, and the refresh job all go through
`gatherDecisionData` in `services/connections.ts`, so this is one rule.

**Storage.** The sandbox keeps payloads in Postgres JSON with a 5 MB guard (a year of a busy
account is a few hundred KB). Production would write the payload to object storage, write
once and versioned, and keep the key and hash in the row.

**The sandbox's two generators.** The sandbox bank and the sandbox platform are independent
generators. So that they tell one story, the mock platform pays out exactly the card
settlement deposits of the business's connected sandbox bank, and a platform pull taken
before that bank was connected is taken again. Real platforms need none of this. Sandbox
histories are anchored on the day they are connected and continue forward from there, so a
later pull sees the same past (which is what the consistency check compares).

## Audit

`CONNECTION_CONNECTED`, `CONSENT_GRANTED` (scopes and expiry), `DATA_PULLED`,
`DATA_PULL_FAILED`, `TOKEN_REFRESHED`, `TOKEN_REFRESH_FAILED`, `CONNECTION_REVOKED`,
`SEAT_INVITED`, `SEAT_VERIFIED`, `PAYOUT_DESTINATION_CHANGED`, and `VERACITY_ASSESSED` (every
decision's assessment, and the refresh job's): outcome, finding codes and consequences,
settlement match, snapshot ids and hashes. Never a payload, never a token.

## For counsel and platform partnership review

These are open questions and working assumptions, not conclusions.

1. **Automated access through a delegated seat.** Whether each platform's terms of service
   permit a third party's user, invited by the merchant, to sign in programmatically and
   export reports; whether that needs the platform's consent or a partner agreement; and
   whether a platform could treat it as unauthorized access. Assumed not permitted until
   confirmed in writing.
2. **Platform API terms.** Each platform's developer terms for using merchant data in credit
   decisions (some restrict use to services for the merchant), app review requirements, and
   data deletion obligations on disconnect.
3. **Aggregator agreements.** Permitted use for underwriting and ongoing monitoring, the
   consent wording the aggregator requires, data retention and deletion, and liability for
   data accuracy.
4. **Open banking rule status.** The status and effective dates of the US personal financial
   data rights rule (Dodd-Frank section 1033) and whether, and how, it reaches small business
   accounts and the authorized third party obligations it would impose (authorization
   disclosures, duration and re-authorization, secondary use limits).
5. **Consent wording.** What the owner must be told before connecting (what is read, for what,
   for how long, how to revoke), on the platform consent screen and in the app.
6. **Retention of raw pulls.** How long snapshots may and must be kept: evidence for a
   decision (adverse action and fair lending record keeping) against minimization. The sandbox
   keeps them forever.
7. **Use of findings in decisions.** Whether reasons derived from veracity findings (for
   example, "account holder does not match") need to be given as adverse action reasons, and
   how to word them without disclosing fraud controls.
8. **Personal accounts.** Reading a sole proprietor's personal account may bring consumer
   protections into scope.
9. **Cross-border.** Platforms report a country; data from accounts outside the US is out of
   scope until reviewed.

## For a production deployment

- Payload storage in object storage, not Postgres.
- The payments processor token (`providerAccountToken`) sealed by the vault as well.
- Key rotation for `CONNECTION_TOKEN_KEY`: the key id in each ciphertext is there so a second
  key can be added and old values re-sealed.
- Webhooks from aggregators and platforms (item errors, consent revoked, payouts) instead of
  waiting for the daily job.
- A real browser or agent runtime for seats only after item 1 above is settled, and only for a
  platform with no partnership available.

import type { BankTransaction, CashFlowSummary, IsoDate } from '@cashflow/shared';
import { addDays, daysBetween, formatCents } from '@cashflow/shared';

import type { IntegrityPolicy } from './policy.ts';

/**
 * Integrity checks: is the application what it says it is.
 *
 * The scorecard asks whether a business can afford the rent. These checks ask a different
 * question: whether the numbers in front of the scorecard can be trusted. Each check is a
 * pure function over the same data the engine already has (transactions, the feature
 * summary, what the applicant stated) plus a few facts the service looks up in the database
 * and passes in (`IntegrityContext`). Each returns zero or one flag.
 *
 * What a flag does to the decision is fixed in one table, `INTEGRITY_RULES`, below.
 */

export type IntegritySeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * KNOCKOUT   decline, with a reason the applicant can read
 * NEEDS_INFO ask the applicant for something specific before deciding
 * REFER      a reviewer decides; the engine records what it would have done
 * CAP        the limit is held down (see `exposure.ts`); no other effect
 * INFORM     recorded on the decision for reviewers and monitoring; no effect on the outcome
 */
export type IntegrityAction = 'KNOCKOUT' | 'NEEDS_INFO' | 'REFER' | 'CAP' | 'INFORM';

export const INTEGRITY_CODES = [
  'STATED_REVENUE_FAR_ABOVE_VERIFIED',
  'STATED_REVENUE_ABOVE_VERIFIED',
  'STATED_REVENUE_BELOW_VERIFIED',
  'POS_DEPOSIT_SHORTFALL',
  'POS_DEPOSIT_EXCESS',
  'ROUND_TRIP_DEPOSITS',
  'ROUND_TRIP_SUSPECTED',
  'NON_SALES_CREDIT_SHARE',
  'OWNER_TOP_UPS_BEFORE_APPLYING',
  'REVENUE_SPIKE',
  'SHORT_ACCOUNT_HISTORY',
  'RENT_ABOVE_OBSERVED',
  'NO_RENT_OBSERVED',
  'LANDLORD_IS_APPLICANT_ACCOUNT',
  'DUPLICATE_LANDLORD_ACCOUNT',
  'DUPLICATE_BANK_ACCOUNT',
  'DUPLICATE_BUSINESS_IDENTITY',
  'IDENTITY_VERIFICATION_FAILED',
  'IDENTITY_NOT_VERIFIED',
  'SCREENING_POSSIBLE_MATCH',
  'SCREENING_MATCH',
] as const;
export type IntegrityCode = (typeof INTEGRITY_CODES)[number];

/**
 * The one place that says what each flag does.
 *
 * The rule of thumb: decline automatically only on a pattern that has no innocent reading
 * (deposits that repeatedly leave as same sized transfers, a landlord account that is the
 * applicant's own). Anything a legitimate business could show goes to a person or only
 * limits the amount, because a wrong automatic decline for suspected fraud is the most
 * expensive mistake to make to an honest applicant.
 */
export const INTEGRITY_RULES: Readonly<
  Record<IntegrityCode, { severity: IntegritySeverity; action: IntegrityAction; why: string }>
> = {
  STATED_REVENUE_FAR_ABOVE_VERIFIED: {
    severity: 'MEDIUM',
    action: 'NEEDS_INFO',
    why: 'Usually a second account we cannot see. Ask for it rather than guess.',
  },
  STATED_REVENUE_ABOVE_VERIFIED: {
    severity: 'LOW',
    action: 'INFORM',
    why: 'Owners round up. The decision already uses the verified figure, so the overstatement cannot buy a larger limit.',
  },
  STATED_REVENUE_BELOW_VERIFIED: {
    severity: 'LOW',
    action: 'INFORM',
    why: 'Deposits far above what the owner says the business makes can be deposits that are not sales, but the round trip and non sales credit checks test that directly. On its own it is usually a seasonal peak or a modest owner.',
  },
  POS_DEPOSIT_SHORTFALL: {
    severity: 'LOW',
    action: 'INFORM',
    why: 'Sales settle to an account we cannot see. Revenue falls back to the bank figure.',
  },
  POS_DEPOSIT_EXCESS: {
    severity: 'MEDIUM',
    action: 'REFER',
    why: 'Deposits well above point of sale sales need a source: another channel, or padding.',
  },
  ROUND_TRIP_DEPOSITS: {
    severity: 'CRITICAL',
    action: 'KNOCKOUT',
    why: 'Repeated credits that leave as transfers of the same size within days are not revenue, and a pattern of them has no innocent reading at this scale.',
  },
  ROUND_TRIP_SUSPECTED: {
    severity: 'HIGH',
    action: 'REFER',
    why: 'One or two matches can be an owner moving a large payment to savings. The matched credits are left out of revenue either way.',
  },
  NON_SALES_CREDIT_SHARE: {
    severity: 'MEDIUM',
    action: 'REFER',
    why: 'An account fed mostly by transfers and loans shows funding, not trading.',
  },
  OWNER_TOP_UPS_BEFORE_APPLYING: {
    severity: 'LOW',
    action: 'INFORM',
    why: 'Money moved in just before applying flatters the cash buffer. It is common and honest often enough that it only informs; conduct and buffer are already scored.',
  },
  REVENUE_SPIKE: {
    severity: 'MEDIUM',
    action: 'REFER',
    why: 'A jump in the last six weeks that last year does not explain may be staged.',
  },
  SHORT_ACCOUNT_HISTORY: {
    severity: 'MEDIUM',
    action: 'REFER',
    why: 'The account is much younger than the business claims to be. Often a bank switch, sometimes a front.',
  },
  RENT_ABOVE_OBSERVED: {
    severity: 'HIGH',
    action: 'CAP',
    why: 'We front what we can see the business already pays, plus a margin. A lease several times the observed rent is the bust out pattern; the cap bounds it without accusing anyone.',
  },
  NO_RENT_OBSERVED: {
    severity: 'MEDIUM',
    action: 'REFER',
    why: 'Nothing in the account anchors the lease. A reviewer verifies it another way.',
  },
  LANDLORD_IS_APPLICANT_ACCOUNT: {
    severity: 'CRITICAL',
    action: 'KNOCKOUT',
    why: 'Rent paid to the applicant is a cash advance to the applicant.',
  },
  DUPLICATE_LANDLORD_ACCOUNT: {
    severity: 'LOW',
    action: 'INFORM',
    why: 'One landlord with several tenants is normal. Recorded for monitoring.',
  },
  DUPLICATE_BANK_ACCOUNT: {
    severity: 'HIGH',
    action: 'REFER',
    why: 'The same bank account under two different owners is one business applying twice or a shared mule account.',
  },
  DUPLICATE_BUSINESS_IDENTITY: {
    severity: 'HIGH',
    action: 'REFER',
    why: 'The same legal name at the same address under another user.',
  },
  IDENTITY_VERIFICATION_FAILED: {
    severity: 'CRITICAL',
    action: 'KNOCKOUT',
    why: 'The identity provider could not find the business or one of its owners. We do not lend to a party we cannot identify. A reviewer who verifies it another way can reconsider the decline.',
  },
  IDENTITY_NOT_VERIFIED: {
    severity: 'MEDIUM',
    action: 'REFER',
    why: 'Verification came back needing review, or has not run (a business that predates it, a missing tax id or owner). A mismatch is usually a typo or a recent move, so a person looks rather than the engine declining.',
  },
  SCREENING_POSSIBLE_MATCH: {
    severity: 'HIGH',
    action: 'REFER',
    why: 'A name resembles a sanctions or watchlist entry. Most are false positives on common names; none may be approved until a reviewer has cleared it.',
  },
  SCREENING_MATCH: {
    severity: 'CRITICAL',
    action: 'REFER',
    why: 'A name matches a sanctions or watchlist entry. The application is blocked in review and cannot be approved while the hit is open. It is not declined automatically, because the decline reason would tell the applicant what was found.',
  },
};

export interface IntegrityFlag {
  code: IntegrityCode;
  severity: IntegritySeverity;
  action: IntegrityAction;
  /** Written for a reviewer. Not shown to applicants. */
  detail: string;
  /** The numbers behind the flag. */
  metrics: Record<string, number>;
}

/**
 * Facts that need a database lookup. The service gathers them; the engine stays pure. Any
 * field left undefined means "not checked", which never raises a flag.
 */
export interface IntegrityContext {
  /** A lease's landlord payout account is one of the business's own linked accounts. */
  landlordAccountIsApplicantAccount?: boolean;
  /** Other users' businesses whose lease pays the same landlord account. */
  otherBusinessesWithSameLandlordAccount?: number;
  /** Other users' businesses that linked the same bank account. */
  otherBusinessesWithSameBankAccount?: number;
  /** Other users' businesses with the same legal name and address. */
  otherBusinessesWithSameIdentity?: number;
  /** A reviewer has verified the lease, which lifts the observed rent cap and its flags. */
  leaseVerified?: boolean;
  /**
   * Identity verification and sanctions screening, as the service gathered them from the
   * identity provider's stored results. Absent means not checked.
   */
  identity?: IdentityFacts;
}

export interface IdentityFacts {
  /** The worst verification status across the business and its beneficial owners. */
  verification: 'VERIFIED' | 'REVIEW' | 'FAILED' | 'UNVERIFIED';
  /** Provider reason codes behind anything that is not VERIFIED. */
  verificationReasons: string[];
  /**
   * The worst open screening result across the business, its owners, and its landlords. A
   * hit that a reviewer has cleared counts as CLEAR.
   */
  screening: 'CLEAR' | 'POSSIBLE_MATCH' | 'MATCH';
  /** How many parties have an open hit. */
  openHits: number;
}

export interface IntegrityInput {
  transactions: readonly BankTransaction[];
  asOf: IsoDate;
  summary: CashFlowSummary;
  statedMonthlyRevenueCents: number;
  timeInBusinessMonths: number;
  requestedMonthlyRentCents: number;
  /** False on a periodic review, where the figure stated at application is out of date. */
  checkStatedRevenue?: boolean;
  /** Stated revenue variance above which the applicant is asked for more information. */
  maxStatedRevenueVarianceBps: number;
  /** Deposit match below which point of sale revenue is not trusted. */
  minDepositMatchBps: number;
  context?: IntegrityContext | null;
}

function flag(code: IntegrityCode, detail: string, metrics: Record<string, number>): IntegrityFlag {
  const rule = INTEGRITY_RULES[code];
  return { code, severity: rule.severity, action: rule.action, detail, metrics };
}

const pct = (bpsValue: number) => `${(bpsValue / 100).toFixed(0)}%`;
const usd = (cents: number) => formatCents(cents, { showCents: false });
const bps = (n: number, d: number) => (d === 0 ? 0 : Math.round((n * 10_000) / d));

const SALES_CREDITS = new Set([
  'CARD_SETTLEMENT',
  'CASH_DEPOSIT',
  'INVOICE_PAYMENT',
  'OTHER_INCOME',
]);
const NON_SALES_CREDITS = new Set(['TRANSFER_IN', 'LOAN_PROCEEDS']);

// ---------- Stated versus verified revenue ----------

export function checkStatedRevenue(
  input: Pick<
    IntegrityInput,
    'summary' | 'statedMonthlyRevenueCents' | 'maxStatedRevenueVarianceBps'
  >,
  policy: IntegrityPolicy,
): IntegrityFlag | null {
  const variance = input.summary.statedRevenueVarianceBps;
  const metrics = {
    statedMonthlyRevenueCents: input.statedMonthlyRevenueCents,
    verifiedMonthlyRevenueCents: input.summary.verifiedMonthlyRevenueCents,
    varianceBps: variance,
  };
  const detail = `Stated ${usd(input.statedMonthlyRevenueCents)} a month, verified ${usd(input.summary.verifiedMonthlyRevenueCents)}.`;
  if (variance > input.maxStatedRevenueVarianceBps) {
    return flag('STATED_REVENUE_FAR_ABOVE_VERIFIED', detail, metrics);
  }
  if (variance > policy.statedAboveInformBps) {
    return flag('STATED_REVENUE_ABOVE_VERIFIED', detail, metrics);
  }
  if (input.summary.verifiedMonthlyRevenueCents > 0 && variance < policy.statedBelowReferBps) {
    return flag('STATED_REVENUE_BELOW_VERIFIED', detail, metrics);
  }
  return null;
}

// ---------- Point of sale versus bank deposits ----------

export function checkDepositMatch(
  input: Pick<IntegrityInput, 'summary' | 'minDepositMatchBps'>,
  policy: IntegrityPolicy,
): IntegrityFlag | null {
  const match = input.summary.commerce?.depositMatchBps;
  if (match === null || match === undefined) return null;
  const metrics = { depositMatchBps: match };
  if (match < input.minDepositMatchBps) {
    return flag(
      'POS_DEPOSIT_SHORTFALL',
      `Bank deposits cover ${pct(match)} of point of sale net sales.`,
      metrics,
    );
  }
  if (match > policy.maxDepositMatchBps) {
    return flag(
      'POS_DEPOSIT_EXCESS',
      `Bank deposits are ${pct(match)} of point of sale net sales.`,
      metrics,
    );
  }
  return null;
}

// ---------- Round tripping ----------

export interface RoundTripMatch {
  creditId: string;
  transferId: string;
  amountCents: number;
  creditDate: IsoDate;
}

/**
 * Pair each sales looking credit with a later transfer out of about the same size. Greedy
 * and in date order: each transfer can explain one credit. Daily card settlements are small
 * and never the same size as a transfer by chance; `minAmountCents` keeps it that way.
 */
export function findRoundTrips(
  transactions: readonly BankTransaction[],
  asOf: IsoDate,
  policy: IntegrityPolicy['roundTrip'],
): RoundTripMatch[] {
  const from = addDays(asOf, -179);
  const inWindow = transactions.filter((t) => !t.pending && t.date >= from && t.date <= asOf);
  const transfers = inWindow
    .filter((t) => t.category === 'TRANSFER_OUT' && -t.amountCents >= policy.minAmountCents)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (transfers.length === 0) return [];
  const credits = inWindow
    .filter((t) => SALES_CREDITS.has(t.category) && t.amountCents >= policy.minAmountCents)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const used = new Set<string>();
  const matches: RoundTripMatch[] = [];
  for (const credit of credits) {
    const tolerance = (credit.amountCents * policy.amountToleranceBps) / 10_000;
    const partner = transfers.find(
      (t) =>
        !used.has(t.id) &&
        t.date >= credit.date &&
        daysBetween(credit.date, t.date) <= policy.windowDays &&
        Math.abs(-t.amountCents - credit.amountCents) <= tolerance,
    );
    if (!partner) continue;
    used.add(partner.id);
    matches.push({
      creditId: credit.id,
      transferId: partner.id,
      amountCents: credit.amountCents,
      creditDate: credit.date,
    });
  }
  return matches;
}

export function checkRoundTrips(
  input: Pick<IntegrityInput, 'transactions' | 'asOf'>,
  policy: IntegrityPolicy,
  matches: readonly RoundTripMatch[] = findRoundTrips(
    input.transactions,
    input.asOf,
    policy.roundTrip,
  ),
): IntegrityFlag | null {
  if (matches.length === 0) return null;
  const from90 = addDays(input.asOf, -89);
  const recent = matches.filter((m) => m.creditDate >= from90);
  const matched90 = recent.reduce((sum, m) => sum + m.amountCents, 0);
  let credits90 = 0;
  for (const t of input.transactions) {
    if (!t.pending && t.date >= from90 && t.date <= input.asOf && t.amountCents > 0) {
      if (SALES_CREDITS.has(t.category)) credits90 += t.amountCents;
    }
  }
  const shareBps = bps(matched90, credits90);
  const metrics = {
    pairs: matches.length,
    pairs90: recent.length,
    matched90Cents: matched90,
    shareBps,
  };
  const detail = `${matches.length} credit${matches.length === 1 ? '' : 's'} in the last six months left as a transfer of the same size within ${policy.roundTrip.windowDays} days: ${pct(shareBps)} of the last 90 days of sales credits.`;
  const r = policy.roundTrip;
  if (recent.length >= r.knockoutPairs && shareBps >= r.knockoutShareBps) {
    return flag('ROUND_TRIP_DEPOSITS', detail, metrics);
  }
  if (matches.length >= r.referPairs && shareBps >= r.referShareBps) {
    return flag('ROUND_TRIP_SUSPECTED', detail, metrics);
  }
  return null;
}

// ---------- Non sales credits and owner top ups ----------

function creditTotals(transactions: readonly BankTransaction[], from: IsoDate, asOf: IsoDate) {
  let sales = 0;
  let nonSales = 0;
  let transfersIn = 0;
  for (const t of transactions) {
    if (t.pending || t.amountCents <= 0 || t.date < from || t.date > asOf) continue;
    if (SALES_CREDITS.has(t.category)) sales += t.amountCents;
    else if (NON_SALES_CREDITS.has(t.category)) {
      nonSales += t.amountCents;
      if (t.category === 'TRANSFER_IN') transfersIn += t.amountCents;
    }
  }
  return { sales, nonSales, transfersIn };
}

export function checkNonSalesCredits(
  input: Pick<IntegrityInput, 'transactions' | 'asOf'>,
  policy: IntegrityPolicy,
): IntegrityFlag | null {
  const { sales, nonSales } = creditTotals(
    input.transactions,
    addDays(input.asOf, -89),
    input.asOf,
  );
  const shareBps = bps(nonSales, sales + nonSales);
  if (shareBps <= policy.maxNonSalesCreditShareBps) return null;
  return flag(
    'NON_SALES_CREDIT_SHARE',
    `Transfers in and loan proceeds are ${pct(shareBps)} of all credits over the last 90 days.`,
    { nonSalesCents: nonSales, salesCents: sales, shareBps },
  );
}

export function checkOwnerTopUps(
  input: Pick<IntegrityInput, 'transactions' | 'asOf' | 'summary'>,
  policy: IntegrityPolicy,
): IntegrityFlag | null {
  const revenue = input.summary.verifiedMonthlyRevenueCents;
  if (revenue <= 0) return null;
  const last30 = creditTotals(input.transactions, addDays(input.asOf, -29), input.asOf).transfersIn;
  const last90 = creditTotals(input.transactions, addDays(input.asOf, -89), input.asOf).transfersIn;
  const shareBps = bps(last30, revenue);
  // Concentrated: most of the quarter's transfers in arrived in the final month.
  if (shareBps <= policy.ownerTopUpShareBps || last30 * 2 < last90) return null;
  return flag(
    'OWNER_TOP_UPS_BEFORE_APPLYING',
    `${usd(last30)} was transferred in during the 30 days before applying, ${pct(shareBps)} of monthly revenue.`,
    { transfersIn30Cents: last30, transfersIn90Cents: last90, shareBps },
  );
}

// ---------- Revenue spike ----------

export function checkRevenueSpike(
  input: Pick<IntegrityInput, 'transactions' | 'asOf' | 'summary'>,
  policy: IntegrityPolicy,
): IntegrityFlag | null {
  const first = input.transactions.reduce<IsoDate | null>(
    (min, t) => (min === null || t.date < min ? t.date : min),
    null,
  );
  if (first === null || daysBetween(first, input.asOf) + 1 < 26 * 7) return null;
  const recent = creditTotals(
    input.transactions,
    addDays(input.asOf, -(6 * 7 - 1)),
    input.asOf,
  ).sales;
  const prior = creditTotals(
    input.transactions,
    addDays(input.asOf, -(26 * 7 - 1)),
    addDays(input.asOf, -6 * 7),
  ).sales;
  if (prior <= 0) return null;
  const spikeBps = bps(recent / 6 - prior / 20, prior / 20);
  if (spikeBps <= policy.maxRevenueSpikeBps) return null;
  // Last year's same weeks were just as far above the baseline: a season, not a spike.
  const yoy = input.summary.revenueTrend?.yearOverYearBps ?? null;
  if (yoy !== null && yoy < spikeBps / 2) return null;
  return flag(
    'REVENUE_SPIKE',
    `Sales credits over the last six weeks run ${pct(spikeBps)} above the twenty weeks before.`,
    {
      spikeBps,
      recentWeeklyCents: Math.round(recent / 6),
      priorWeeklyCents: Math.round(prior / 20),
    },
  );
}

// ---------- Account history versus time in business ----------

export function checkAccountHistory(
  input: Pick<IntegrityInput, 'transactions' | 'asOf' | 'timeInBusinessMonths'>,
  policy: IntegrityPolicy,
): IntegrityFlag | null {
  const first = input.transactions.reduce<IsoDate | null>(
    (min, t) => (min === null || t.date < min ? t.date : min),
    null,
  );
  if (first === null) return null;
  const historyMonths = Math.round(((daysBetween(first, input.asOf) + 1) / 30.4) * 10) / 10;
  // A lookback of a year is all we ask the bank for, so a year is all we can expect to see.
  const expectedMonths = Math.min(12, input.timeInBusinessMonths);
  const gap = expectedMonths - historyMonths;
  if (gap <= policy.maxHistoryGapMonths) return null;
  return flag(
    'SHORT_ACCOUNT_HISTORY',
    `The account shows ${historyMonths} months of activity; the business reports ${input.timeInBusinessMonths} months of trading.`,
    { historyMonths, timeInBusinessMonths: input.timeInBusinessMonths, gapMonths: gap },
  );
}

// ---------- Requested rent versus rent observed in the account ----------

export function checkObservedRent(
  input: Pick<IntegrityInput, 'summary' | 'requestedMonthlyRentCents' | 'context'>,
  policy: IntegrityPolicy,
): IntegrityFlag | null {
  if (input.context?.leaseVerified) return null;
  const observed = input.summary.observedRentCents;
  const requested = input.requestedMonthlyRentCents;
  if (observed === null || observed <= 0) {
    return flag('NO_RENT_OBSERVED', `No rent payments found; ${usd(requested)} requested.`, {
      requestedMonthlyRentCents: requested,
    });
  }
  const multipleBps = bps(requested, observed);
  if (multipleBps <= policy.rentAboveObservedBps) return null;
  return flag(
    'RENT_ABOVE_OBSERVED',
    `Requested ${usd(requested)} a month; the account pays ${usd(observed)}: ${(multipleBps / 10_000).toFixed(1)} times the observed rent.`,
    { requestedMonthlyRentCents: requested, observedRentCents: observed, multipleBps },
  );
}

// ---------- Lookups supplied by the service ----------

const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(llc|inc|corp|co|ltd)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Is a lease's landlord payout account one of the applicant's own accounts. Two ways to
 * tell: the payout destination token is the same token we debit the business through, or
 * the account's last four digits match a linked account and the account holder is the
 * business itself. Last four digits alone match by chance too often to act on.
 */
export function landlordIsApplicant(
  lease: {
    landlordPayoutToken: string;
    landlordAccountNumberLast4: string;
    landlordAccountHolderName: string;
  },
  bankLinks: ReadonlyArray<{ providerAccountToken: string; accountMask: string }>,
  business: { legalName: string; dba?: string | null },
): boolean {
  if (bankLinks.some((l) => l.providerAccountToken === lease.landlordPayoutToken)) return true;
  const holder = normalize(lease.landlordAccountHolderName);
  const names = [business.legalName, business.dba ?? ''].map(normalize).filter((n) => n !== '');
  return (
    names.includes(holder) &&
    bankLinks.some((l) => l.accountMask === lease.landlordAccountNumberLast4)
  );
}

export function checkContext(context: IntegrityContext | null | undefined): IntegrityFlag[] {
  if (!context) return [];
  const flags: IntegrityFlag[] = [];
  if (context.landlordAccountIsApplicantAccount) {
    flags.push(
      flag(
        'LANDLORD_IS_APPLICANT_ACCOUNT',
        "The landlord payout account on a lease is one of the business's own linked accounts.",
        {},
      ),
    );
  }
  const landlord = context.otherBusinessesWithSameLandlordAccount ?? 0;
  if (landlord > 0) {
    flags.push(
      flag(
        'DUPLICATE_LANDLORD_ACCOUNT',
        `${landlord} other business${landlord === 1 ? '' : 'es'} under different users pay the same landlord account.`,
        { otherBusinesses: landlord },
      ),
    );
  }
  const bank = context.otherBusinessesWithSameBankAccount ?? 0;
  if (bank > 0) {
    flags.push(
      flag(
        'DUPLICATE_BANK_ACCOUNT',
        `The linked bank account is also linked to ${bank} business${bank === 1 ? '' : 'es'} under other users.`,
        { otherBusinesses: bank },
      ),
    );
  }
  const identity = context.otherBusinessesWithSameIdentity ?? 0;
  if (identity > 0) {
    flags.push(
      flag(
        'DUPLICATE_BUSINESS_IDENTITY',
        `${identity} other user${identity === 1 ? ' has' : 's have'} a business with the same legal name and address.`,
        { otherBusinesses: identity },
      ),
    );
  }
  const facts = context.identity;
  if (facts) {
    const reasons = facts.verificationReasons.join(', ') || 'no reason given';
    if (facts.verification === 'FAILED') {
      flags.push(
        flag(
          'IDENTITY_VERIFICATION_FAILED',
          `Identity verification failed for the business or an owner: ${reasons}.`,
          {},
        ),
      );
    } else if (facts.verification !== 'VERIFIED') {
      flags.push(
        flag(
          'IDENTITY_NOT_VERIFIED',
          facts.verification === 'REVIEW'
            ? `Identity verification needs review: ${reasons}.`
            : `The business has not been through identity verification: ${reasons}.`,
          {},
        ),
      );
    }
    if (facts.screening !== 'CLEAR') {
      flags.push(
        flag(
          facts.screening === 'MATCH' ? 'SCREENING_MATCH' : 'SCREENING_POSSIBLE_MATCH',
          `${facts.openHits} part${facts.openHits === 1 ? 'y has' : 'ies have'} an open sanctions or watchlist hit. Clear or confirm it in the screening queue before deciding.`,
          { openHits: facts.openHits },
        ),
      );
    }
  }
  return flags;
}

/** Run every check. `roundTrips` may be passed in when the caller has already found them. */
export function runIntegrityChecks(
  input: IntegrityInput,
  policy: IntegrityPolicy,
  roundTrips?: readonly RoundTripMatch[],
): IntegrityFlag[] {
  const checks: Array<IntegrityFlag | null> = [
    input.checkStatedRevenue === false ? null : checkStatedRevenue(input, policy),
    checkDepositMatch(input, policy),
    checkRoundTrips(input, policy, roundTrips),
    checkNonSalesCredits(input, policy),
    checkOwnerTopUps(input, policy),
    checkRevenueSpike(input, policy),
    checkAccountHistory(input, policy),
    checkObservedRent(input, policy),
  ];
  return [...checks.filter((f): f is IntegrityFlag => f !== null), ...checkContext(input.context)];
}

export function flagsWithAction(
  flags: readonly IntegrityFlag[],
  action: IntegrityAction,
): IntegrityFlag[] {
  return flags.filter((f) => f.action === action);
}

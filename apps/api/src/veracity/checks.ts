import type {
  BankTransaction,
  ConnectionKind,
  IsoDate,
  SettlementReconciliation,
  VeracityFinding,
} from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS, addDays, daysBetween } from '@cashflow/shared';

import { diffBankHistory, diffSalesHistory, type HistoryDiff } from './consistency.ts';
import { holderIsApplicant, matchBusinessName } from './names.ts';
import { cardNetCents } from './reconcile.ts';
import { VERACITY_RULES, type VeracityCode } from './rules.ts';
import type {
  ApplicantFacts,
  BankSourceFacts,
  CommerceSourceFacts,
  VeracityPolicy,
} from './types.ts';

/**
 * The veracity checks. Each is a pure function over facts the service (or the evals) gathered
 * and returns findings; what a finding does is fixed in `rules.ts`.
 */

type Evidence = VeracityFinding['evidence'];

export function finding(
  code: VeracityCode,
  source: ConnectionKind,
  connectionId: string | null,
  detail: string,
  evidence: Evidence = {},
): VeracityFinding {
  const rule = VERACITY_RULES[code];
  return {
    code,
    check: rule.check,
    severity: rule.severity,
    consequence: rule.consequence,
    excludesSource: rule.excludesSource,
    source,
    connectionId,
    detail,
    evidence,
    customerMessage: rule.customerMessage,
    customerAction: rule.customerAction,
  };
}

const bps = (n: number, d: number) => (d === 0 ? 0 : Math.round((n * 10_000) / d));
const pct = (b: number) => `${Math.round(b / 100)}%`;
const REVENUE_IN = new Set(['CARD_SETTLEMENT', 'CASH_DEPOSIT', 'INVOICE_PAYMENT', 'OTHER_INCOME']);
const monthsBetween = (from: IsoDate, to: IsoDate) => Math.floor(daysBetween(from, to) / 30.44);

// ---------- Ownership ----------

export interface OwnershipResult {
  findings: VeracityFinding[];
  bankMismatch: Map<BankSourceFacts, boolean>;
  platformMismatch: Map<CommerceSourceFacts, boolean>;
}

/** Bank holder: the business or a listed owner. A personal account in an owner's name informs. */
export function checkBankOwnership(
  bank: BankSourceFacts,
  applicant: ApplicantFacts,
  policy: VeracityPolicy,
): { finding: VeracityFinding | null; mismatch: boolean } {
  if (bank.ownerNames.length === 0) return { finding: null, mismatch: false };
  const results = bank.ownerNames.map((n) => ({
    name: n,
    ...holderIsApplicant(n, applicant, policy.nameMatchThreshold),
  }));
  const hit = results.find((r) => r.matched);
  if (!hit) {
    return {
      mismatch: true,
      finding: finding(
        'BANK_OWNER_MISMATCH',
        'BANK',
        bank.connectionId,
        `The bank reports the account holder as ${bank.ownerNames.join(', ')}; the business is ${applicant.legalName}${applicant.dba ? ` (${applicant.dba})` : ''} and its owners are ${applicant.ownerNames.join(', ') || 'not listed'}.`,
        {
          holders: bank.ownerNames.join('; '),
          bestBusinessScore: Math.max(...results.map((r) => r.score)),
          accountType: bank.accountType,
        },
      ),
    };
  }
  if (bank.accountType === 'PERSONAL') {
    return {
      mismatch: false,
      finding: finding(
        'PERSONAL_ACCOUNT',
        'BANK',
        bank.connectionId,
        `A personal account in the name of ${hit.name}, a listed owner.`,
        { holder: hit.name, matchedAs: hit.as },
      ),
    };
  }
  return { finding: null, mismatch: false };
}

/** Platform legal name and tax id against the business. */
export function checkPlatformOwnership(
  source: CommerceSourceFacts,
  applicant: ApplicantFacts,
  policy: VeracityPolicy,
): { findings: VeracityFinding[]; mismatch: boolean } {
  const findings: VeracityFinding[] = [];
  let mismatch = false;
  const label = COMMERCE_PLATFORM_LABELS[source.platform];
  if (source.legalName) {
    const m = matchBusinessName(
      source.legalName,
      [applicant.legalName, applicant.dba],
      policy.nameMatchThreshold,
    );
    // A sole proprietor's platform account is often in the owner's own name.
    const owner = !m.matched
      ? holderIsApplicant(source.legalName, applicant, policy.nameMatchThreshold).as === 'OWNER'
      : false;
    if (!m.matched && !owner) {
      mismatch = true;
      findings.push(
        finding(
          'PLATFORM_NAME_MISMATCH',
          'COMMERCE',
          source.connectionId,
          `${label} reports the account's legal name as "${source.legalName}"; the business is "${applicant.legalName}"${applicant.dba ? ` trading as "${applicant.dba}"` : ''}.`,
          { platformName: source.legalName, score: m.score, threshold: policy.nameMatchThreshold },
        ),
      );
    }
  }
  if (source.taxIdLast4 && applicant.taxIdLast4 && source.taxIdLast4 !== applicant.taxIdLast4) {
    findings.push(
      finding(
        'PLATFORM_TAX_ID_MISMATCH',
        'COMMERCE',
        source.connectionId,
        `${label} reports a tax id ending ${source.taxIdLast4}; the business gave one ending ${applicant.taxIdLast4}.`,
        { platformTaxIdLast4: source.taxIdLast4, applicantTaxIdLast4: applicant.taxIdLast4 },
      ),
    );
  }
  return { findings, mismatch };
}

// ---------- Payout destination ----------

export function checkPayoutDestination(
  source: CommerceSourceFacts,
  linkedMasks: ReadonlySet<string>,
  reconciliation: SettlementReconciliation | null,
  policy: VeracityPolicy,
): VeracityFinding | null {
  const label = COMMERCE_PLATFORM_LABELS[source.platform];
  const known = source.payoutDestinations.filter((d) => d.mask !== null);
  const destinationsUnlinked = known.length > 0 && known.every((d) => !linkedMasks.has(d.mask!));
  const r = reconciliation;
  const total = r ? r.payoutsAmountCents + r.unlinkedAmountCents : 0;
  const unlinkedShare = r ? bps(r.unlinkedAmountCents, total) : 0;
  const evidence = {
    destinations: known.map((d) => `${d.institutionName ?? 'bank'} ...${d.mask}`).join('; '),
    linkedMasks: [...linkedMasks].join('; '),
    unlinkedShareBps: unlinkedShare,
    unlinkedPayouts: r?.unlinkedPayouts ?? 0,
  };
  if (
    (destinationsUnlinked && (!r || r.payoutsConsidered === 0)) ||
    (r && total > 0 && unlinkedShare >= 10_000)
  ) {
    return finding(
      'PAYOUT_ACCOUNT_NOT_CONNECTED',
      'COMMERCE',
      source.connectionId,
      `${label} pays out to ${evidence.destinations || 'an account'} that is not among the connected accounts.`,
      evidence,
    );
  }
  if (r && total > 0 && unlinkedShare >= policy.reconciliation.unseenPayoutShareBps) {
    return finding(
      'PAYOUTS_PARTLY_TO_UNSEEN_ACCOUNT',
      'COMMERCE',
      source.connectionId,
      `${pct(unlinkedShare)} of ${label} payouts by amount went to an account that is not connected.`,
      evidence,
    );
  }
  return null;
}

// ---------- Settlement and platform completeness ----------

export function checkSettlement(
  source: CommerceSourceFacts,
  r: SettlementReconciliation,
  policy: VeracityPolicy,
): VeracityFinding[] {
  const p = policy.reconciliation;
  const label = COMMERCE_PLATFORM_LABELS[source.platform];
  const out: VeracityFinding[] = [];
  const evidence = {
    payoutsConsidered: r.payoutsConsidered,
    matchedCount: r.matchedCount,
    matchedShareByCountBps: r.matchedShareByCountBps,
    matchedShareByAmountBps: r.matchedShareByAmountBps,
    payoutsAmountCents: r.payoutsAmountCents,
    matchedAmountCents: r.matchedAmountCents,
  };
  if (r.payoutsConsidered >= p.minPayouts && r.matchedShareByAmountBps !== null) {
    if (r.matchedShareByAmountBps < p.referBelowBps) {
      out.push(
        finding(
          'SETTLEMENT_UNMATCHED',
          'COMMERCE',
          source.connectionId,
          `${pct(r.matchedShareByAmountBps)} of ${label} payouts by amount (${r.matchedCount} of ${r.payoutsConsidered}) were found among deposits in the connected accounts.`,
          evidence,
        ),
      );
    } else if (r.matchedShareByAmountBps < p.excludeBelowBps) {
      out.push(
        finding(
          'SETTLEMENT_LOW_MATCH',
          'COMMERCE',
          source.connectionId,
          `${pct(r.matchedShareByAmountBps)} of ${label} payouts by amount were found among deposits: below the ${pct(p.excludeBelowBps)} needed to use platform sales as revenue.`,
          evidence,
        ),
      );
    }
  }
  const claimedTotal = r.claimedUnmatchedDeposits + r.matchedCount;
  if (
    r.claimedUnmatchedDeposits >= p.claimedUnmatchedMinCount &&
    bps(r.claimedUnmatchedDeposits, claimedTotal) >= p.claimedUnmatchedShareBps
  ) {
    out.push(
      finding(
        'DEPOSITS_WITHOUT_PAYOUT',
        'COMMERCE',
        source.connectionId,
        `${r.claimedUnmatchedDeposits} deposits naming ${label} match no payout ${label} reports.`,
        {
          claimedUnmatchedDeposits: r.claimedUnmatchedDeposits,
          claimedUnmatchedAmountCents: r.claimedUnmatchedAmountCents,
        },
      ),
    );
  }
  if (r.payoutToCardSalesBps !== null && r.payoutToCardSalesBps < p.minPayoutToCardSalesBps) {
    out.push(
      finding(
        'SALES_NOT_PAID_OUT',
        'COMMERCE',
        source.connectionId,
        `${label} paid out ${pct(r.payoutToCardSalesBps)} of the card sales it reports over the same days.`,
        { payoutToCardSalesBps: r.payoutToCardSalesBps },
      ),
    );
  }
  return out;
}

/** Without payout data: platform card sales against bank revenue. */
export function checkPosRevenueInBank(
  source: CommerceSourceFacts,
  deposits: readonly BankTransaction[],
  asOf: IsoDate,
  policy: VeracityPolicy,
): VeracityFinding | null {
  const pull = source.current;
  if (!pull || pull.payouts.length > 0) return null;
  const from = addDays(asOf, -89);
  const card = pull.dailySales
    .filter((d) => d.date >= from)
    .reduce((s, d) => s + cardNetCents(d), 0);
  if (card <= 0) return null;
  const bank = deposits
    .filter(
      (t) => !t.pending && t.amountCents > 0 && t.date >= from && t.category === 'CARD_SETTLEMENT',
    )
    .reduce((s, t) => s + t.amountCents, 0);
  const share = bps(bank, card);
  if (share >= policy.completeness.minBankToCardSalesBps) return null;
  return finding(
    'POS_REVENUE_NOT_IN_BANK',
    'COMMERCE',
    source.connectionId,
    `Card settlements in the connected accounts are ${pct(share)} of the card sales ${COMMERCE_PLATFORM_LABELS[source.platform]} reports.`,
    { bankToCardSalesBps: share },
  );
}

// ---------- Bank completeness ----------

export function checkBankCompleteness(
  primary: BankSourceFacts,
  banks: readonly BankSourceFacts[],
  asOf: IsoDate,
  policy: VeracityPolicy,
): VeracityFinding[] {
  const out: VeracityFinding[] = [];
  const shared = new Set(banks.map((b) => b.accountMask));
  const unshared = banks
    .flatMap((b) => b.visibleAccounts)
    .filter((a) => !a.shared && !shared.has(a.mask));
  if (unshared.length > 0) {
    out.push(
      finding(
        'UNSHARED_ACCOUNTS',
        'BANK',
        primary.connectionId,
        `${unshared.length} other account${unshared.length === 1 ? ' is' : 's are'} visible on the same login and not shared: ${unshared.map((a) => `${a.name} ...${a.mask}`).join(', ')}.`,
        { unshared: unshared.length },
      ),
    );
  }
  const txs = primary.current?.transactions ?? [];
  const from = addDays(asOf, -89);
  const recent = txs.filter((t) => !t.pending && t.date >= from && t.date <= asOf);
  const revenue = recent
    .filter((t) => t.amountCents > 0 && REVENUE_IN.has(t.category))
    .reduce((s, t) => s + t.amountCents, 0);
  const toSeen = (t: BankTransaction) => [...shared].some((m) => t.description.includes(m));
  const windows = policy.completeness.unseenTransferWindows;
  const measure = (category: 'TRANSFER_OUT' | 'TRANSFER_IN') => {
    const list = recent.filter((t) => t.category === category && !toSeen(t));
    const total = list.reduce((s, t) => s + Math.abs(t.amountCents), 0);
    let covered = 0;
    for (let w = 0; w < windows; w++) {
      const end = addDays(asOf, -30 * w);
      const start = addDays(end, -29);
      if (list.some((t) => t.date >= start && t.date <= end)) covered++;
    }
    return {
      total,
      count: list.length,
      sustained: covered === windows,
      shareBps: bps(total, revenue),
    };
  };
  const out90 = measure('TRANSFER_OUT');
  if (
    out90.sustained &&
    revenue > 0 &&
    out90.shareBps >= policy.completeness.unseenTransferShareBps
  ) {
    out.push(
      finding(
        'TRANSFERS_TO_UNSEEN_ACCOUNTS',
        'BANK',
        primary.connectionId,
        `Transfers out to accounts that are not connected came to ${pct(out90.shareBps)} of revenue over 90 days, in every month.`,
        {
          transfersOutCents: out90.total,
          count: out90.count,
          shareBps: out90.shareBps,
          unsharedVisible: unshared.length,
        },
      ),
    );
  }
  const in90 = measure('TRANSFER_IN');
  if (
    in90.sustained &&
    revenue > 0 &&
    in90.shareBps >= policy.completeness.unseenTransferShareBps
  ) {
    out.push(
      finding(
        'TRANSFERS_FROM_UNSEEN_ACCOUNTS',
        'BANK',
        primary.connectionId,
        `Transfers in from accounts that are not connected came to ${pct(in90.shareBps)} of revenue over 90 days.`,
        { transfersInCents: in90.total, shareBps: in90.shareBps },
      ),
    );
  }
  return out;
}

// ---------- Consistency ----------

function consistencyFinding(
  diff: HistoryDiff,
  kind: ConnectionKind,
  connectionId: string | null,
  priorPulledOn: IsoDate,
): VeracityFinding | null {
  if (diff.changedItems === 0) return null;
  const evidence = {
    comparedWithPullOn: priorPulledOn,
    overlapFrom: diff.overlapFrom,
    overlapTo: diff.overlapTo,
    removed: diff.removed,
    added: diff.added,
    altered: diff.altered,
    changedAmountCents: diff.changedAmountCents,
    changedShareBps: diff.changedShareBps,
    flatteringCents: diff.flatteringCents,
  };
  const what = `${diff.changedItems} item${diff.changedItems === 1 ? '' : 's'} between ${diff.overlapFrom} and ${diff.overlapTo} differ from the pull on ${priorPulledOn} (${diff.removed} removed, ${diff.added} added, ${diff.altered} altered).`;
  if (!diff.material) return finding('HISTORY_MINOR_CHANGES', kind, connectionId, what, evidence);
  if (kind === 'COMMERCE')
    return finding('SALES_HISTORY_CHANGED', kind, connectionId, what, evidence);
  // Knocked out only when final debits disappeared and nothing was added in their place:
  // an aggregator re-sync can duplicate items (an addition), but it does not remove a
  // posted overdraft fee or loan payment from a closed period.
  const removedDebitsOnly = diff.removed >= 1 && diff.added === 0 && diff.flatteringCents > 0;
  return finding(
    removedDebitsOnly ? 'HISTORY_REWRITTEN' : 'HISTORY_CHANGED',
    kind,
    connectionId,
    what,
    evidence,
  );
}

export function checkBankConsistency(
  bank: BankSourceFacts,
  policy: VeracityPolicy,
): VeracityFinding | null {
  if (!bank.current) return null;
  for (const prior of bank.prior) {
    const diff = diffBankHistory(bank.current, prior, policy.consistency);
    if (diff) return consistencyFinding(diff, 'BANK', bank.connectionId, prior.pulledOn);
  }
  return null;
}

export function checkSalesConsistency(
  source: CommerceSourceFacts,
  policy: VeracityPolicy,
): VeracityFinding | null {
  if (!source.current) return null;
  for (const prior of source.prior) {
    const diff = diffSalesHistory(source.current, prior, policy.consistency);
    if (diff) return consistencyFinding(diff, 'COMMERCE', source.connectionId, prior.pulledOn);
  }
  return null;
}

// ---------- Account age and continuity ----------

export function checkBankAge(
  bank: BankSourceFacts,
  applicant: ApplicantFacts,
  asOf: IsoDate,
  policy: VeracityPolicy,
): VeracityFinding[] {
  const out: VeracityFinding[] = [];
  const a = policy.age;
  if (
    bank.openedOn &&
    monthsBetween(bank.openedOn, asOf) < a.recentAccountMonths &&
    applicant.timeInBusinessMonths >= a.establishedBankMonths
  ) {
    out.push(
      finding(
        'BANK_ACCOUNT_RECENT',
        'BANK',
        bank.connectionId,
        `The account was opened ${bank.openedOn}; the business reports ${applicant.timeInBusinessMonths} months of trading.`,
        { openedOn: bank.openedOn, timeInBusinessMonths: applicant.timeInBusinessMonths },
      ),
    );
  }
  const dates = [
    ...new Set((bank.current?.transactions ?? []).filter((t) => !t.pending).map((t) => t.date)),
  ].sort();
  let longest = 0;
  let at: IsoDate | null = null;
  for (let i = 1; i < dates.length; i++) {
    const gap = daysBetween(dates[i - 1]!, dates[i]!);
    if (gap > longest) {
      longest = gap;
      at = dates[i - 1]!;
    }
  }
  if (longest >= a.gapDays) {
    out.push(
      finding(
        'DATA_GAP',
        'BANK',
        bank.connectionId,
        `No transactions for ${longest} days from ${at}.`,
        {
          gapDays: longest,
          from: at,
        },
      ),
    );
  }
  return out;
}

export function checkPlatformAge(
  source: CommerceSourceFacts,
  primaryBank: BankSourceFacts | null,
  applicant: ApplicantFacts,
  asOf: IsoDate,
  policy: VeracityPolicy,
): VeracityFinding | null {
  const a = policy.age;
  const created = source.accountCreatedOn;
  if (!created) return null;
  if (monthsBetween(created, asOf) >= a.recentAccountMonths) return null;
  if (applicant.timeInBusinessMonths < a.establishedPlatformMonths) return null;
  const label = COMMERCE_PLATFORM_LABELS[source.platform];
  // Did bank revenue jump when the platform account opened?
  const txs = primaryBank?.current?.transactions ?? [];
  const span = daysBetween(created, asOf) + 1;
  const before = addDays(created, -span);
  const first = txs.reduce<IsoDate | null>((m, t) => (m === null || t.date < m ? t.date : m), null);
  if (span >= 21 && first !== null && first <= before) {
    const sum = (from: IsoDate, to: IsoDate) =>
      txs
        .filter(
          (t) =>
            !t.pending &&
            t.amountCents > 0 &&
            REVENUE_IN.has(t.category) &&
            t.date >= from &&
            t.date <= to,
        )
        .reduce((s, t) => s + t.amountCents, 0);
    const after = sum(created, asOf);
    const prior = sum(before, addDays(created, -1));
    const change = bps(after - prior, prior);
    if (prior > 0 && change >= a.surgeBps) {
      return finding(
        'PLATFORM_NEW_WITH_SURGE',
        'COMMERCE',
        source.connectionId,
        `The ${label} account opened ${created}, and bank revenue since then is ${pct(change)} above the same span before it.`,
        { accountCreatedOn: created, revenueChangeBps: change, spanDays: span },
      );
    }
  }
  return finding(
    'PLATFORM_ACCOUNT_RECENT',
    'COMMERCE',
    source.connectionId,
    `The ${label} account was created ${created}; the business reports ${applicant.timeInBusinessMonths} months of trading.`,
    { accountCreatedOn: created, timeInBusinessMonths: applicant.timeInBusinessMonths },
  );
}

// ---------- Freshness ----------

export function checkBankFreshness(
  bank: BankSourceFacts,
  asOf: IsoDate,
  policy: VeracityPolicy,
): VeracityFinding | null {
  const f = policy.freshness;
  const pull = bank.current;
  if (!pull) {
    return finding(
      'BANK_DATA_UNAVAILABLE',
      'BANK',
      bank.connectionId,
      `The bank could not be pulled at decision time: ${bank.pullError ?? 'no pull on record'}.`,
      { health: bank.health, error: bank.pullError },
    );
  }
  const age = daysBetween(pull.pulledOn, asOf);
  if (age > f.maxSnapshotAgeDays) {
    return finding(
      'BANK_DATA_UNAVAILABLE',
      'BANK',
      bank.connectionId,
      `The newest pull is from ${pull.pulledOn}, ${age} days before the decision, and a fresh one was not available.`,
      { pulledOn: pull.pulledOn, ageDays: age },
    );
  }
  const newest = pull.transactions.reduce<IsoDate | null>(
    (m, t) => (m === null || t.date > m ? t.date : m),
    null,
  );
  if (newest !== null && daysBetween(newest, asOf) > f.maxDataAgeDays) {
    return finding(
      'BANK_DATA_UNAVAILABLE',
      'BANK',
      bank.connectionId,
      `The newest transaction is from ${newest}: the feed has not caught up.`,
      { newestTransaction: newest, dataAgeDays: daysBetween(newest, asOf) },
    );
  }
  return null;
}

export function checkPlatformFreshness(
  source: CommerceSourceFacts,
  asOf: IsoDate,
  policy: VeracityPolicy,
): VeracityFinding | null {
  const pull = source.current;
  const label = COMMERCE_PLATFORM_LABELS[source.platform];
  if (!pull) {
    return finding(
      'PLATFORM_DATA_UNAVAILABLE',
      'COMMERCE',
      source.connectionId,
      `${label} could not be pulled at decision time: ${source.pullError ?? 'no pull on record'}.`,
      { health: source.health, error: source.pullError },
    );
  }
  const age = daysBetween(pull.pulledOn, asOf);
  if (age > policy.freshness.maxSnapshotAgeDays) {
    return finding(
      'PLATFORM_DATA_UNAVAILABLE',
      'COMMERCE',
      source.connectionId,
      `The newest ${label} pull is from ${pull.pulledOn}, ${age} days before the decision.`,
      { pulledOn: pull.pulledOn, ageDays: age },
    );
  }
  return null;
}

// ---------- Method ----------

export function checkBankMethod(bank: BankSourceFacts): VeracityFinding | null {
  if (bank.institutionAuthorized !== false) return null;
  return finding(
    'LEGACY_BANK_CONNECTION',
    'BANK',
    bank.connectionId,
    `${bank.institutionName} was connected through a legacy aggregator connection, not the bank's own OAuth.`,
    { institution: bank.institutionName },
  );
}

export function checkPlatformMethod(source: CommerceSourceFacts): VeracityFinding | null {
  if (source.accessMethod !== 'DELEGATED_SEAT') return null;
  return finding(
    'DELEGATED_SEAT_SOURCE',
    'COMMERCE',
    source.connectionId,
    `${COMMERCE_PLATFORM_LABELS[source.platform]} is read through CashFlow's read-only seat on the account.`,
    {},
  );
}

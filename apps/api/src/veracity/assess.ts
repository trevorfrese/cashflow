import type {
  BankTransaction,
  SettlementReconciliation,
  SnapshotRef,
  SourceAssessment,
  TrustTier,
  VeracityAssessment,
  VeracityConsequence,
  VeracityFinding,
  VeracityOutcome,
} from '@cashflow/shared';
import { COMMERCE_PLATFORM_LABELS } from '@cashflow/shared';

import {
  checkBankAge,
  checkBankCompleteness,
  checkBankConsistency,
  checkBankFreshness,
  checkBankMethod,
  checkBankOwnership,
  checkPayoutDestination,
  checkPlatformAge,
  checkPlatformFreshness,
  checkPlatformMethod,
  checkPlatformOwnership,
  checkPosRevenueInBank,
  checkSalesConsistency,
  checkSettlement,
  finding,
} from './checks.ts';
import { reconcileSettlements } from './reconcile.ts';
import { CONSEQUENCE_ORDER } from './rules.ts';
import type {
  BankSourceFacts,
  CommerceSourceFacts,
  VeracityInput,
  VeracityPolicy,
} from './types.ts';

/**
 * The veracity assessment: every check over every source, one finding list, a trust tier per
 * source, and the overall consequence. Pure: the same facts and policy give the same answer.
 */

const RANK: Record<VeracityConsequence, number> = Object.fromEntries(
  CONSEQUENCE_ORDER.map((c, i) => [c, CONSEQUENCE_ORDER.length - i]),
) as Record<VeracityConsequence, number>;

const OUTCOME_FOR: Record<VeracityConsequence, VeracityOutcome> = {
  KNOCKOUT: 'KNOCKOUT',
  NEEDS_INFO: 'NEEDS_INFO',
  REFER: 'REFER',
  CAP: 'CAP',
  EXCLUDE_SOURCE: 'EXCLUDE_SOURCE',
  REDUCE_DEPTH: 'REDUCE_DEPTH',
  INFORM: 'INFORM',
};

const TIER_RANK: Record<TrustTier, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export function bankMethodTier(bank: Pick<BankSourceFacts, 'institutionAuthorized'>): TrustTier {
  return bank.institutionAuthorized === true ? 'HIGH' : 'MEDIUM';
}

export function platformMethodTier(source: Pick<CommerceSourceFacts, 'accessMethod'>): TrustTier {
  return source.accessMethod === 'DIRECT_OAUTH' ? 'HIGH' : 'MEDIUM';
}

export function assessVeracity(input: VeracityInput, policy: VeracityPolicy): VeracityAssessment {
  const { asOf, applicant } = input;
  const findings: VeracityFinding[] = [];
  const reconciliation: SettlementReconciliation[] = [];
  const banks = input.banks;
  const primaryBank = banks.find((b) => b.primary) ?? banks[0] ?? null;
  const linkedMasks = new Set(banks.map((b) => b.accountMask));
  const deposits: BankTransaction[] = banks.flatMap((b) => b.current?.transactions ?? []);

  // Banks.
  const bankMismatch = new Set<BankSourceFacts>();
  for (const bank of banks) {
    const fresh = checkBankFreshness(bank, asOf, policy);
    if (fresh && bank === primaryBank) findings.push(fresh);
    const own = checkBankOwnership(bank, applicant, policy);
    if (own.mismatch) bankMismatch.add(bank);
    if (own.finding) findings.push(own.finding);
    const method = checkBankMethod(bank);
    if (method) findings.push(method);
    if (bank === primaryBank) {
      findings.push(...checkBankAge(bank, applicant, asOf, policy));
      const consistency = checkBankConsistency(bank, policy);
      if (consistency) findings.push(consistency);
    }
  }
  if (primaryBank) findings.push(...checkBankCompleteness(primaryBank, banks, asOf, policy));

  // Platforms.
  const platformMismatch = new Set<CommerceSourceFacts>();
  for (const source of input.commerce) {
    const fresh = checkPlatformFreshness(source, asOf, policy);
    if (fresh) {
      findings.push(fresh);
      continue;
    }
    const own = checkPlatformOwnership(source, applicant, policy);
    if (own.mismatch) platformMismatch.add(source);
    findings.push(...own.findings);
    const method = checkPlatformMethod(source);
    if (method) findings.push(method);
    const pull = source.current!;
    let r: SettlementReconciliation | null = null;
    if (pull.payouts.length > 0) {
      r = reconcileSettlements(
        {
          asOf,
          platform: source.platform,
          connectionId: source.connectionId,
          payouts: pull.payouts,
          deposits,
          linkedMasks,
          dailySales: pull.dailySales,
        },
        policy.reconciliation,
      );
      reconciliation.push(r);
    }
    const destination = checkPayoutDestination(source, linkedMasks, r, policy);
    if (destination) findings.push(destination);
    if (r) findings.push(...checkSettlement(source, r, policy));
    else {
      const pos = checkPosRevenueInBank(source, deposits, asOf, policy);
      if (pos) findings.push(pos);
    }
    const age = checkPlatformAge(source, primaryBank, applicant, asOf, policy);
    if (age) findings.push(age);
    const consistency = checkSalesConsistency(source, policy);
    if (consistency) findings.push(consistency);
  }

  // Two independent sources that both say the data belongs to another business.
  const otherBusinessBank = [...bankMismatch].find((b) => b.accountType !== 'PERSONAL');
  if (otherBusinessBank && platformMismatch.size > 0) {
    const platform = [...platformMismatch][0]!;
    findings.push(
      finding(
        'BOTH_SOURCES_OTHER_BUSINESS',
        'BANK',
        otherBusinessBank.connectionId,
        `The bank reports the account holder as ${otherBusinessBank.ownerNames.join(', ')} and ${COMMERCE_PLATFORM_LABELS[platform.platform]} names ${platform.legalName}; the business is ${applicant.legalName}.`,
        {
          bankHolders: otherBusinessBank.ownerNames.join('; '),
          platformName: platform.legalName,
        },
      ),
    );
  }

  // Per source tiers and use.
  const sources: SourceAssessment[] = [];
  const severe = (f: VeracityFinding) =>
    f.consequence === 'KNOCKOUT' || f.consequence === 'REFER' || f.excludesSource;
  for (const bank of banks) {
    const own = findings.filter((f) => f.source === 'BANK' && f.connectionId === bank.connectionId);
    const methodTier = bankMethodTier(bank);
    const available = bank.current !== null && !own.some((f) => f.code === 'BANK_DATA_UNAVAILABLE');
    sources.push({
      connectionId: bank.connectionId,
      kind: 'BANK',
      label: `${bank.institutionName} ...${bank.accountMask}`,
      accessMethod: 'AGGREGATOR',
      methodTier,
      trustTier: !available ? 'NONE' : own.some(severe) ? 'LOW' : methodTier,
      usableForRevenue: available,
      independentlyVerified: false,
      findingCodes: own.map((f) => f.code),
    });
  }
  const p = policy.reconciliation;
  for (const source of input.commerce) {
    const own = findings.filter(
      (f) => f.source === 'COMMERCE' && f.connectionId === source.connectionId,
    );
    const methodTier = platformMethodTier(source);
    const available =
      source.current !== null && !own.some((f) => f.code === 'PLATFORM_DATA_UNAVAILABLE');
    const usable = available && !own.some((f) => f.excludesSource);
    const r = reconciliation.find((x) => x.connectionId === source.connectionId) ?? null;
    const reconciled =
      r !== null &&
      r.payoutsConsidered >= p.minPayouts &&
      (r.matchedShareByAmountBps ?? 0) >= p.excludeBelowBps;
    sources.push({
      connectionId: source.connectionId,
      kind: 'COMMERCE',
      label: COMMERCE_PLATFORM_LABELS[source.platform],
      accessMethod: source.accessMethod,
      methodTier,
      trustTier: !available ? 'NONE' : own.some(severe) ? 'LOW' : methodTier,
      usableForRevenue: usable,
      independentlyVerified:
        usable && reconciled && !own.some((f) => f.consequence === 'REDUCE_DEPTH'),
      findingCodes: own.map((f) => f.code),
    });
  }
  // A platform that reconciles corroborates the bank it pays into, and the bank the platform.
  if (sources.some((s) => s.kind === 'COMMERCE' && s.independentlyVerified)) {
    for (const s of sources) {
      if (s.kind === 'BANK' && s.usableForRevenue && s.trustTier !== 'LOW') {
        s.independentlyVerified = true;
      }
    }
  }

  const snapshots: SnapshotRef[] = [];
  for (const b of banks) {
    if (b.current?.snapshotId && b.connectionId && b.current.contentHash) {
      snapshots.push({
        id: b.current.snapshotId,
        connectionId: b.connectionId,
        kind: 'BANK',
        contentHash: b.current.contentHash,
        pulledAt: b.current.pulledAt,
      });
    }
  }
  for (const c of input.commerce) {
    if (c.current?.snapshotId && c.connectionId && c.current.contentHash) {
      snapshots.push({
        id: c.current.snapshotId,
        connectionId: c.connectionId,
        kind: 'COMMERCE',
        contentHash: c.current.contentHash,
        pulledAt: c.current.pulledAt,
      });
    }
  }

  const worst = findings.reduce<VeracityConsequence | null>(
    (w, f) => (w === null || RANK[f.consequence] > RANK[w] ? f.consequence : w),
    null,
  );
  const usable = sources.filter((s) => s.usableForRevenue);
  const tier = usable.reduce<TrustTier>(
    (best, s) => (TIER_RANK[s.trustTier] > TIER_RANK[best] ? s.trustTier : best),
    'NONE',
  );
  return {
    asOf,
    findings,
    sources,
    reconciliation,
    snapshots,
    overall: {
      outcome: worst === null ? 'CLEAR' : OUTCOME_FOR[worst],
      trustTier: tier,
      independentlyVerifiedSources: sources.filter((s) => s.independentlyVerified).length,
    },
  };
}

/** Findings with a consequence. */
export const findingsWith = (a: VeracityAssessment, c: VeracityConsequence) =>
  a.findings.filter((f) => f.consequence === c);

/** What the scorecard's data depth factor reads from an assessment. */
export interface DepthCredit {
  /** Multiplier on the bank history credit: the primary bank's tier. */
  bankMultiplier: number;
  /** A point of sale counts as a second, independently verified source. */
  verifiedSecondSource: boolean;
  /** The platform's label, for the reason message. */
  secondSourceLabel: string | null;
}

export function depthCredit(a: VeracityAssessment, policy: VeracityPolicy): DepthCredit {
  const bank = a.sources.find((s) => s.kind === 'BANK') ?? null;
  const tier = bank?.trustTier ?? 'NONE';
  const second = a.sources.find((s) => s.kind === 'COMMERCE' && s.independentlyVerified) ?? null;
  // A LOW bank tier comes from a referral or exclusion: those already act. The data depth
  // credit only reflects how the data was obtained, so it reads the method tier there.
  const effective = tier === 'LOW' ? (bank?.methodTier ?? 'MEDIUM') : tier;
  return {
    bankMultiplier: policy.depth.tierMultiplier[effective],
    verifiedSecondSource: second !== null,
    secondSourceLabel: second?.label ?? null,
  };
}

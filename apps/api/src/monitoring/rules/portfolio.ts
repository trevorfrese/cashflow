import { addDays, type AlertSeverity, type IsoDate } from '@cashflow/shared';

import {
  ACTIVE_SERVICING_POLICY,
  daysPastDue,
  delinquencyBucket,
  type DelinquencyBucket,
} from '../../servicing/policy.ts';
import type { AlertCandidate, PlanFact, Rule } from '../types.ts';
import { bps } from './payments.ts';

/**
 * Portfolio rules: is the book behaving the way the credit policy was evaluated to behave.
 *
 * The four that measure credit performance (first payment defaults, delinquent share, roll,
 * loss against expectation) and pool over-commitment trip the circuit breaker at their
 * critical level. Every rate has a minimum sample: one late plan on a book of five is 20%
 * of the book and says nothing.
 */

const pct = (rateBps: number) => `${(rateBps / 100).toFixed(1)}%`;
const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * A plan's outstanding principal and bucket on a date, rebuilt from its installments: what
 * had been fronted by then, was not yet paid, and had not been written off. This is how the
 * roll rule sees last month without a stored snapshot.
 */
export function standingOn(
  plan: PlanFact,
  date: IsoDate,
): { outstandingCents: number; bucket: DelinquencyBucket } {
  let outstandingCents = 0;
  let oldestDue: IsoDate | null = null;
  let chargedOff = false;
  for (const i of plan.installments) {
    if (i.frontedOn === null || i.frontedOn > date) continue;
    if (i.paidOn !== null && i.paidOn <= date) continue;
    if (i.chargedOffOn !== null && i.chargedOffOn <= date) {
      chargedOff = true;
      continue;
    }
    if (i.status === 'VOIDED') continue;
    outstandingCents += i.principalCents;
    if (i.dueDate <= date && (oldestDue === null || i.dueDate < oldestDue)) oldestDue = i.dueDate;
  }
  const days = oldestDue === null ? 0 : daysPastDue(oldestDue, date);
  return { outstandingCents, bucket: delinquencyBucket(ACTIVE_SERVICING_POLICY, days, chargedOff) };
}

const BAD: ReadonlySet<DelinquencyBucket> = new Set(['DELINQUENT', 'DEFAULT', 'CHARGED_OFF']);

function tiered(rateBps: number, warnBps: number, criticalBps: number): AlertSeverity | null {
  if (rateBps >= criticalBps) return 'CRITICAL';
  if (rateBps >= warnBps) return 'WARNING';
  return null;
}

export const firstPaymentDefault: Rule = {
  type: 'portfolio.first_payment_default',
  category: 'PORTFOLIO',
  description:
    'Share of plans in an origination month whose very first installment went 30 days past due, was written off, or was paid that late. The earliest sign that fraud or a bad cohort got through. Critical trips the circuit breaker.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: true,
  evaluate: (inputs, policy) => {
    const p = policy.portfolio;
    const matureBefore = addDays(inputs.asOf, -p.firstPaymentDefaultDays);
    const cohorts = new Map<string, { plans: number; defaults: string[] }>();
    for (const plan of inputs.plans) {
      const first = plan.installments.find((i) => i.first);
      if (!first || plan.originatedOn === null || first.dueDate > matureBefore) continue;
      if (first.status === 'VOIDED') continue;
      const cohort = cohorts.get(plan.originatedOn.slice(0, 7)) ?? { plans: 0, defaults: [] };
      cohort.plans += 1;
      const late = addDays(first.dueDate, p.firstPaymentDefaultDays);
      if (first.chargedOffOn !== null || first.paidOn === null || first.paidOn >= late) {
        cohort.defaults.push(plan.planId);
      }
      cohorts.set(plan.originatedOn.slice(0, 7), cohort);
    }
    const out: AlertCandidate[] = [];
    for (const [month, cohort] of cohorts) {
      if (cohort.plans < p.minPlans) continue;
      const rateBps = bps(cohort.defaults.length, cohort.plans);
      const severity = tiered(
        rateBps,
        p.firstPaymentDefaultWarnBps,
        p.firstPaymentDefaultCriticalBps,
      );
      if (!severity) continue;
      out.push({
        type: 'portfolio.first_payment_default',
        category: 'PORTFOLIO',
        severity,
        subjectType: 'portfolio',
        subjectId: `cohort:${month}`,
        title: `First payment default rate ${pct(rateBps)} for plans originated in ${month}`,
        detail: {
          cohort: month,
          plans: cohort.plans,
          defaults: cohort.defaults.length,
          rateBps,
          warnBps: p.firstPaymentDefaultWarnBps,
          criticalBps: p.firstPaymentDefaultCriticalBps,
          planIds: cohort.defaults.slice(0, 50),
        },
        dedupeKey: `fpd:${month}`,
        tripsBreaker: severity === 'CRITICAL',
      });
    }
    return out;
  },
};

export const delinquentShare: Rule = {
  type: 'portfolio.delinquent_share',
  category: 'PORTFOLIO',
  description:
    'Share of outstanding principal held by plans in the DELINQUENT and DEFAULT buckets, with the balance in every bucket in the detail. Critical trips the circuit breaker.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: true,
  evaluate: (inputs, policy) => {
    const p = policy.portfolio;
    const byBucket: Record<string, { plans: number; principalCents: number }> = {};
    let total = 0;
    let plans = 0;
    for (const plan of inputs.plans) {
      const s = standingOn(plan, inputs.asOf);
      if (s.outstandingCents <= 0) continue;
      plans += 1;
      total += s.outstandingCents;
      const row = (byBucket[s.bucket] ??= { plans: 0, principalCents: 0 });
      row.plans += 1;
      row.principalCents += s.outstandingCents;
    }
    if (plans < p.minPlans || total <= 0) return [];
    const bad =
      (byBucket.DELINQUENT?.principalCents ?? 0) + (byBucket.DEFAULT?.principalCents ?? 0);
    const rateBps = bps(bad, total);
    const severity = tiered(rateBps, p.delinquentShareWarnBps, p.delinquentShareCriticalBps);
    if (!severity) return [];
    return [
      {
        type: 'portfolio.delinquent_share',
        category: 'PORTFOLIO',
        severity,
        subjectType: 'portfolio',
        subjectId: 'delinquency',
        title: `${pct(rateBps)} of outstanding principal is delinquent or in default`,
        detail: {
          plansWithBalance: plans,
          outstandingCents: total,
          delinquentCents: bad,
          rateBps,
          buckets: Object.fromEntries(
            Object.entries(byBucket).map(([bucket, row]) => [
              bucket,
              { ...row, shareBps: bps(row.principalCents, total) },
            ]),
          ),
          warnBps: p.delinquentShareWarnBps,
          criticalBps: p.delinquentShareCriticalBps,
        },
        dedupeKey: 'portfolio.delinquent_share',
        tripsBreaker: severity === 'CRITICAL',
      },
    ];
  },
};

export const delinquencyRoll: Rule = {
  type: 'portfolio.delinquency_roll',
  category: 'PORTFOLIO',
  description:
    'Month over month roll: of the principal that was current or in grace a month ago, the share whose plan is delinquent, in default, or written off today. Critical trips the circuit breaker.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: true,
  evaluate: (inputs, policy) => {
    const p = policy.portfolio;
    const before = addDays(inputs.asOf, -p.rollWindowDays);
    let plans = 0;
    let base = 0;
    let rolled = 0;
    const rolledPlans: string[] = [];
    for (const plan of inputs.plans) {
      const then = standingOn(plan, before);
      if (then.outstandingCents <= 0 || BAD.has(then.bucket)) continue;
      plans += 1;
      base += then.outstandingCents;
      if (BAD.has(standingOn(plan, inputs.asOf).bucket)) {
        rolled += then.outstandingCents;
        rolledPlans.push(plan.planId);
      }
    }
    if (plans < p.minPlans || base <= 0) return [];
    const rateBps = bps(rolled, base);
    const severity = tiered(rateBps, p.rollWarnBps, p.rollCriticalBps);
    if (!severity) return [];
    return [
      {
        type: 'portfolio.delinquency_roll',
        category: 'PORTFOLIO',
        severity,
        subjectType: 'portfolio',
        subjectId: 'delinquency_roll',
        title: `${pct(rateBps)} of last month's current balance has rolled delinquent`,
        detail: {
          from: before,
          to: inputs.asOf,
          plansCurrentThen: plans,
          currentThenCents: base,
          rolledCents: rolled,
          rolledPlans: rolledPlans.length,
          rateBps,
          warnBps: p.rollWarnBps,
          criticalBps: p.rollCriticalBps,
          planIds: rolledPlans.slice(0, 50),
        },
        dedupeKey: 'portfolio.delinquency_roll',
        tripsBreaker: severity === 'CRITICAL',
      },
    ];
  },
};

/** Severity of a share measured against a cap: informational near it, a breach over it. */
function capSeverity(
  shareBps: number,
  capBps: number,
  infoShareBps: number,
  highShareBps: number,
): AlertSeverity | null {
  const ofCap = bps(shareBps, capBps);
  if (ofCap >= highShareBps) return 'HIGH';
  if (shareBps > capBps) return 'WARNING';
  if (ofCap >= infoShareBps) return 'INFO';
  return null;
}

export const industryConcentration: Rule = {
  type: 'portfolio.concentration_industry',
  category: 'PORTFOLIO',
  description:
    'Committed monthly rent in one industry as a share of pool capital, against the industry cap in the credit policy. Informational when approaching the cap, a warning over it.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const p = policy.portfolio;
    const { capitalCents } = inputs.exposure;
    if (capitalCents <= 0) return [];
    const out: AlertCandidate[] = [];
    for (const row of inputs.exposure.byIndustry) {
      const shareBps = bps(row.committedCents, capitalCents);
      const severity = capSeverity(
        shareBps,
        p.maxIndustryShareBps,
        p.concentrationInfoShareBps,
        p.concentrationHighShareBps,
      );
      if (!severity) continue;
      out.push({
        type: 'portfolio.concentration_industry',
        category: 'PORTFOLIO',
        severity,
        subjectType: 'industry',
        subjectId: row.industry,
        title: `${row.industry} holds ${pct(shareBps)} of pool capital (cap ${pct(p.maxIndustryShareBps)})`,
        detail: {
          industry: row.industry,
          committedCents: row.committedCents,
          capitalCents,
          shareBps,
          capBps: p.maxIndustryShareBps,
        },
        dedupeKey: `concentration_industry:${row.industry}`,
      });
    }
    return out;
  },
};

export const singleNameConcentration: Rule = {
  type: 'portfolio.concentration_single_name',
  category: 'PORTFOLIO',
  description:
    'Committed monthly rent of one business as a share of pool capital, against the single name cap in the credit policy. Informational when approaching the cap, a warning over it.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const p = policy.portfolio;
    const { capitalCents } = inputs.exposure;
    if (capitalCents <= 0) return [];
    const out: AlertCandidate[] = [];
    for (const row of inputs.exposure.byBusiness) {
      const shareBps = bps(row.committedCents, capitalCents);
      const severity = capSeverity(
        shareBps,
        p.maxSingleNameShareBps,
        p.concentrationInfoShareBps,
        p.concentrationHighShareBps,
      );
      if (!severity) continue;
      out.push({
        type: 'portfolio.concentration_single_name',
        category: 'PORTFOLIO',
        severity,
        subjectType: 'business',
        subjectId: row.businessId,
        title: `${row.businessName} holds ${pct(shareBps)} of pool capital (cap ${pct(p.maxSingleNameShareBps)})`,
        detail: {
          businessId: row.businessId,
          committedCents: row.committedCents,
          capitalCents,
          shareBps,
          capBps: p.maxSingleNameShareBps,
        },
        dedupeKey: `concentration_single_name:${row.businessId}`,
      });
    }
    return out;
  },
};

export const poolUtilization: Rule = {
  type: 'portfolio.pool_utilization',
  category: 'PORTFOLIO',
  description:
    'Committed monthly rent as a share of pool capital, against the utilization ceiling in the credit policy. Critical, and the circuit breaker trips, when commitments exceed capital.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: true,
  evaluate: (inputs, policy) => {
    const p = policy.portfolio;
    const { capitalCents, committedCents } = inputs.exposure;
    if (committedCents <= 0) return [];
    const utilizationBps =
      capitalCents <= 0 ? Number.MAX_SAFE_INTEGER : bps(committedCents, capitalCents);
    const warnBps = Math.round((p.maxPoolUtilizationBps * p.utilizationWarnShareBps) / 10_000);
    const severity: AlertSeverity | null =
      utilizationBps >= p.utilizationCriticalBps
        ? 'CRITICAL'
        : utilizationBps >= p.maxPoolUtilizationBps
          ? 'HIGH'
          : utilizationBps >= warnBps
            ? 'WARNING'
            : null;
    if (!severity) return [];
    return [
      {
        type: 'portfolio.pool_utilization',
        category: 'PORTFOLIO',
        severity,
        subjectType: 'portfolio',
        subjectId: 'capital_pool',
        title:
          capitalCents <= 0
            ? `${usd(committedCents)} of rent is committed against an empty pool`
            : `Pool utilization ${pct(utilizationBps)} (ceiling ${pct(p.maxPoolUtilizationBps)})`,
        detail: {
          committedCents,
          capitalCents,
          utilizationBps: capitalCents <= 0 ? null : utilizationBps,
          ceilingBps: p.maxPoolUtilizationBps,
        },
        dedupeKey: 'portfolio.pool_utilization',
        tripsBreaker: severity === 'CRITICAL',
      },
    ];
  },
};

export const lossVersusExpected: Rule = {
  type: 'portfolio.loss_vs_expected',
  category: 'PORTFOLIO',
  description:
    'For each origination month old enough to have charged off, principal written off and not recovered against the expected loss its decisions were priced on. Critical trips the circuit breaker.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: true,
  evaluate: (inputs, policy) => {
    const p = policy.portfolio;
    const seasonedBefore = addDays(inputs.asOf, -p.lossCohortMinAgeDays);
    const cohorts = new Map<string, { plans: number; expected: number; realized: number }>();
    for (const plan of inputs.plans) {
      if (plan.originatedOn === null || plan.originatedOn > seasonedBefore) continue;
      if (plan.expectedLossBps === null) continue;
      const month = plan.originatedOn.slice(0, 7);
      const cohort = cohorts.get(month) ?? { plans: 0, expected: 0, realized: 0 };
      cohort.plans += 1;
      // The pricing figure is per period, in basis points of rent.
      cohort.expected += Math.round((plan.frontedCents * plan.expectedLossBps) / 10_000);
      for (const i of plan.installments) {
        if (i.chargedOffOn !== null && i.paidOn === null) cohort.realized += i.principalCents;
      }
      cohorts.set(month, cohort);
    }
    const out: AlertCandidate[] = [];
    for (const [month, cohort] of cohorts) {
      if (cohort.plans < p.minPlans || cohort.expected <= 0) continue;
      const ratioBps = bps(cohort.realized, cohort.expected);
      const severity = tiered(ratioBps, p.lossRatioWarnBps, p.lossRatioCriticalBps);
      if (!severity) continue;
      out.push({
        type: 'portfolio.loss_vs_expected',
        category: 'PORTFOLIO',
        severity,
        subjectType: 'portfolio',
        subjectId: `cohort:${month}`,
        title: `Losses on plans originated in ${month} are ${(ratioBps / 10_000).toFixed(1)} times what was expected`,
        detail: {
          cohort: month,
          plans: cohort.plans,
          expectedLossCents: cohort.expected,
          realizedLossCents: cohort.realized,
          ratioBps,
          warnBps: p.lossRatioWarnBps,
          criticalBps: p.lossRatioCriticalBps,
        },
        dedupeKey: `loss_vs_expected:${month}`,
        tripsBreaker: severity === 'CRITICAL',
      });
    }
    return out;
  },
};

export const PORTFOLIO_RULES: Rule[] = [
  firstPaymentDefault,
  delinquentShare,
  delinquencyRoll,
  industryConcentration,
  singleNameConcentration,
  poolUtilization,
  lossVersusExpected,
];

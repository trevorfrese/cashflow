import { addDays } from '@cashflow/shared';

import { classifyReturnCode } from '../../servicing/policy.ts';
import type { RateThreshold } from '../policy.ts';
import type { AlertCandidate, DebitFact, Rule } from '../types.ts';

/**
 * Payments rules: return rates against the network thresholds, and accounts that have
 * stopped working.
 */

export const bps = (n: number, d: number) => (d <= 0 ? 0 : Math.round((n * 10_000) / d));

/** Administrative returns: the account details were wrong or the account is gone. */
const ADMINISTRATIVE = new Set(['R02', 'R03', 'R04']);

const isReturn = (d: DebitFact) => d.returnCode !== null;
const isUnauthorized = (d: DebitFact) =>
  d.returnCode !== null && classifyReturnCode(d.returnCode) === 'UNAUTHORIZED';
const isAdministrative = (d: DebitFact) =>
  d.returnCode !== null && ADMINISTRATIVE.has(d.returnCode.toUpperCase());

function returnRateRule(spec: {
  type: string;
  label: string;
  description: string;
  severity: 'HIGH' | 'CRITICAL';
  pick: (p: {
    unauthorized: RateThreshold;
    administrative: RateThreshold;
    overall: RateThreshold;
  }) => RateThreshold;
  counts: (d: DebitFact) => boolean;
}): Rule {
  return {
    type: spec.type,
    category: 'PAYMENTS',
    description: spec.description,
    autoResolves: true,
    once: false,
    tripsCircuitBreaker: false,
    evaluate: (inputs, policy) => {
      const from = addDays(inputs.asOf, -(policy.payments.returnWindowDays - 1));
      const debits = inputs.debits.filter((d) => d.on >= from && d.on <= inputs.asOf);
      const returns = debits.filter(spec.counts);
      const threshold = spec.pick(policy.payments);
      // Too few debits, or too few returns, is not a rate. A single unauthorized return is
      // alerted as an event; it does not need a percentage to be taken seriously.
      if (debits.length < threshold.minSample || returns.length < threshold.minEvents) return [];
      const rateBps = bps(returns.length, debits.length);
      const warnBps = Math.round(
        (threshold.thresholdBps * policy.payments.warnAtShareBps) / 10_000,
      );
      if (rateBps < warnBps) return [];
      const breached = rateBps >= threshold.thresholdBps;
      return [
        {
          type: spec.type,
          category: 'PAYMENTS',
          severity: breached ? spec.severity : 'WARNING',
          subjectType: 'portfolio',
          subjectId: 'ach_returns',
          title: `${spec.label} return rate ${(rateBps / 100).toFixed(2)}% over ${policy.payments.returnWindowDays} days (${breached ? 'at or over' : 'approaching'} ${(threshold.thresholdBps / 100).toFixed(1)}%)`,
          detail: {
            windowDays: policy.payments.returnWindowDays,
            from,
            to: inputs.asOf,
            debits: debits.length,
            returns: returns.length,
            rateBps,
            thresholdBps: threshold.thresholdBps,
            byCode: returns.reduce<Record<string, number>>((acc, r) => {
              const code = r.returnCode!.toUpperCase();
              acc[code] = (acc[code] ?? 0) + 1;
              return acc;
            }, {}),
          },
          dedupeKey: spec.type,
        },
      ];
    },
  };
}

export const unauthorizedReturnRate = returnRateRule({
  type: 'payments.return_rate_unauthorized',
  label: 'Unauthorized',
  description:
    'Unauthorized returns (R05, R07, R10, R29) as a share of debits over the trailing window, against the network threshold of 0.5%. Critical at the threshold: the originating bank can suspend debits.',
  severity: 'CRITICAL',
  pick: (p) => p.unauthorized,
  counts: isUnauthorized,
});

export const administrativeReturnRate = returnRateRule({
  type: 'payments.return_rate_administrative',
  label: 'Administrative',
  description:
    'Administrative returns (R02, R03, R04) as a share of debits over the trailing window, against the network threshold of 3%.',
  severity: 'HIGH',
  pick: (p) => p.administrative,
  counts: isAdministrative,
});

export const overallReturnRate = returnRateRule({
  type: 'payments.return_rate_overall',
  label: 'Overall',
  description:
    'All returns as a share of debits over the trailing window, against the network threshold of 15%.',
  severity: 'HIGH',
  pick: (p) => p.overall,
  counts: isReturn,
});

export const repeatedFailures: Rule = {
  type: 'payments.repeated_failures',
  category: 'PAYMENTS',
  description:
    'Several debits on one bank account failed or came back inside the window. The account is not going to pay on its own.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const from = addDays(inputs.asOf, -(policy.payments.repeatedFailureWindowDays - 1));
    const byLink = new Map<string, DebitFact[]>();
    for (const d of inputs.debits) {
      if (d.status === 'SUCCEEDED' || d.on < from || d.on > inputs.asOf) continue;
      byLink.set(d.bankLinkId, [...(byLink.get(d.bankLinkId) ?? []), d]);
    }
    const out: AlertCandidate[] = [];
    for (const [bankLinkId, failed] of byLink) {
      if (failed.length < policy.payments.repeatedFailureCount) continue;
      out.push({
        type: 'payments.repeated_failures',
        category: 'PAYMENTS',
        severity: 'WARNING',
        subjectType: 'rent_plan',
        subjectId: failed[0]!.rentPlanId,
        title: `${failed.length} failed or returned debits on one bank account in ${policy.payments.repeatedFailureWindowDays} days`,
        detail: {
          bankLinkId,
          businessId: failed[0]!.businessId,
          failures: failed.length,
          returned: failed.filter((f) => f.status === 'RETURNED').length,
          codes: [...new Set(failed.map((f) => f.returnCode).filter(Boolean))],
          lastOn: failed.reduce((max, f) => (f.on > max ? f.on : max), failed[0]!.on),
        },
        dedupeKey: `repeated_failures:${bankLinkId}`,
      });
    }
    return out;
  },
};

export const attemptsExhausted: Rule = {
  type: 'payments.collection_attempts_exhausted',
  category: 'PAYMENTS',
  description:
    'A plan has installments that have used every automatic debit and are still unpaid. Only a manual payment clears them, so the owner needs a call.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) =>
    inputs.exhausted.map((e) => ({
      type: 'payments.collection_attempts_exhausted',
      category: 'PAYMENTS' as const,
      severity: 'WARNING' as const,
      subjectType: 'rent_plan',
      subjectId: e.rentPlanId,
      title: `Automatic collection has stopped: ${e.businessName}`,
      detail: {
        businessId: e.businessId,
        installments: e.installments,
        owedCents: e.owedCents,
        oldestDueDate: e.oldestDueDate,
      },
      dedupeKey: `attempts_exhausted:${e.rentPlanId}`,
    })),
};

export const PAYMENTS_RULES: Rule[] = [
  unauthorizedReturnRate,
  administrativeReturnRate,
  overallReturnRate,
  repeatedFailures,
  attemptsExhausted,
];

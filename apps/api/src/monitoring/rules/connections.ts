import type { AlertCandidate, Rule, VeracityEventFact } from '../types.ts';

/**
 * Data connection and veracity rules (data veracity phase). They read the connections'
 * current state and the veracity assessments the decisions and the refresh job write to the
 * audit log. Thresholds are in `policy.ts` under `veracity`.
 */

export const connectionUnhealthy: Rule = {
  type: 'payments.connection_unhealthy',
  category: 'PAYMENTS',
  description:
    'A bank or platform connection on a business with an active plan cannot be pulled: it needs the owner to sign in again, the last pull failed, or its token has expired. A bank connection is high: collections and monitoring read it. Clears when a pull succeeds.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs) =>
    inputs.connections
      .filter(
        (c) =>
          c.hasActivePlan &&
          c.status === 'LINKED' &&
          (c.health === 'REAUTH_REQUIRED' ||
            c.health === 'ERROR' ||
            (c.tokenExpiresOn !== null && c.tokenExpiresOn < inputs.asOf)),
      )
      .map((c): AlertCandidate => ({
        type: 'payments.connection_unhealthy',
        category: 'PAYMENTS',
        severity: c.kind === 'BANK' ? 'HIGH' : 'WARNING',
        subjectType: 'connection',
        subjectId: c.connectionId,
        title: `${c.name} connection ${c.health === 'REAUTH_REQUIRED' ? 'needs the owner to reconnect' : c.health === 'ERROR' ? 'is failing' : 'has an expired token'}: ${c.businessName}`,
        detail: {
          businessId: c.businessId,
          kind: c.kind,
          accessMethod: c.accessMethod,
          health: c.health,
          lastPulledOn: c.lastPulledOn,
          lastPullError: c.lastPullError,
          tokenExpiresOn: c.tokenExpiresOn,
        },
        dedupeKey: `connection_unhealthy:${c.connectionId}`,
      })),
};

const REWRITE_CODES = new Set(['HISTORY_REWRITTEN', 'HISTORY_CHANGED', 'SALES_HISTORY_CHANGED']);

export const historyRewritten: Rule = {
  type: 'fraud.history_rewritten',
  category: 'FRAUD',
  description:
    'A pull of a business with an active plan disagreed with an earlier pull about days that were already final. Critical when the change flatters the business (debits gone, credits added). Opens once per assessment and is closed by a person.',
  autoResolves: false,
  once: true,
  tripsCircuitBreaker: false,
  evaluate: (inputs) =>
    inputs.veracityEvents
      .filter((e) => e.hasActivePlan && e.findingCodes.some((c) => REWRITE_CODES.has(c)))
      .map((e) => ({
        type: 'fraud.history_rewritten',
        category: 'FRAUD' as const,
        severity: e.findingCodes.includes('HISTORY_REWRITTEN')
          ? ('CRITICAL' as const)
          : ('HIGH' as const),
        subjectType: 'business',
        subjectId: e.businessId,
        title: `Account history changed between pulls: ${e.businessName}`,
        detail: {
          assessmentEventId: e.id,
          on: e.on,
          findings: e.findingCodes.filter((c) => REWRITE_CODES.has(c)),
        },
        dedupeKey: `history_rewritten:${e.id}`,
      })),
};

export const payoutDestinationChanged: Rule = {
  type: 'fraud.payout_destination_changed',
  category: 'FRAUD',
  description:
    'A platform started paying out somewhere else after the business had a plan. Sales may now be leaving the account CashFlow debits. Opens once per change and is closed by a person.',
  autoResolves: false,
  once: true,
  tripsCircuitBreaker: false,
  evaluate: (inputs) =>
    inputs.payoutDestinationChanges
      .filter((c) => c.hasActivePlan)
      .map((c) => ({
        type: 'fraud.payout_destination_changed',
        category: 'FRAUD' as const,
        severity: 'WARNING' as const,
        subjectType: 'connection',
        subjectId: c.connectionId,
        title: `Payout account changed on the platform: ${c.businessName}`,
        detail: { businessId: c.businessId, on: c.on, fromMasks: c.fromMasks, toMasks: c.toMasks },
        dedupeKey: `payout_destination_changed:${c.eventId}`,
      })),
};

export const settlementMatchDrop: Rule = {
  type: 'fraud.settlement_match_drop',
  category: 'FRAUD',
  description:
    'For a business with an active plan, the share of platform payouts found in its connected bank fell sharply from the share at its last decision. High when under half match. Clears when the match recovers.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const p = policy.veracity;
    const byBusiness = new Map<string, VeracityEventFact[]>();
    for (const e of inputs.veracityEvents) {
      if (!e.hasActivePlan) continue;
      byBusiness.set(e.businessId, [...(byBusiness.get(e.businessId) ?? []), e]);
    }
    const out: AlertCandidate[] = [];
    const measured = (e: VeracityEventFact) =>
      e.matchedShareByAmountBps !== null && (e.payoutsConsidered ?? 0) >= p.settlementMinPayouts;
    for (const [businessId, events] of byBusiness) {
      const baseline = [...events].reverse().find((e) => e.source === 'DECISION' && measured(e));
      const latest = [...events].reverse().find(measured);
      if (!baseline || !latest || latest === baseline) continue;
      const drop = baseline.matchedShareByAmountBps! - latest.matchedShareByAmountBps!;
      if (drop < p.settlementDropBps || latest.matchedShareByAmountBps! >= p.settlementWarnBelowBps)
        continue;
      out.push({
        type: 'fraud.settlement_match_drop',
        category: 'FRAUD',
        severity: latest.matchedShareByAmountBps! < p.settlementHighBelowBps ? 'HIGH' : 'WARNING',
        subjectType: 'business',
        subjectId: businessId,
        title: `Platform payouts stopped matching bank deposits: ${latest.businessName}`,
        detail: {
          baselineOn: baseline.on,
          baselineMatchBps: baseline.matchedShareByAmountBps,
          latestOn: latest.on,
          latestMatchBps: latest.matchedShareByAmountBps,
        },
        dedupeKey: `settlement_match_drop:${businessId}`,
      });
    }
    return out;
  },
};

export const sharedPlatformAccount: Rule = {
  type: 'fraud.shared_platform_account',
  category: 'FRAUD',
  description:
    'Several businesses under different users connect the same platform merchant account, or are paid out to the same bank account. Clears when the connections are gone.',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: (inputs, policy) => {
    const groups = new Map<string, typeof inputs.connections>();
    for (const c of inputs.connections) {
      if (c.kind !== 'COMMERCE' || c.status !== 'LINKED') continue;
      const keys = [
        ...(c.platformAccountId ? [`account:${c.platformAccountId}`] : []),
        ...c.payoutDestinations.map((d) => `payout:${d}`),
      ];
      for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const out: AlertCandidate[] = [];
    for (const [key, list] of groups) {
      const users = new Set(list.map((c) => c.ownerUserId));
      const businesses = new Set(list.map((c) => c.businessId));
      if (users.size < 2 || businesses.size < policy.veracity.sharedAccountWarnBusinesses) continue;
      out.push({
        type: 'fraud.shared_platform_account',
        category: 'FRAUD',
        severity:
          businesses.size >= policy.veracity.sharedAccountHighBusinesses ? 'HIGH' : 'WARNING',
        subjectType: 'connection',
        subjectId: list[0]!.connectionId,
        title: `${businesses.size} businesses share one ${key.startsWith('account:') ? 'platform account' : 'payout account'}`,
        detail: {
          key: key.startsWith('payout:') ? key : 'platform account',
          businesses: [...new Map(list.map((c) => [c.businessId, c.businessName])).entries()].map(
            ([id, name]) => ({ id, name }),
          ),
        },
        dedupeKey: `shared_platform_account:${key}`,
      });
    }
    return out;
  },
};

export const CONNECTION_RULES: Rule[] = [
  connectionUnhealthy,
  historyRewritten,
  payoutDestinationChanged,
  settlementMatchDrop,
  sharedPlatformAccount,
];

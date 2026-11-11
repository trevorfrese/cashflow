import type { AlertSeverity } from '@cashflow/shared';

import type { MonitoringPolicy } from './policy.ts';
import { BOOKS_RULES } from './rules/books.ts';
import { COMPLIANCE_RULES } from './rules/compliance.ts';
import { CONNECTION_RULES } from './rules/connections.ts';
import { EVENT_RULES } from './rules/events.ts';
import { FRAUD_RULES } from './rules/fraud.ts';
import { PAYMENTS_RULES } from './rules/payments.ts';
import { PORTFOLIO_RULES } from './rules/portfolio.ts';
import type { AlertCandidate, MonitoringInputs, Rule } from './types.ts';

/**
 * The monitoring engine: every rule, and the pure decision of what to do with what the rules
 * returned given the alerts that already exist. No database here. `service.ts` gathers the
 * inputs, calls these, and writes the result.
 */
export const RULES: Rule[] = [
  ...FRAUD_RULES,
  ...EVENT_RULES,
  ...PAYMENTS_RULES,
  ...PORTFOLIO_RULES,
  ...BOOKS_RULES,
  ...COMPLIANCE_RULES,
  ...CONNECTION_RULES,
];

export const ruleByType = (type: string, rules: readonly Rule[] = RULES) =>
  rules.find((r) => r.type === type) ?? null;

export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/** `resolvedBy` on an alert the monitor closed because its condition went away. */
export const MONITOR_ACTOR = 'system:monitor';

export interface RuleRun {
  type: string;
  ok: boolean;
  candidates: number;
  error?: string;
}

export interface Evaluation {
  candidates: AlertCandidate[];
  runs: RuleRun[];
}

/**
 * Run every rule. A rule that throws is recorded and skipped: one broken rule must not stop
 * the others, and its open alerts are left alone rather than resolved on no evidence. Two
 * candidates with the same key in one run collapse into the more severe one.
 */
export function evaluateRules(
  inputs: MonitoringInputs,
  policy: MonitoringPolicy,
  rules: readonly Rule[] = RULES,
): Evaluation {
  const byKey = new Map<string, AlertCandidate>();
  const runs: RuleRun[] = [];
  for (const rule of rules) {
    try {
      const found = rule.evaluate(inputs, policy);
      runs.push({ type: rule.type, ok: true, candidates: found.length });
      for (const c of found) {
        const prior = byKey.get(c.dedupeKey);
        if (!prior || SEVERITY_RANK[c.severity] > SEVERITY_RANK[prior.severity]) {
          byKey.set(c.dedupeKey, c);
        }
      }
    } catch (err) {
      runs.push({
        type: rule.type,
        ok: false,
        candidates: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { candidates: [...byKey.values()], runs };
}

/** What the planner needs to know about an alert that already exists. */
export interface ExistingAlert {
  id: string;
  type: string;
  dedupeKey: string;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  severity: AlertSeverity;
  resolvedBy: string | null;
  /** ISO timestamp. */
  resolvedAt: string | null;
}

export interface AlertPlan {
  /** New alerts to open. */
  open: AlertCandidate[];
  /** Alerts whose condition is still there: touch `lastSeenAt`, and move the severity. */
  refresh: Array<{ id: string; candidate: AlertCandidate; escalated: boolean }>;
  /** Alerts whose condition has gone and whose rule resolves on its own. */
  resolve: Array<{ id: string; type: string }>;
  /** The first new or escalated alert that trips the circuit breaker, if any. */
  trip: AlertCandidate | null;
}

/**
 * Decide what to write.
 *
 *   - A candidate whose key has an alert that is not resolved refreshes it. Nothing new
 *     opens: that is the dedupe.
 *   - A candidate from a `once` rule (an event) never opens a second alert, resolved or not.
 *   - A candidate whose key was resolved by a person inside the suppression window stays
 *     closed: they looked, and the next run does not undo that. An alert the monitor
 *     resolved can reopen straight away.
 *   - An unresolved alert whose rule resolves on its own, ran without error this time, and
 *     did not return it, is resolved.
 *   - The breaker trips on a breaker candidate that is new, or that has risen in severity.
 *     An alert that just stays open does not trip it again after an admin has reset it.
 */
export function planAlertActions(args: {
  evaluation: Evaluation;
  existing: readonly ExistingAlert[];
  policy: MonitoringPolicy;
  /** ISO timestamp of the run. */
  now: string;
  rules?: readonly Rule[];
}): AlertPlan {
  const rules = args.rules ?? RULES;
  const plan: AlertPlan = { open: [], refresh: [], resolve: [], trip: null };
  const active = new Map<string, ExistingAlert>();
  const resolved = new Map<string, ExistingAlert[]>();
  for (const alert of args.existing) {
    if (alert.status !== 'RESOLVED') active.set(alert.dedupeKey, alert);
    else resolved.set(alert.dedupeKey, [...(resolved.get(alert.dedupeKey) ?? []), alert]);
  }
  const suppressedSince = new Date(
    new Date(args.now).getTime() - args.policy.reopenSuppressionDays * 86_400_000,
  ).toISOString();
  const seen = new Set<string>();

  for (const candidate of args.evaluation.candidates) {
    seen.add(candidate.dedupeKey);
    const rule = ruleByType(candidate.type, rules);
    const current = active.get(candidate.dedupeKey);
    if (current) {
      const escalated = SEVERITY_RANK[candidate.severity] > SEVERITY_RANK[current.severity];
      plan.refresh.push({ id: current.id, candidate, escalated });
      if (escalated && candidate.tripsBreaker && !plan.trip) plan.trip = candidate;
      continue;
    }
    const earlier = resolved.get(candidate.dedupeKey) ?? [];
    if (rule?.once && earlier.length > 0) continue;
    const byPerson = earlier.some(
      (a) =>
        a.resolvedBy !== null &&
        a.resolvedBy !== MONITOR_ACTOR &&
        a.resolvedAt !== null &&
        a.resolvedAt >= suppressedSince,
    );
    if (byPerson) continue;
    plan.open.push(candidate);
    if (candidate.tripsBreaker && !plan.trip) plan.trip = candidate;
  }

  const ranOk = new Set(args.evaluation.runs.filter((r) => r.ok).map((r) => r.type));
  for (const alert of active.values()) {
    if (seen.has(alert.dedupeKey)) continue;
    const rule = ruleByType(alert.type, rules);
    if (!rule?.autoResolves || !ranOk.has(alert.type)) continue;
    plan.resolve.push({ id: alert.id, type: alert.type });
  }
  return plan;
}

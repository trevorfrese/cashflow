import type { IsoDate } from '@cashflow/shared';
import { expect } from 'vitest';

import { evaluateRules, planAlertActions, type ExistingAlert } from './engine.ts';
import { MONITORING_POLICY, type MonitoringPolicy } from './policy.ts';
import type { AlertCandidate, InstallmentFact, MonitoringInputs, PlanFact, Rule } from './types.ts';

/** Builders for the monitoring unit tests. Not used outside tests. */

export const AS_OF: IsoDate = '2026-11-10';
export const NOW = `${AS_OF}T12:00:00.000Z`;

/** A book where nothing is wrong: every rule returns nothing on it. */
export function inputs(over: Partial<MonitoringInputs> = {}): MonitoringInputs {
  return {
    asOf: AS_OF,
    leaseChanges: [],
    landlordAccounts: [],
    bankAccounts: [],
    applications: [],
    auditEvents: [],
    debits: [],
    exhausted: [],
    plans: [],
    exposure: { capitalCents: 25_000_000, committedCents: 0, byIndustry: [], byBusiness: [] },
    books: {
      totalDebitsCents: 1000,
      totalCreditsCents: 1000,
      cashCents: 0,
      lastCashPostingAt: null,
      lastSweepAt: null,
      allowanceCents: 0,
      poolCents: 25_000_000,
      receivables: [],
      appendOnlyTriggers: ['AuditEvent', 'LedgerEntry', 'LedgerTransaction'],
    },
    jobs: [],
    screenings: [],
    identities: [],
    retention: [],
    adverseActions: [],
    ...over,
  };
}

export const run = (
  rule: Rule,
  data: MonitoringInputs,
  policy: MonitoringPolicy = MONITORING_POLICY,
): AlertCandidate[] => rule.evaluate(data, policy);

const asExisting = (c: AlertCandidate, id: string): ExistingAlert => ({
  id,
  type: c.type,
  dedupeKey: c.dedupeKey,
  status: 'OPEN',
  severity: c.severity,
  resolvedBy: null,
  resolvedAt: null,
});

/**
 * The dedupe property every rule has to have: run on the same state twice, the second run
 * opens nothing, because each candidate carries the same key as the alert the first run
 * opened. Also checks keys are unique within a run.
 */
export function expectDedupes(
  rule: Rule,
  data: MonitoringInputs,
  policy: MonitoringPolicy = MONITORING_POLICY,
): void {
  const first = evaluateRules(data, policy, [rule]);
  expect(first.candidates.length).toBeGreaterThan(0);
  const keys = rule.evaluate(data, policy).map((c) => c.dedupeKey);
  expect(new Set(keys).size).toBe(keys.length);
  const opened = planAlertActions({
    evaluation: first,
    existing: [],
    policy,
    now: NOW,
    rules: [rule],
  });
  expect(opened.open).toHaveLength(first.candidates.length);
  const second = planAlertActions({
    evaluation: evaluateRules(data, policy, [rule]),
    existing: opened.open.map((c, i) => asExisting(c, `a${i}`)),
    policy,
    now: NOW,
    rules: [rule],
  });
  expect(second.open).toEqual([]);
  expect(second.resolve).toEqual([]);
  expect(second.refresh).toHaveLength(first.candidates.length);
}

export function installment(over: Partial<InstallmentFact> = {}): InstallmentFact {
  return {
    principalCents: 100_000,
    dueDate: '2026-10-01',
    status: 'PAID',
    first: false,
    frontedOn: '2026-10-01',
    paidOn: '2026-10-01',
    chargedOffOn: null,
    ...over,
  };
}

let planCounter = 0;
export function plan(over: Partial<PlanFact> = {}): PlanFact {
  planCounter += 1;
  return {
    planId: `plan${planCounter}`,
    businessId: `biz${planCounter}`,
    businessName: `Business ${planCounter}`,
    industry: 'RETAIL',
    status: 'ACTIVE',
    monthlyRentCents: 200_000,
    originatedOn: '2026-10-01',
    expectedLossBps: 20,
    periodsFronted: 1,
    frontedCents: 200_000,
    installments: [],
    ...over,
  };
}

/** `n` plans built by `make`, which gets the index. */
export const plans = (n: number, make: (i: number) => Partial<PlanFact>): PlanFact[] =>
  Array.from({ length: n }, (_, i) => plan(make(i)));

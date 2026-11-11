import { describe, expect, it } from 'vitest';

import {
  evaluateRules,
  MONITOR_ACTOR,
  planAlertActions,
  RULES,
  type ExistingAlert,
} from './engine.ts';
import { MONITORING_POLICY } from './policy.ts';
import { inputs, NOW } from './test-support.ts';
import type { AlertCandidate, Rule } from './types.ts';

const candidate = (over: Partial<AlertCandidate> = {}): AlertCandidate => ({
  type: 'test.state',
  category: 'BOOKS',
  severity: 'WARNING',
  subjectType: 'ledger',
  subjectId: 'x',
  title: 'Something is off',
  detail: {},
  dedupeKey: 'test.state:x',
  ...over,
});

const rule = (over: Partial<Rule> & { found?: AlertCandidate[] } = {}): Rule => ({
  type: 'test.state',
  category: 'BOOKS',
  description: 'test',
  autoResolves: true,
  once: false,
  tripsCircuitBreaker: false,
  evaluate: () => over.found ?? [candidate()],
  ...over,
});

const existing = (over: Partial<ExistingAlert> = {}): ExistingAlert => ({
  id: 'a1',
  type: 'test.state',
  dedupeKey: 'test.state:x',
  status: 'OPEN',
  severity: 'WARNING',
  resolvedBy: null,
  resolvedAt: null,
  ...over,
});

const plan = (rules: Rule[], alerts: ExistingAlert[] = []) =>
  planAlertActions({
    evaluation: evaluateRules(inputs(), MONITORING_POLICY, rules),
    existing: alerts,
    policy: MONITORING_POLICY,
    now: NOW,
    rules,
  });

const daysAgo = (n: number) => new Date(new Date(NOW).getTime() - n * 86_400_000).toISOString();

describe('the rule registry', () => {
  it('has a unique type and a description for every rule', () => {
    const types = RULES.map((r) => r.type);
    expect(new Set(types).size).toBe(types.length);
    for (const r of RULES) {
      expect(r.type).toMatch(/^(fraud|payments|portfolio|books|compliance)\.[a-z_]+$/);
      expect(r.description.length).toBeGreaterThan(20);
      // An event alert is about something that happened: it cannot clear on its own.
      if (r.once) expect(r.autoResolves).toBe(false);
    }
  });

  it('returns nothing from any rule on a clean book', () => {
    const evaluation = evaluateRules(inputs(), MONITORING_POLICY);
    expect(evaluation.candidates).toEqual([]);
    expect(evaluation.runs.every((r) => r.ok)).toBe(true);
    expect(evaluation.runs).toHaveLength(RULES.length);
  });

  it('only portfolio rules trip the circuit breaker', () => {
    expect(
      RULES.filter((r) => r.tripsCircuitBreaker)
        .map((r) => r.type)
        .sort(),
    ).toEqual([
      'portfolio.delinquency_roll',
      'portfolio.delinquent_share',
      'portfolio.first_payment_default',
      'portfolio.loss_vs_expected',
      'portfolio.pool_utilization',
    ]);
  });
});

describe('evaluateRules', () => {
  it('keeps going when a rule throws, and reports it', () => {
    const broken = rule({
      type: 'test.broken',
      evaluate: () => {
        throw new Error('boom');
      },
    });
    const evaluation = evaluateRules(inputs(), MONITORING_POLICY, [broken, rule()]);
    expect(evaluation.candidates).toHaveLength(1);
    expect(evaluation.runs).toEqual([
      { type: 'test.broken', ok: false, candidates: 0, error: 'boom' },
      { type: 'test.state', ok: true, candidates: 1 },
    ]);
  });

  it('collapses two candidates with one key into the more severe', () => {
    const both = rule({ found: [candidate(), candidate({ severity: 'CRITICAL' })] });
    expect(evaluateRules(inputs(), MONITORING_POLICY, [both]).candidates).toEqual([
      expect.objectContaining({ severity: 'CRITICAL' }),
    ]);
  });
});

describe('planAlertActions', () => {
  it('opens an alert for a new condition', () => {
    expect(plan([rule()])).toMatchObject({ open: [{ dedupeKey: 'test.state:x' }], refresh: [] });
  });

  it('does not open a second alert while one is open or acknowledged', () => {
    for (const status of ['OPEN', 'ACKNOWLEDGED'] as const) {
      const result = plan([rule()], [existing({ status })]);
      expect(result.open).toEqual([]);
      expect(result.refresh).toEqual([expect.objectContaining({ id: 'a1', escalated: false })]);
    }
  });

  it('resolves an alert whose condition has gone, when the rule resolves on its own', () => {
    expect(plan([rule({ found: [] })], [existing()]).resolve).toEqual([
      { id: 'a1', type: 'test.state' },
    ]);
  });

  it('leaves it open when the rule does not resolve on its own', () => {
    expect(plan([rule({ found: [], autoResolves: false })], [existing()]).resolve).toEqual([]);
  });

  it('leaves it open when the rule failed this run: no evidence is not good news', () => {
    const broken = rule({
      evaluate: () => {
        throw new Error('boom');
      },
    });
    expect(plan([broken], [existing()]).resolve).toEqual([]);
  });

  it('reopens at once after the monitor resolved it', () => {
    const cleared = existing({
      status: 'RESOLVED',
      resolvedBy: MONITOR_ACTOR,
      resolvedAt: daysAgo(1),
    });
    expect(plan([rule()], [cleared]).open).toHaveLength(1);
  });

  it('stays closed for the suppression window after a person resolved it, then reopens', () => {
    const recent = existing({ status: 'RESOLVED', resolvedBy: 'pat', resolvedAt: daysAgo(5) });
    expect(plan([rule()], [recent]).open).toEqual([]);
    const old = existing({
      status: 'RESOLVED',
      resolvedBy: 'pat',
      resolvedAt: daysAgo(MONITORING_POLICY.reopenSuppressionDays + 1),
    });
    expect(plan([rule()], [old]).open).toHaveLength(1);
  });

  it('opens an event alert once, and never again after it is resolved', () => {
    const event = rule({ once: true, autoResolves: false });
    expect(plan([event]).open).toHaveLength(1);
    expect(plan([event], [existing()]).open).toEqual([]);
    const resolvedLongAgo = existing({
      status: 'RESOLVED',
      resolvedBy: 'pat',
      resolvedAt: daysAgo(400),
    });
    expect(plan([event], [resolvedLongAgo]).open).toEqual([]);
  });

  it('trips the breaker on a new breaker candidate, and on one that has escalated', () => {
    const critical = candidate({ severity: 'CRITICAL', tripsBreaker: true });
    const breaker = rule({ tripsCircuitBreaker: true, found: [critical] });
    expect(plan([breaker]).trip).toEqual(critical);
    expect(plan([breaker], [existing({ severity: 'WARNING' })])).toMatchObject({
      trip: critical,
      refresh: [{ escalated: true }],
    });
  });

  it('does not trip again while the same alert just stays open', () => {
    const critical = candidate({ severity: 'CRITICAL', tripsBreaker: true });
    const breaker = rule({ tripsCircuitBreaker: true, found: [critical] });
    expect(plan([breaker], [existing({ severity: 'CRITICAL' })]).trip).toBeNull();
  });

  it('does not trip below the severity that carries the flag', () => {
    const warning = rule({ tripsCircuitBreaker: true, found: [candidate()] });
    expect(plan([warning]).trip).toBeNull();
  });
});

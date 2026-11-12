import { describe, expect, it } from 'vitest';

import { evaluateRules, planAlertActions } from '../engine.ts';
import { MONITORING_POLICY } from '../policy.ts';
import { AS_OF, expectDedupes, inputs, NOW } from '../test-support.ts';
import type { AuditEventFact } from '../types.ts';
import { ALERTED_EVENT_TYPES, EVENT_RULES } from './events.ts';

const event = (eventType: string, over: Partial<AuditEventFact> = {}): AuditEventFact => ({
  id: `evt-${eventType}`,
  on: AS_OF,
  eventType,
  subjectType: 'rent_plan',
  subjectId: 'plan1',
  severity: 'high',
  payload: {
    returnCode: 'R10',
    periodMonth: '2026-11',
    principalCents: 390_000,
    reason: 'PAST_DUE',
  },
  ...over,
});

const byType = (type: string) => EVENT_RULES.find((r) => r.type === type)!;

describe('alerts from audit events', () => {
  it('turns each event that needs a person into one alert at its severity', () => {
    const expected: Array<[string, string, string]> = [
      ['UNAUTHORIZED_RETURN', 'fraud.unauthorized_return', 'HIGH'],
      ['PAYOUT_RETURNED', 'payments.payout_returned', 'HIGH'],
      ['PLAN_CHARGED_OFF', 'portfolio.plan_charged_off', 'HIGH'],
      ['BANK_LINK_DISABLED', 'payments.bank_link_disabled', 'WARNING'],
      ['PAYOUT_CANCELLED', 'payments.payout_cancelled', 'WARNING'],
      ['LOGIN_LOCKED', 'fraud.login_lockout', 'INFO'],
      ['PASS_THROUGH_RETURNED_AFTER_PAYOUT', 'payments.pass_through_returned_after_payout', 'HIGH'],
      ['DUPLICATE_PAYOUT_PREVENTED', 'payments.duplicate_payout_prevented', 'HIGH'],
    ];
    expect(ALERTED_EVENT_TYPES.sort()).toEqual(expected.map((e) => e[0]).sort());
    for (const [eventType, type, severity] of expected) {
      const data = inputs({ auditEvents: [event(eventType)] });
      const found = byType(type).evaluate(data, MONITORING_POLICY);
      expect(found).toMatchObject([
        {
          type,
          severity,
          subjectType: 'rent_plan',
          subjectId: 'plan1',
          dedupeKey: `audit:evt-${eventType}`,
          detail: { auditEventId: `evt-${eventType}` },
        },
      ]);
      expectDedupes(byType(type), data);
    }
  });

  it('does not fire on events it does not own, or on routine ones', () => {
    const data = inputs({
      auditEvents: [event('PAYOUT_HELD'), event('DELINQUENCY_CHANGED'), event('PAYMENT_RETURNED')],
    });
    expect(evaluateRules(data, MONITORING_POLICY, EVENT_RULES).candidates).toEqual([]);
  });

  it('ignores a payout cancelled because its plan closed', () => {
    const data = inputs({
      auditEvents: [event('PAYOUT_CANCELLED', { payload: { reason: 'PLAN_CLOSED' } })],
    });
    expect(byType('payments.payout_cancelled').evaluate(data, MONITORING_POLICY)).toEqual([]);
  });

  it('is one alert per event, opened once and never again after it is resolved', () => {
    const rule = byType('fraud.unauthorized_return');
    const data = inputs({
      auditEvents: [event('UNAUTHORIZED_RETURN'), event('UNAUTHORIZED_RETURN', { id: 'evt-2' })],
    });
    const evaluation = evaluateRules(data, MONITORING_POLICY, [rule]);
    expect(evaluation.candidates).toHaveLength(2);
    const plan = planAlertActions({
      evaluation,
      existing: [
        {
          id: 'a1',
          type: rule.type,
          dedupeKey: 'audit:evt-UNAUTHORIZED_RETURN',
          status: 'RESOLVED',
          severity: 'HIGH',
          resolvedBy: 'pat',
          resolvedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      policy: MONITORING_POLICY,
      now: NOW,
      rules: [rule],
    });
    expect(plan.open.map((c) => c.dedupeKey)).toEqual(['audit:evt-2']);
    expect(rule.autoResolves).toBe(false);
  });
});

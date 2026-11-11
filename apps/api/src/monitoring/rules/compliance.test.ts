import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { MONITORING_POLICY } from '../policy.ts';
import { AS_OF, expectDedupes, inputs, run } from '../test-support.ts';
import type { AdverseActionFact, ApplicationFact, ScreeningFact } from '../types.ts';
import {
  adverseActionNoticeMissing,
  decisionDeadline,
  identityUnverified,
  retentionViolation,
  screeningStale,
} from './compliance.ts';

const application = (
  daysWaiting: number,
  over: Partial<ApplicationFact> = {},
): ApplicationFact => ({
  id: 'app1',
  businessId: 'biz1',
  businessName: 'Tidewater Sign Works',
  ownerUserId: 'user1',
  status: 'IN_REVIEW',
  createdOn: addDays(AS_OF, -daysWaiting),
  submittedOn: addDays(AS_OF, -daysWaiting),
  declinedOn: null,
  ...over,
});

describe('compliance.decision_deadline', () => {
  const at = (days: number, over: Partial<ApplicationFact> = {}) =>
    run(decisionDeadline, inputs({ applications: [application(days, over)] }));

  it('warns at 20 days and is critical at 30', () => {
    expect(at(19)).toEqual([]);
    expect(at(20)).toMatchObject([{ severity: 'WARNING', detail: { daysWaiting: 20 } }]);
    expect(at(29)).toMatchObject([{ severity: 'WARNING' }]);
    expect(at(30)).toMatchObject([
      { severity: 'CRITICAL', subjectType: 'application', subjectId: 'app1' },
    ]);
    expect(at(34)[0]!.detail).toMatchObject({ deadline: addDays(AS_OF, -4) });
    expectDedupes(decisionDeadline, inputs({ applications: [application(34)] }));
  });

  it('covers an application submitted and never decided', () => {
    expect(at(31, { status: 'SUBMITTED' })).toMatchObject([{ severity: 'CRITICAL' }]);
  });

  it('does not fire once decided, for a draft, or while waiting on the applicant', () => {
    for (const status of ['APPROVED', 'DECLINED', 'NEEDS_INFO']) {
      expect(at(40, { status })).toEqual([]);
    }
    expect(at(40, { status: 'DRAFT', submittedOn: null })).toEqual([]);
  });

  it('keeps one alert as the application ages from warning to critical', () => {
    expect(at(20)[0]!.dedupeKey).toBe(at(35)[0]!.dedupeKey);
  });
});

describe('compliance.adverse_action_notice_missing', () => {
  const decision = (over: Partial<AdverseActionFact> = {}): AdverseActionFact => ({
    decisionId: 'dec1',
    applicationId: 'app1',
    businessName: 'Northside Barbers',
    outcome: 'DECLINED',
    decidedOn: addDays(AS_OF, -3),
    noticeSentOn: null,
    ...over,
  });
  const active = {
    ...MONITORING_POLICY,
    compliance: { ...MONITORING_POLICY.compliance, adverseActionNoticeRuleActive: true },
  };

  it('is switched off until the notice exists, and returns nothing even for a decline', () => {
    expect(MONITORING_POLICY.compliance.adverseActionNoticeRuleActive).toBe(false);
    expect(run(adverseActionNoticeMissing, inputs({ adverseActions: [decision()] }))).toEqual([]);
  });

  it('once switched on, fires for a decline or counter offer with no stored notice', () => {
    const data = inputs({
      adverseActions: [decision(), decision({ decisionId: 'dec2', outcome: 'COUNTER_OFFER' })],
    });
    expect(run(adverseActionNoticeMissing, data, active)).toMatchObject([
      { severity: 'HIGH', dedupeKey: 'adverse_action:dec1' },
      { severity: 'HIGH', dedupeKey: 'adverse_action:dec2' },
    ]);
    expectDedupes(adverseActionNoticeMissing, data, active);
  });

  it('once switched on, does not fire when the notice is stored or the decision is from today', () => {
    expect(
      run(
        adverseActionNoticeMissing,
        inputs({
          adverseActions: [decision({ noticeSentOn: AS_OF }), decision({ decidedOn: AS_OF })],
        }),
        active,
      ),
    ).toEqual([]);
  });
});

describe('compliance.screening_stale', () => {
  const screening = (daysAgo: number, over: Partial<ScreeningFact> = {}): ScreeningFact => ({
    id: `scr${daysAgo}`,
    businessId: 'biz1',
    businessName: 'Blue Door Bakery',
    partyType: 'BUSINESS',
    partyRef: 'biz1',
    result: 'CLEAR',
    cleared: false,
    screenedOn: addDays(AS_OF, -daysAgo),
    leaseChangeId: null,
    activeParty: true,
    ...over,
  });

  it('fires once per business when a party was last screened past the interval and grace', () => {
    const data = inputs({ screenings: [screening(38), screening(45, { partyType: 'OWNER' })] });
    const alerts = run(screeningStale, data);
    expect(alerts).toMatchObject([
      { severity: 'WARNING', subjectId: 'biz1', detail: { limitDays: 37 } },
    ]);
    expect((alerts[0]!.detail.parties as unknown[]).length).toBe(2);
    expectDedupes(screeningStale, data);
  });

  it('does not fire inside the grace, for parties with no running plan, or proposed landlords', () => {
    expect(run(screeningStale, inputs({ screenings: [screening(37)] }))).toEqual([]);
    expect(
      run(screeningStale, inputs({ screenings: [screening(90, { activeParty: false })] })),
    ).toEqual([]);
    expect(
      run(screeningStale, inputs({ screenings: [screening(90, { leaseChangeId: 'chg1' })] })),
    ).toEqual([]);
  });
});

describe('compliance.retention_violation', () => {
  it('is critical when a decided application no longer exists', () => {
    const data = inputs({
      retention: [
        { applicationId: 'gone', decidedOn: addDays(AS_OF, -100), exists: false },
        { applicationId: 'kept', decidedOn: addDays(AS_OF, -100), exists: true },
      ],
    });
    expect(run(retentionViolation, data)).toMatchObject([
      { severity: 'CRITICAL', subjectId: 'gone' },
    ]);
    expectDedupes(retentionViolation, data);
  });

  it('does not fire while every record is there, and never resolves on its own', () => {
    expect(
      run(
        retentionViolation,
        inputs({ retention: [{ applicationId: 'kept', decidedOn: AS_OF, exists: true }] }),
      ),
    ).toEqual([]);
    expect(retentionViolation.autoResolves).toBe(false);
    expect(MONITORING_POLICY.compliance.retentionMonths).toBe(12);
  });
});

describe('compliance.identity_unverified', () => {
  const business = (verificationStatus: string, hasOpenPlan = true) => ({
    businessId: 'biz1',
    businessName: 'Blue Door Bakery',
    verificationStatus,
    reasons: ['TAX_ID_MISSING'],
    hasOpenPlan,
  });

  it('warns for a business with a running plan that is not verified, high when it failed', () => {
    const data = inputs({ identities: [business('UNVERIFIED')] });
    expect(run(identityUnverified, data)).toMatchObject([{ severity: 'WARNING' }]);
    expectDedupes(identityUnverified, data);
    expect(run(identityUnverified, inputs({ identities: [business('FAILED')] }))).toMatchObject([
      { severity: 'HIGH' },
    ]);
  });

  it('does not fire for a verified business, or one with no running plan', () => {
    expect(run(identityUnverified, inputs({ identities: [business('VERIFIED')] }))).toEqual([]);
    expect(run(identityUnverified, inputs({ identities: [business('REVIEW', false)] }))).toEqual(
      [],
    );
  });
});

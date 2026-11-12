import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { MONITORING_POLICY } from '../policy.ts';
import { AS_OF, expectDedupes, inputs, run } from '../test-support.ts';
import type { AdverseActionFact, ApplicationFact, ScreeningFact } from '../types.ts';
import {
  adverseActionNoticeLate,
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
    kind: 'DECLINE',
    actionOn: addDays(AS_OF, -3),
    deadlineOn: addDays(AS_OF, 27),
    noticeSentOn: null,
    ...over,
  });
  const off = {
    ...MONITORING_POLICY,
    compliance: { ...MONITORING_POLICY.compliance, adverseActionNoticeRuleActive: false },
  };

  it('is on now that notices are stored, and the switch still turns it off', () => {
    expect(MONITORING_POLICY.compliance.adverseActionNoticeRuleActive).toBe(true);
    expect(run(adverseActionNoticeMissing, inputs({ adverseActions: [decision()] }), off)).toEqual(
      [],
    );
  });

  it('fires for every kind of notice owed and not stored, critical past the deadline', () => {
    const data = inputs({
      adverseActions: [
        decision(),
        decision({ decisionId: 'dec2', kind: 'COUNTER_OFFER_NOT_ACCEPTED' }),
        decision({ decisionId: 'dec3', kind: 'INCOMPLETE', deadlineOn: addDays(AS_OF, -1) }),
        decision({ decisionId: 'dec4', kind: 'INCOMPLETE_DECLINED' }),
      ],
    });
    expect(run(adverseActionNoticeMissing, data)).toMatchObject([
      { severity: 'HIGH', dedupeKey: 'adverse_action:dec1:DECLINE' },
      { severity: 'HIGH', dedupeKey: 'adverse_action:dec2:COUNTER_OFFER_NOT_ACCEPTED' },
      { severity: 'CRITICAL', dedupeKey: 'adverse_action:dec3:INCOMPLETE' },
      { severity: 'HIGH', dedupeKey: 'adverse_action:dec4:INCOMPLETE_DECLINED' },
    ]);
    expectDedupes(adverseActionNoticeMissing, data);
  });

  it('does not fire when the notice is stored or it only fell due today', () => {
    expect(
      run(
        adverseActionNoticeMissing,
        inputs({
          adverseActions: [decision({ noticeSentOn: AS_OF }), decision({ actionOn: AS_OF })],
        }),
      ),
    ).toEqual([]);
  });
});

describe('compliance.adverse_action_notice_late', () => {
  const notice = (over: Partial<AdverseActionFact> = {}): AdverseActionFact => ({
    decisionId: 'dec1',
    applicationId: 'app1',
    businessName: 'Tidewater Sign Works',
    kind: 'DECLINE',
    actionOn: addDays(AS_OF, -1),
    deadlineOn: addDays(AS_OF, -5),
    noticeSentOn: addDays(AS_OF, -1),
    ...over,
  });

  it('fires once for a notice delivered after its deadline, and never auto resolves', () => {
    const data = inputs({ adverseActions: [notice()] });
    expect(run(adverseActionNoticeLate, data)).toMatchObject([
      { severity: 'HIGH', dedupeKey: 'adverse_action_late:dec1:DECLINE' },
    ]);
    expect(adverseActionNoticeLate.autoResolves).toBe(false);
    expect(adverseActionNoticeLate.once).toBe(true);
  });

  it('is quiet for a notice on time, or one not yet sent (the missing rule has that)', () => {
    expect(
      run(
        adverseActionNoticeLate,
        inputs({
          adverseActions: [
            notice({ noticeSentOn: addDays(AS_OF, -5) }),
            notice({ noticeSentOn: null }),
          ],
        }),
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

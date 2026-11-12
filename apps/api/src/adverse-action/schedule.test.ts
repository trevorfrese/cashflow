import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import { NOTICE_POLICY } from './policy.ts';
import { dueNotices, type ApplicationNoticeFacts } from './schedule.ts';

const AS_OF = '2026-11-12';
const facts = (over: Partial<ApplicationNoticeFacts> = {}): ApplicationNoticeFacts => ({
  applicationId: 'app1',
  businessId: 'biz1',
  businessName: 'Sellwood Books',
  status: 'DECLINED',
  submittedOn: AS_OF,
  requestedMonthlyRentCents: 600_000,
  decision: {
    id: 'dec1',
    kind: 'ENGINE',
    outcome: 'DECLINED',
    decidedOn: AS_OF,
    approvedMonthlyLimitCents: null,
  },
  hasFinancedPlan: false,
  notices: [],
  ...over,
});
const counter = (decidedOn: string, over: Partial<ApplicationNoticeFacts> = {}) =>
  facts({
    status: 'APPROVED',
    decision: {
      id: 'dec1',
      kind: 'ENGINE',
      outcome: 'APPROVED',
      decidedOn,
      approvedMonthlyLimitCents: 450_000,
    },
    ...over,
  });

describe('dueNotices', () => {
  it('owes a decline its notice at once, due 30 days from the completed application', () => {
    expect(dueNotices(facts({ submittedOn: addDays(AS_OF, -34) }), AS_OF)).toMatchObject([
      { kind: 'DECLINE', actionOn: AS_OF, deadlineOn: addDays(AS_OF, -4), stored: null },
    ]);
  });

  it('owes nothing for an approval at the rent requested, a referral, or a periodic review', () => {
    expect(
      dueNotices(
        facts({
          status: 'APPROVED',
          decision: {
            ...facts().decision!,
            outcome: 'APPROVED',
            approvedMonthlyLimitCents: 600_000,
          },
        }),
        AS_OF,
      ),
    ).toEqual([]);
    expect(
      dueNotices(
        facts({ status: 'IN_REVIEW', decision: { ...facts().decision!, outcome: 'REFER' } }),
        AS_OF,
      ),
    ).toEqual([]);
    expect(
      dueNotices(facts({ decision: { ...facts().decision!, kind: 'PERIODIC_REVIEW' } }), AS_OF),
    ).toEqual([]);
  });

  it('owes a counter offer a notice only once it expires unused, due 90 days from the offer', () => {
    const open = addDays(AS_OF, -(NOTICE_POLICY.counterOfferValidDays - 1));
    expect(dueNotices(counter(open), AS_OF)).toEqual([]);
    const expired = addDays(AS_OF, -NOTICE_POLICY.counterOfferValidDays);
    expect(dueNotices(counter(expired), AS_OF)).toMatchObject([
      {
        kind: 'COUNTER_OFFER_NOT_ACCEPTED',
        actionOn: AS_OF,
        deadlineOn: addDays(expired, NOTICE_POLICY.counterOfferNoticeDays),
      },
    ]);
    // Taken up: a plan opened on it. Not adverse.
    expect(dueNotices(counter(expired, { hasFinancedPlan: true }), AS_OF)).toEqual([]);
  });

  it('keeps a counter offer the owner declined, even if a plan opens later', () => {
    const stored = {
      decisionId: 'dec1',
      kind: 'COUNTER_OFFER_NOT_ACCEPTED' as const,
      deliveredOn: AS_OF,
      deadlineOn: addDays(AS_OF, 90),
      respondBy: null,
    };
    expect(
      dueNotices(counter(AS_OF, { notices: [stored], hasFinancedPlan: true }), AS_OF),
    ).toMatchObject([{ kind: 'COUNTER_OFFER_NOT_ACCEPTED', stored }]);
  });

  it('asks an incomplete application, then closes it once the date to respond passes', () => {
    const decidedOn = addDays(AS_OF, -NOTICE_POLICY.incompleteNoticeAfterDays);
    const incomplete = (over: Partial<ApplicationNoticeFacts> = {}) =>
      facts({
        status: 'NEEDS_INFO',
        submittedOn: decidedOn,
        decision: { ...facts().decision!, outcome: 'NEEDS_INFO', decidedOn },
        ...over,
      });
    expect(dueNotices(incomplete(), addDays(AS_OF, -1))).toEqual([]);
    const [ask] = dueNotices(incomplete(), AS_OF);
    expect(ask).toMatchObject({
      kind: 'INCOMPLETE',
      actionOn: AS_OF,
      deadlineOn: addDays(decidedOn, 30),
      respondBy: addDays(AS_OF, NOTICE_POLICY.incompleteResponseDays),
    });
    // Not closed before the applicant was actually asked, however late it is.
    expect(dueNotices(incomplete(), addDays(AS_OF, 60)).map((d) => d.kind)).toEqual(['INCOMPLETE']);
    const asked = {
      decisionId: 'dec1',
      kind: 'INCOMPLETE' as const,
      deliveredOn: AS_OF,
      deadlineOn: ask!.deadlineOn,
      respondBy: ask!.respondBy,
    };
    const closeOn = addDays(ask!.respondBy!, 1);
    expect(dueNotices(incomplete({ notices: [asked] }), ask!.respondBy!)).toHaveLength(1);
    expect(dueNotices(incomplete({ notices: [asked] }), closeOn)).toMatchObject([
      { kind: 'INCOMPLETE', stored: asked },
      { kind: 'INCOMPLETE_DECLINED', actionOn: closeOn, deadlineOn: addDays(closeOn, 30) },
    ]);
  });
});

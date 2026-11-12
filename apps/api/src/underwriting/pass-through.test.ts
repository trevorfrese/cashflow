import { describe, expect, it } from 'vitest';

import { passThroughEligibility, snapshotKnockouts } from './pass-through.ts';

const neg = (code: string) => ({ code, impact: 'NEGATIVE' as const });

describe('passThroughEligibility', () => {
  it('offers pass-through to an engine decline for credit capacity', () => {
    const r = passThroughEligibility({
      outcome: 'DECLINED',
      kind: 'ENGINE',
      reasons: [neg('EXCESSIVE_OVERDRAFTS'), neg('RENT_EXCEEDS_REVENUE_SHARE'), neg('CASH_BUFFER')],
      knockouts: 0,
    });
    expect(r).toEqual({
      eligible: true,
      reason: null,
      capacityCodes: ['EXCESSIVE_OVERDRAFTS', 'RENT_EXCEEDS_REVENUE_SHARE'],
    });
  });

  it('never offers it on a trust decline, even with capacity reasons beside it', () => {
    for (const code of [
      'UNVERIFIED_DEPOSITS',
      'IDENTITY_NOT_VERIFIED',
      'ACCOUNT_OWNERSHIP_NOT_CONFIRMED',
      'ACCOUNT_HISTORY_NOT_VERIFIED',
      'LANDLORD_ACCOUNT_MATCH',
      'RENT_NOT_VERIFIED',
    ]) {
      expect(
        passThroughEligibility({
          outcome: 'DECLINED',
          kind: 'ENGINE',
          reasons: [neg(code), neg('SCORE_BELOW_MINIMUM')],
          knockouts: 0,
        }).reason,
      ).toBe('TRUST_DECLINE');
    }
    expect(
      passThroughEligibility({
        outcome: 'DECLINED',
        kind: 'ENGINE',
        reasons: [neg('SCORE_BELOW_MINIMUM')],
        knockouts: 1,
      }).reason,
    ).toBe('TRUST_DECLINE');
  });

  it('never offers it on a referral, an approval, a request for information, or a review', () => {
    for (const outcome of ['REFER', 'APPROVED', 'NEEDS_INFO'] as const) {
      expect(
        passThroughEligibility({ outcome, kind: 'ENGINE', reasons: [], knockouts: 0 }).reason,
      ).toBe('NOT_DECLINED');
    }
    expect(
      passThroughEligibility({
        outcome: 'DECLINED',
        kind: 'REVIEW',
        reasons: [neg('SCORE_BELOW_MINIMUM')],
        knockouts: 0,
      }).reason,
    ).toBe('REVIEWED');
  });

  it('needs a capacity reason', () => {
    expect(
      passThroughEligibility({
        outcome: 'DECLINED',
        kind: 'ENGINE',
        reasons: [neg('SOMETHING_ELSE')],
        knockouts: 0,
      }).reason,
    ).toBe('NO_CAPACITY_REASON');
  });
});

describe('snapshotKnockouts', () => {
  it('counts knockout integrity flags and veracity findings', () => {
    expect(snapshotKnockouts(null)).toBe(0);
    expect(
      snapshotKnockouts({
        integrityFlags: [{ action: 'KNOCKOUT' }, { action: 'REFER' }],
        veracity: { findings: [{ consequence: 'KNOCKOUT' }, { consequence: 'INFORM' }] },
      }),
    ).toBe(2);
  });
});

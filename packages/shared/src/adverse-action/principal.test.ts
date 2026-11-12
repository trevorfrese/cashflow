import { describe, expect, it } from 'vitest';

import type { DecisionReason } from '../schemas/underwriting';
import {
  principalReason,
  principalReasonsFromCodes,
  selectPrincipalReasons,
  type FactorPoints,
} from './principal';

const r = (code: string, impact: DecisionReason['impact'], message = `${code} text.`) => ({
  code,
  impact,
  message,
});
const f = (
  code: string,
  points: number,
  maxPoints: number,
  impact: FactorPoints['impact'],
): FactorPoints => ({
  code,
  points,
  maxPoints,
  impact,
});

const FACTORS: FactorPoints[] = [
  f('RENT_TO_REVENUE', 9, 10, 'POSITIVE'),
  f('CASH_FLOW_COVERAGE', 4, 15, 'NEGATIVE'),
  f('CASH_BUFFER', 3, 30, 'NEGATIVE'),
  f('ACCOUNT_CONDUCT', 0, 15, 'NEGATIVE'),
  f('REVENUE_STABILITY', 6, 10, 'INFO'),
  f('REVENUE_TREND', 7, 10, 'POSITIVE'),
  f('DEBT_LOAD', 5, 5, 'POSITIVE'),
  f('DATA_DEPTH', 4, 5, 'POSITIVE'),
];
const factorReasons = FACTORS.map((x) => r(x.code, x.impact));

describe('selectPrincipalReasons', () => {
  it('puts the rules that declined first, then the factors that lost the most points', () => {
    const out = selectPrincipalReasons({
      outcome: 'DECLINED',
      counterOffer: false,
      reasons: [
        r('TIME_IN_BUSINESS', 'NEGATIVE', 'We need at least 6 months in business. You reported 4.'),
        r('SCORE_BELOW_MINIMUM', 'NEGATIVE'),
        ...factorReasons,
      ],
      factors: FACTORS,
    });
    expect(out.map((x) => x.code)).toEqual([
      'TIME_IN_BUSINESS',
      'CASH_BUFFER',
      'ACCOUNT_CONDUCT',
      'CASH_FLOW_COVERAGE',
    ]);
    // The engine's specific text is kept; the catalog adds the title and guidance.
    expect(out[0]).toMatchObject({
      title: 'Time in business',
      text: 'We need at least 6 months in business. You reported 4.',
    });
    expect(out[0]!.guidance.length).toBeGreaterThan(10);
  });

  it('never lists the score itself, and does not repeat a factor a rule restates', () => {
    const out = selectPrincipalReasons({
      outcome: 'DECLINED',
      counterOffer: false,
      reasons: [
        r('EXCESSIVE_OVERDRAFTS', 'NEGATIVE'),
        r('SCORE_BELOW_MINIMUM', 'NEGATIVE'),
        ...factorReasons,
      ],
      factors: FACTORS,
    });
    expect(out.map((x) => x.code)).toEqual([
      'EXCESSIVE_OVERDRAFTS',
      'CASH_BUFFER',
      'CASH_FLOW_COVERAGE',
      'REVENUE_STABILITY',
    ]);
  });

  it('caps at four and is deterministic on ties', () => {
    const tied = FACTORS.map((x) => ({
      ...x,
      points: 0,
      impact: 'NEGATIVE' as const,
      maxPoints: 10,
    }));
    const args = {
      outcome: 'DECLINED' as const,
      counterOffer: false,
      reasons: [r('SCORE_BELOW_MINIMUM', 'NEGATIVE'), ...factorReasons],
      factors: tied,
    };
    const a = selectPrincipalReasons(args);
    expect(a.map((x) => x.code)).toEqual([
      'RENT_TO_REVENUE',
      'CASH_FLOW_COVERAGE',
      'CASH_BUFFER',
      'ACCOUNT_CONDUCT',
    ]);
    expect(selectPrincipalReasons({ ...args, factors: [...tied].reverse() })).toEqual(a);
  });

  it('explains a counter offer with the cap first and only the factors hurting', () => {
    const out = selectPrincipalReasons({
      outcome: 'APPROVED',
      counterOffer: true,
      reasons: [r('LIMIT_BELOW_REQUEST', 'INFO', 'Approved for up to $4,000.'), ...factorReasons],
      factors: FACTORS,
    });
    expect(out.map((x) => x.code)).toEqual([
      'LIMIT_BELOW_REQUEST',
      'CASH_BUFFER',
      'ACCOUNT_CONDUCT',
      'CASH_FLOW_COVERAGE',
    ]);
    expect(out[0]!.text).toBe('Approved for up to $4,000.');
  });

  it('gives nothing for an approval at the rent requested or a referral', () => {
    for (const outcome of ['APPROVED', 'REFER'] as const) {
      expect(
        selectPrincipalReasons({ outcome, counterOffer: false, reasons: factorReasons }),
      ).toEqual([]);
    }
  });

  it('lists what is missing on a request for information', () => {
    const out = selectPrincipalReasons({
      outcome: 'NEEDS_INFO',
      counterOffer: false,
      reasons: [r('BANK_LINK_REQUIRED', 'INFO', 'Connect your bank.')],
    });
    expect(out).toEqual([
      expect.objectContaining({ code: 'BANK_LINK_REQUIRED', text: 'Connect your bank.' }),
    ]);
  });

  it('orders factors without points by impact when the points were not kept', () => {
    const out = selectPrincipalReasons({
      outcome: 'DECLINED',
      counterOffer: false,
      reasons: [r('SCORE_BELOW_MINIMUM', 'NEGATIVE'), ...factorReasons],
    });
    expect(out.map((x) => x.code)).toEqual([
      'CASH_FLOW_COVERAGE',
      'CASH_BUFFER',
      'ACCOUNT_CONDUCT',
      'REVENUE_STABILITY',
    ]);
  });

  it('always gives a decline at least one specific reason', () => {
    const out = selectPrincipalReasons({
      outcome: 'DECLINED',
      counterOffer: false,
      reasons: [r('SCORE_BELOW_MINIMUM', 'NEGATIVE'), ...FACTORS.map((x) => r(x.code, 'POSITIVE'))],
      factors: FACTORS.map((x) => ({ ...x, points: x.maxPoints, impact: 'POSITIVE' as const })),
    });
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('principal reasons from a reviewer', () => {
  it('uses the specific text from the decision when the code is on it', () => {
    const out = principalReasonsFromCodes(
      ['CASH_BUFFER', 'LEASE_NOT_VERIFIED', 'CASH_BUFFER'],
      [r('CASH_BUFFER', 'NEGATIVE', '3 days of expenses on hand.')],
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.text).toBe('3 days of expenses on hand.');
    expect(out[1]!.text).toBe('We could not verify the lease or the rent on it.');
  });

  it('refuses a code the catalog does not know', () => {
    expect(() => principalReason('NOT_A_REASON')).toThrow(/not in the reason catalog/);
  });
});

import { describe, expect, it } from 'vitest';

import { decide, type EngineResult } from '../underwriting/engine.ts';
import { CURRENT_POLICY } from '../underwriting/policy.ts';
import { account, engineInput } from '../underwriting/test-support.ts';
import {
  DETERIORATION_CODES,
  freezePrincipalReasons,
  isTrustReason,
  timeInBusinessAt,
  TRUST_CODES,
  watchReason,
} from './reunderwriting.ts';

const approved = decide(engineInput(account()), CURRENT_POLICY);
const reason = (code: string) => ({
  code,
  message: `${code} happened`,
  impact: 'NEGATIVE' as const,
});
const declinedFor = (code: string): EngineResult => ({
  ...approved,
  outcome: 'DECLINED',
  reasons: [reason(code), ...approved.reasons],
});
const withFinding = (result: EngineResult, code: string): EngineResult => ({
  ...result,
  snapshot: {
    ...result.snapshot,
    veracity: {
      ...(result.snapshot.veracity ?? ({} as NonNullable<EngineResult['snapshot']['veracity']>)),
      findings: [{ code, consequence: 'REFER' } as never],
    },
  },
});

describe('periodic review: what freezes the next period', () => {
  it('leaves a healthy review alone', () => {
    expect(approved.outcome).toBe('APPROVED');
    expect(watchReason(approved, CURRENT_POLICY)).toBeNull();
  });

  it('freezes on a deterioration, as before', () => {
    expect(watchReason(declinedFor('EXCESSIVE_OVERDRAFTS'), CURRENT_POLICY)).toBe(
      'EXCESSIVE_OVERDRAFTS',
    );
    expect(isTrustReason('EXCESSIVE_OVERDRAFTS')).toBe(false);
  });

  it('freezes on a trust decline: rewritten bank history, accounts not the business, round trips', () => {
    for (const code of TRUST_CODES) {
      expect(DETERIORATION_CODES.has(code)).toBe(false);
      expect(watchReason(declinedFor(code), CURRENT_POLICY)).toBe(code);
      expect(isTrustReason(code)).toBe(true);
    }
    // Trust comes first, whatever else the decline says.
    const both: EngineResult = {
      ...declinedFor('REVENUE_DECLINING'),
      reasons: [reason('REVENUE_DECLINING'), reason('ACCOUNT_HISTORY_NOT_VERIFIED')],
    };
    expect(watchReason(both, CURRENT_POLICY)).toBe('ACCOUNT_HISTORY_NOT_VERIFIED');
  });

  it('freezes on rewritten sales history even when the engine only referred, and with no score', () => {
    const referred = withFinding({ ...approved, outcome: 'REFER' }, 'SALES_HISTORY_CHANGED');
    expect(watchReason(referred, CURRENT_POLICY)).toBe('SALES_HISTORY_CHANGED');
    expect(watchReason({ ...referred, score: null }, CURRENT_POLICY)).toBe('SALES_HISTORY_CHANGED');
    expect(isTrustReason('SALES_HISTORY_CHANGED')).toBe(true);
    // A minor change is not a rewrite.
    expect(watchReason(withFinding(approved, 'HISTORY_MINOR_CHANGES'), CURRENT_POLICY)).toBeNull();
  });

  it('gives the owner catalog reasons for the freeze', () => {
    expect(
      freezePrincipalReasons(
        withFinding(approved, 'SALES_HISTORY_CHANGED'),
        'SALES_HISTORY_CHANGED',
      ).map((r) => r.code),
    ).toEqual(['SALES_HISTORY_NOT_VERIFIED']);
    expect(
      freezePrincipalReasons(declinedFor('HISTORY_REWRITTEN'), 'HISTORY_REWRITTEN').map(
        (r) => r.code,
      ),
    ).toEqual(['ACCOUNT_HISTORY_NOT_VERIFIED']);
    const credit = freezePrincipalReasons(
      declinedFor('EXCESSIVE_OVERDRAFTS'),
      'EXCESSIVE_OVERDRAFTS',
    );
    expect(credit[0]!.code).toBe('EXCESSIVE_OVERDRAFTS');
    expect(credit[0]!.text).toBe('EXCESSIVE_OVERDRAFTS happened');
    expect(credit.length).toBeLessThanOrEqual(4);
  });
});

describe('periodic review: time in business', () => {
  it('moves on with the calendar from what was stated at application', () => {
    const application = {
      timeInBusinessMonths: 5,
      submittedAt: new Date('2026-03-20T12:00:00.000Z'),
      createdAt: new Date('2026-03-01T12:00:00.000Z'),
    };
    expect(timeInBusinessAt(application, '2026-03-31')).toBe(5);
    expect(timeInBusinessAt(application, '2026-09-01')).toBe(11);
    expect(timeInBusinessAt(application, '2027-03-20')).toBe(17);
    // Without a submission date, from when the application was created.
    expect(timeInBusinessAt({ ...application, submittedAt: null }, '2026-05-01')).toBe(7);
  });
});

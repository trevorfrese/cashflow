import { describe, expect, it } from 'vitest';

import { CIRCUIT_BREAKER_TRIGGER, decide, referTriggers } from './engine.ts';
import { checkContext, type IdentityFacts } from './integrity.ts';
import { POLICY_V2 } from './policy.ts';
import { account, engineInput } from './test-support.ts';

/**
 * Identity, screening, and the circuit breaker as the engine sees them: facts the service
 * looked up, handed in beside the other integrity inputs. The engine itself stays pure.
 */

const identity = (over: Partial<IdentityFacts> = {}): IdentityFacts => ({
  verification: 'VERIFIED',
  verificationReasons: [],
  screening: 'CLEAR',
  openHits: 0,
  ...over,
});

const decideWith = (facts: IdentityFacts | undefined, approvalsPaused = false) =>
  decide({
    ...engineInput(account()),
    integrityContext: facts ? { identity: facts } : {},
    controls: { approvalsPaused },
  });

describe('identity and screening flags', () => {
  it('raises nothing for a verified business with clear screening, or when not checked', () => {
    expect(checkContext({ identity: identity() })).toEqual([]);
    expect(checkContext({})).toEqual([]);
  });

  it('maps each state to one flag and one action', () => {
    const codes = (facts: IdentityFacts) =>
      checkContext({ identity: facts }).map((f) => [f.code, f.action]);
    expect(
      codes(identity({ verification: 'REVIEW', verificationReasons: ['TAX_ID_MISMATCH'] })),
    ).toEqual([['IDENTITY_NOT_VERIFIED', 'REFER']]);
    expect(codes(identity({ verification: 'UNVERIFIED' }))).toEqual([
      ['IDENTITY_NOT_VERIFIED', 'REFER'],
    ]);
    expect(codes(identity({ verification: 'FAILED' }))).toEqual([
      ['IDENTITY_VERIFICATION_FAILED', 'KNOCKOUT'],
    ]);
    expect(codes(identity({ screening: 'POSSIBLE_MATCH', openHits: 1 }))).toEqual([
      ['SCREENING_POSSIBLE_MATCH', 'REFER'],
    ]);
    expect(codes(identity({ screening: 'MATCH', openHits: 2 }))).toEqual([
      ['SCREENING_MATCH', 'REFER'],
    ]);
  });
});

describe('what identity does to a decision that would otherwise be approved', () => {
  it('approves a verified, clear business on its own', () => {
    expect(decideWith(identity()).outcome).toBe('APPROVED');
    expect(decideWith(undefined).outcome).toBe('APPROVED');
  });

  it('refers a business that needs review, with the specific trigger and the terms it would have had', () => {
    const result = decideWith(identity({ verification: 'REVIEW', verificationReasons: ['X'] }));
    expect(result.outcome).toBe('REFER');
    expect(result.snapshot.referTriggers).toEqual(['INTEGRITY:IDENTITY_NOT_VERIFIED']);
    expect(result.snapshot.recommendation.outcome).toBe('APPROVED');
    // The applicant is told it is in review, and nothing about why.
    expect(result.reasons[0]!.code).toBe('IN_REVIEW');
    expect(result.reasons.map((r) => r.code).join(' ')).not.toMatch(/IDENTITY/);
    expect(result.reasons[0]!.message).not.toMatch(/identity|verif/i);
  });

  it('refers a possible match and a match, and says nothing about screening to the applicant', () => {
    for (const screening of ['POSSIBLE_MATCH', 'MATCH'] as const) {
      const result = decideWith(identity({ screening, openHits: 1 }));
      expect(result.outcome).toBe('REFER');
      expect(result.snapshot.referTriggers).toEqual([`INTEGRITY:SCREENING_${screening}`]);
      expect(JSON.stringify(result.reasons)).not.toMatch(/sanction|watchlist|screen|match/i);
    }
  });

  it('declines a failed verification with a reason the applicant can act on', () => {
    const result = decideWith(identity({ verification: 'FAILED', verificationReasons: ['X'] }));
    expect(result.outcome).toBe('DECLINED');
    expect(result.reasons[0]!.code).toBe('IDENTITY_NOT_VERIFIED');
    expect(result.reasons[0]!.message).toMatch(/contact support/i);
  });

  it('never approves anything but a verified, clear business', () => {
    for (const verification of ['REVIEW', 'FAILED', 'UNVERIFIED'] as const) {
      for (const screening of ['CLEAR', 'POSSIBLE_MATCH', 'MATCH'] as const) {
        expect(decideWith(identity({ verification, screening, openHits: 1 })).outcome).not.toBe(
          'APPROVED',
        );
      }
    }
  });
});

describe('the circuit breaker', () => {
  const clean = {
    flags: [],
    score: 90,
    limitCents: 300_000,
    requestedCents: 300_000,
    firstPlan: true,
  };

  it('adds a trigger only while approvals are paused', () => {
    expect(referTriggers(POLICY_V2, clean)).toEqual([]);
    expect(referTriggers(POLICY_V2, { ...clean, approvalsPaused: true })).toEqual([
      CIRCUIT_BREAKER_TRIGGER,
    ]);
  });

  it('refers what would have been approved, and leaves the recommendation for the reviewer', () => {
    const result = decideWith(identity(), true);
    expect(result.outcome).toBe('REFER');
    expect(result.snapshot.referTriggers).toEqual([CIRCUIT_BREAKER_TRIGGER]);
    expect(result.snapshot.recommendation).toMatchObject({ outcome: 'APPROVED' });
  });

  it('does not turn a decline into a referral', () => {
    const declined = decide({
      ...engineInput(account()),
      timeInBusinessMonths: 1,
      controls: { approvalsPaused: true },
    });
    expect(declined.outcome).toBe('DECLINED');
  });
});

import { describe, expect, it } from 'vitest';

import { decideWithRules } from './mock';

const base = {
  statedMonthlyRevenueCents: 4_000_000, // $40,000
  timeInBusinessMonths: 36,
  requestedMonthlyRentCents: 600_000, // $6,000 = 15%
  bankLink: { availableBalanceCents: 1_500_000 },
};

describe('mock underwriting rules', () => {
  it('asks for a bank link before anything else', () => {
    const r = decideWithRules({ ...base, timeInBusinessMonths: 2, bankLink: null });
    expect(r.outcome).toBe('NEEDS_INFO');
    expect(r.reasons.map((x) => x.code)).toEqual(['BANK_LINK_REQUIRED']);
  });

  it('approves a healthy business with a tenure-based fee', () => {
    const r = decideWithRules(base);
    expect(r.outcome).toBe('APPROVED');
    expect(r.approvedMonthlyLimitCents).toBe(1_000_000); // 25% of revenue
    expect(r.feeBps).toBe(250); // 24..59 months
  });

  it('prices by tenure', () => {
    expect(decideWithRules({ ...base, timeInBusinessMonths: 12 }).feeBps).toBe(300);
    expect(decideWithRules({ ...base, timeInBusinessMonths: 24 }).feeBps).toBe(250);
    expect(decideWithRules({ ...base, timeInBusinessMonths: 72 }).feeBps).toBe(200);
  });

  it('declines for short tenure', () => {
    const r = decideWithRules({ ...base, timeInBusinessMonths: 8 });
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons.map((x) => x.code)).toContain('TIME_IN_BUSINESS');
  });

  it('declines when rent is too large a share of revenue', () => {
    const r = decideWithRules({ ...base, requestedMonthlyRentCents: 1_200_000 }); // 30%
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons.map((x) => x.code)).toContain('RENT_TO_REVENUE');
  });

  it('declines on a low bank balance and can stack reasons', () => {
    const r = decideWithRules({
      ...base,
      timeInBusinessMonths: 6,
      bankLink: { availableBalanceCents: 100_000 },
    });
    expect(r.outcome).toBe('DECLINED');
    expect(r.reasons.map((x) => x.code).sort()).toEqual(['LOW_BALANCE', 'TIME_IN_BUSINESS']);
  });

  it('tolerates an unknown balance', () => {
    const r = decideWithRules({ ...base, bankLink: { availableBalanceCents: null } });
    expect(r.outcome).toBe('APPROVED');
  });

  it('handles zero revenue without dividing by zero', () => {
    const r = decideWithRules({ ...base, statedMonthlyRevenueCents: 0 });
    expect(r.outcome).toBe('DECLINED');
  });
});

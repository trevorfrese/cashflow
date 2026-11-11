import type { BankTransaction } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';
import { describe, expect, it } from 'vitest';

import {
  checkAccountHistory,
  checkContext,
  checkDepositMatch,
  checkNonSalesCredits,
  checkObservedRent,
  checkOwnerTopUps,
  checkRevenueSpike,
  checkRoundTrips,
  checkStatedRevenue,
  findRoundTrips,
  INTEGRITY_CODES,
  INTEGRITY_RULES,
  landlordIsApplicant,
  runIntegrityChecks,
} from './integrity.ts';
import { POLICY_V2 } from './policy.ts';
import { account, AS_OF, cleanSummary, tx } from './test-support.ts';

const policy = POLICY_V2.integrity!;
const stated = (statedCents: number, verifiedCents = 3_000_000) =>
  checkStatedRevenue(
    {
      summary: {
        ...cleanSummary,
        verifiedMonthlyRevenueCents: verifiedCents,
        statedRevenueVarianceBps: Math.round(
          ((statedCents - verifiedCents) * 10_000) / verifiedCents,
        ),
      },
      statedMonthlyRevenueCents: statedCents,
      maxStatedRevenueVarianceBps: POLICY_V2.maxStatedRevenueVarianceBps,
    },
    policy,
  );

describe('the action table', () => {
  it('gives every flag a severity, an action, and a reason', () => {
    for (const code of INTEGRITY_CODES) {
      const rule = INTEGRITY_RULES[code];
      expect(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).toContain(rule.severity);
      expect(['KNOCKOUT', 'NEEDS_INFO', 'REFER', 'CAP', 'INFORM']).toContain(rule.action);
      expect(rule.why.length).toBeGreaterThan(20);
    }
    expect(Object.keys(INTEGRITY_RULES).sort()).toEqual([...INTEGRITY_CODES].sort());
  });

  it('declines automatically only on the two patterns with no innocent reading, and on a failed identity check', () => {
    const knockouts = INTEGRITY_CODES.filter((c) => INTEGRITY_RULES[c].action === 'KNOCKOUT');
    expect(knockouts.sort()).toEqual([
      'IDENTITY_VERIFICATION_FAILED',
      'LANDLORD_IS_APPLICANT_ACCOUNT',
      'ROUND_TRIP_DEPOSITS',
    ]);
  });

  it('never declines on a screening hit: a match is held in review, not announced', () => {
    expect(INTEGRITY_RULES.SCREENING_MATCH.action).toBe('REFER');
    expect(INTEGRITY_RULES.SCREENING_POSSIBLE_MATCH.action).toBe('REFER');
    expect(INTEGRITY_RULES.IDENTITY_NOT_VERIFIED.action).toBe('REFER');
  });
});

describe('stated versus verified revenue', () => {
  it('is quiet when the two are close', () => {
    expect(stated(3_300_000)).toBeNull();
    expect(stated(2_500_000)).toBeNull();
  });

  it('informs when stated is moderately above verified', () => {
    expect(stated(3_900_000)).toMatchObject({
      code: 'STATED_REVENUE_ABOVE_VERIFIED',
      action: 'INFORM',
    });
  });

  it('asks for information when stated is far above verified', () => {
    expect(stated(4_600_000)).toMatchObject({
      code: 'STATED_REVENUE_FAR_ABOVE_VERIFIED',
      action: 'NEEDS_INFO',
    });
  });

  it('flags stated far below verified', () => {
    expect(stated(1_700_000)).toMatchObject({ code: 'STATED_REVENUE_BELOW_VERIFIED' });
    expect(stated(1_900_000)).toBeNull();
  });
});

describe('point of sale versus bank deposits', () => {
  const withMatch = (depositMatchBps: number | null) =>
    checkDepositMatch(
      {
        summary: {
          ...cleanSummary,
          commerce: {
            platform: 'SQUARE',
            monthsOfHistory: 12,
            monthsOnPlatform: 12,
            verifiedMonthlySalesCents: 3_000_000,
            salesDaysPerMonth: 26,
            refundRateBps: 0,
            chargebackRateBps: 0,
            trendBps: 0,
            volatilityBps: 500,
            depositMatchBps,
          },
        },
        minDepositMatchBps: POLICY_V2.minDepositMatchBps,
      },
      policy,
    );

  it('is quiet when deposits and sales agree, or there is nothing to compare', () => {
    expect(withMatch(9800)).toBeNull();
    expect(withMatch(null)).toBeNull();
    expect(
      checkDepositMatch({ summary: cleanSummary, minDepositMatchBps: 7000 }, policy),
    ).toBeNull();
  });

  it('informs on a shortfall and refers on an excess', () => {
    expect(withMatch(5000)).toMatchObject({ code: 'POS_DEPOSIT_SHORTFALL', action: 'INFORM' });
    expect(withMatch(18_000)).toMatchObject({ code: 'POS_DEPOSIT_EXCESS', action: 'REFER' });
  });
});

/** `count` weekly credits of `cents`, each followed two days later by a transfer out. */
function roundTrips(count: number, cents: number, transferCents = cents): BankTransaction[] {
  const out: BankTransaction[] = [];
  for (let i = 0; i < count; i++) {
    const day = addDays(AS_OF, -(5 + i * 7));
    out.push(tx(day, cents, 'INVOICE_PAYMENT'));
    out.push(tx(addDays(day, 2), -transferCents, 'TRANSFER_OUT'));
  }
  return out;
}

describe('round tripping', () => {
  it('finds nothing in an ordinary account', () => {
    const transactions = account();
    expect(findRoundTrips(transactions, AS_OF, policy.roundTrip)).toEqual([]);
    expect(checkRoundTrips({ transactions, asOf: AS_OF }, policy)).toBeNull();
  });

  it('pairs each credit with one transfer of the same size within the window', () => {
    const transactions = [...account(), ...roundTrips(4, 500_000)];
    const matches = findRoundTrips(transactions, AS_OF, policy.roundTrip);
    expect(matches).toHaveLength(4);
    expect(new Set(matches.map((m) => m.transferId)).size).toBe(4);
  });

  it('knocks out on a repeated pattern that is a material share of sales credits', () => {
    // Eight credits of $5,000 against about $90,000 of sales in 90 days.
    const transactions = [...account(), ...roundTrips(8, 500_000)];
    expect(checkRoundTrips({ transactions, asOf: AS_OF }, policy)).toMatchObject({
      code: 'ROUND_TRIP_DEPOSITS',
      action: 'KNOCKOUT',
      severity: 'CRITICAL',
    });
  });

  it('refers on two matches, and lets a single one go', () => {
    const two = [...account(), ...roundTrips(2, 500_000)];
    expect(checkRoundTrips({ transactions: two, asOf: AS_OF }, policy)).toMatchObject({
      code: 'ROUND_TRIP_SUSPECTED',
      action: 'REFER',
    });
    const one = [...account(), ...roundTrips(1, 500_000)];
    expect(checkRoundTrips({ transactions: one, asOf: AS_OF }, policy)).toBeNull();
  });

  it('does not match a transfer of a different size, or one that comes too late', () => {
    const different = [...account(), ...roundTrips(6, 500_000, 350_000)];
    expect(findRoundTrips(different, AS_OF, policy.roundTrip)).toEqual([]);
    const late: BankTransaction[] = [
      ...account(),
      tx(addDays(AS_OF, -40), 500_000, 'INVOICE_PAYMENT'),
      tx(addDays(AS_OF, -40 + policy.roundTrip.windowDays + 1), -500_000, 'TRANSFER_OUT'),
    ];
    expect(findRoundTrips(late, AS_OF, policy.roundTrip)).toEqual([]);
  });

  it('ignores small amounts', () => {
    const small = [...account(), ...roundTrips(8, policy.roundTrip.minAmountCents - 1)];
    expect(findRoundTrips(small, AS_OF, policy.roundTrip)).toEqual([]);
  });
});

describe('non sales credits and owner top ups', () => {
  it('refers when transfers in are a large share of credits', () => {
    const quiet = account();
    expect(checkNonSalesCredits({ transactions: quiet, asOf: AS_OF }, policy)).toBeNull();
    // About $90,000 of sales in 90 days. $50,000 of transfers in is over 30% of all credits.
    const funded = [
      ...quiet,
      tx(addDays(AS_OF, -60), 2_500_000, 'TRANSFER_IN'),
      tx(addDays(AS_OF, -20), 2_500_000, 'LOAN_PROCEEDS'),
    ];
    expect(checkNonSalesCredits({ transactions: funded, asOf: AS_OF }, policy)).toMatchObject({
      code: 'NON_SALES_CREDIT_SHARE',
      action: 'REFER',
    });
  });

  it('informs on owner money moved in shortly before applying', () => {
    const base = { asOf: AS_OF, summary: cleanSummary };
    expect(checkOwnerTopUps({ ...base, transactions: account() }, policy)).toBeNull();
    const topUp = [...account(), tx(addDays(AS_OF, -5), 600_000, 'TRANSFER_IN')];
    expect(checkOwnerTopUps({ ...base, transactions: topUp }, policy)).toMatchObject({
      code: 'OWNER_TOP_UPS_BEFORE_APPLYING',
      action: 'INFORM',
    });
  });

  it('does not flag transfers that are a steady habit rather than a burst', () => {
    const steady = [
      ...account(),
      tx(addDays(AS_OF, -80), 600_000, 'TRANSFER_IN'),
      tx(addDays(AS_OF, -50), 600_000, 'TRANSFER_IN'),
      tx(addDays(AS_OF, -40), 600_000, 'TRANSFER_IN'),
      tx(addDays(AS_OF, -5), 600_000, 'TRANSFER_IN'),
    ];
    expect(
      checkOwnerTopUps({ asOf: AS_OF, summary: cleanSummary, transactions: steady }, policy),
    ).toBeNull();
  });
});

describe('revenue spike', () => {
  const base = { asOf: AS_OF };
  it('is quiet on level revenue', () => {
    expect(
      checkRevenueSpike({ ...base, transactions: account(), summary: cleanSummary }, policy),
    ).toBeNull();
  });

  it('refers when the last six weeks jump and last year does not explain it', () => {
    const spiked = account({ dailySalesCents: (ago) => (ago < 42 ? 250_000 : 100_000) });
    const summary = {
      ...cleanSummary,
      revenueTrend: { ...cleanSummary.revenueTrend!, yearOverYearBps: 15_000 },
    };
    expect(checkRevenueSpike({ ...base, transactions: spiked, summary }, policy)).toMatchObject({
      code: 'REVENUE_SPIKE',
      action: 'REFER',
    });
  });

  it('is quiet when the same weeks were just as strong a year ago', () => {
    const seasonal = account({ dailySalesCents: (ago) => (ago < 42 ? 250_000 : 100_000) });
    // Level with last year: the jump over the prior months is the season.
    expect(
      checkRevenueSpike({ ...base, transactions: seasonal, summary: cleanSummary }, policy),
    ).toBeNull();
  });

  it('needs half a year of history to judge', () => {
    const short = account({ days: 120, dailySalesCents: (ago) => (ago < 42 ? 250_000 : 100_000) });
    expect(
      checkRevenueSpike({ ...base, transactions: short, summary: cleanSummary }, policy),
    ).toBeNull();
  });
});

describe('account history versus time in business', () => {
  it('refers when the account is much younger than the business says it is', () => {
    const transactions = account({ days: 220 });
    expect(
      checkAccountHistory({ transactions, asOf: AS_OF, timeInBusinessMonths: 48 }, policy),
    ).toMatchObject({ code: 'SHORT_ACCOUNT_HISTORY', action: 'REFER' });
  });

  it('is quiet when history covers the business, or the year we ask for', () => {
    expect(
      checkAccountHistory(
        { transactions: account({ days: 220 }), asOf: AS_OF, timeInBusinessMonths: 8 },
        policy,
      ),
    ).toBeNull();
    expect(
      checkAccountHistory(
        { transactions: account({ days: 365 }), asOf: AS_OF, timeInBusinessMonths: 120 },
        policy,
      ),
    ).toBeNull();
  });
});

describe('requested rent versus observed rent', () => {
  const rent = (requested: number, observed: number | null, leaseVerified = false) =>
    checkObservedRent(
      {
        summary: { ...cleanSummary, observedRentCents: observed },
        requestedMonthlyRentCents: requested,
        context: { leaseVerified },
      },
      policy,
    );

  it('is quiet when the request is close to what the account pays', () => {
    expect(rent(300_000, 300_000)).toBeNull();
    expect(rent(360_000, 300_000)).toBeNull();
  });

  it('caps a request well above observed rent', () => {
    expect(rent(900_000, 300_000)).toMatchObject({
      code: 'RENT_ABOVE_OBSERVED',
      action: 'CAP',
      metrics: { multipleBps: 30_000 },
    });
  });

  it('refers when no rent is observed at all', () => {
    expect(rent(300_000, null)).toMatchObject({ code: 'NO_RENT_OBSERVED', action: 'REFER' });
  });

  it('stands down once a reviewer has verified the lease', () => {
    expect(rent(900_000, 300_000, true)).toBeNull();
    expect(rent(300_000, null, true)).toBeNull();
  });
});

describe('lookups supplied by the service', () => {
  it('raises nothing when nothing was checked or nothing was found', () => {
    expect(checkContext(null)).toEqual([]);
    expect(checkContext({})).toEqual([]);
    expect(
      checkContext({
        landlordAccountIsApplicantAccount: false,
        otherBusinessesWithSameLandlordAccount: 0,
        otherBusinessesWithSameBankAccount: 0,
        otherBusinessesWithSameIdentity: 0,
      }),
    ).toEqual([]);
  });

  it('knocks out a landlord account that is the applicant own account', () => {
    expect(checkContext({ landlordAccountIsApplicantAccount: true })).toEqual([
      expect.objectContaining({ code: 'LANDLORD_IS_APPLICANT_ACCOUNT', action: 'KNOCKOUT' }),
    ]);
  });

  it('refers duplicates of a bank account or a business identity, and only notes a shared landlord', () => {
    const flags = checkContext({
      otherBusinessesWithSameLandlordAccount: 3,
      otherBusinessesWithSameBankAccount: 1,
      otherBusinessesWithSameIdentity: 2,
    });
    expect(flags.map((f) => [f.code, f.action])).toEqual([
      ['DUPLICATE_LANDLORD_ACCOUNT', 'INFORM'],
      ['DUPLICATE_BANK_ACCOUNT', 'REFER'],
      ['DUPLICATE_BUSINESS_IDENTITY', 'REFER'],
    ]);
  });

  it('recognizes a landlord account that belongs to the applicant', () => {
    const business = { legalName: 'Blue Door Bakery LLC', dba: 'Blue Door Bakery' };
    const links = [{ providerAccountToken: 'acct_1', accountMask: '4321' }];
    const lease = {
      landlordPayoutToken: 'landlord_tok',
      landlordAccountNumberLast4: '9999',
      landlordAccountHolderName: 'Harbor View Properties LLC',
    };
    expect(landlordIsApplicant(lease, links, business)).toBe(false);
    // Same destination token as the account we debit.
    expect(landlordIsApplicant({ ...lease, landlordPayoutToken: 'acct_1' }, links, business)).toBe(
      true,
    );
    // Same last four digits and the holder is the business itself.
    expect(
      landlordIsApplicant(
        {
          ...lease,
          landlordAccountNumberLast4: '4321',
          landlordAccountHolderName: 'blue door bakery, llc',
        },
        links,
        business,
      ),
    ).toBe(true);
    // Last four digits alone are a coincidence.
    expect(
      landlordIsApplicant({ ...lease, landlordAccountNumberLast4: '4321' }, links, business),
    ).toBe(false);
  });
});

describe('runIntegrityChecks', () => {
  it('returns no flags for a clean application', () => {
    const flags = runIntegrityChecks(
      {
        transactions: account(),
        asOf: AS_OF,
        summary: cleanSummary,
        statedMonthlyRevenueCents: 3_000_000,
        timeInBusinessMonths: 48,
        requestedMonthlyRentCents: 300_000,
        maxStatedRevenueVarianceBps: POLICY_V2.maxStatedRevenueVarianceBps,
        minDepositMatchBps: POLICY_V2.minDepositMatchBps,
      },
      policy,
    );
    expect(flags).toEqual([]);
  });
});

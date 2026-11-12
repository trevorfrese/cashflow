import type { ForwardParams } from '../providers/bank-link/business-sim.ts';
import { scenarioParams } from '../providers/bank-link/synthetic.ts';
import type { Applicant } from './population.ts';
import type { CustomerResult } from './portfolio.ts';

/** Hand built inputs for the eval unit tests. Not used by the evaluation itself. */

/** A steady $40,000 a month business paying $4,000 rent, with no hazards. */
export function healthyParams(overrides: Partial<ForwardParams> = {}): ForwardParams {
  return {
    ...scenarioParams('healthy'),
    monthlyRevenueCents: 4_000_000,
    rentCents: 400_000,
    annualGrowth: 0.05,
    costFlex: 0.5,
    ownerReserveCents: 1_000_000,
    overdraftLimitCents: 600_000,
    events: [],
    ...overrides,
  };
}

export function makeApplicant(
  overrides: Partial<Omit<Applicant, 'params'>> & { params?: Partial<ForwardParams> } = {},
): Applicant {
  const { params, ...rest } = overrides;
  return {
    id: 'a00000',
    seedHex: 'abcdef12',
    archetype: 'healthy',
    fraud: null,
    segment: 'healthy',
    industry: 'restaurant',
    arrivalMonth: 0,
    applicationDate: '2026-01-10',
    historyDays: 400,
    timeInBusinessMonths: 48,
    statedMonthlyRevenueCents: 4_000_000,
    requestedRentCents: 400_000,
    pos: null,
    latentHealth: 0,
    ...rest,
    params: healthyParams(params),
  };
}

export function makeCustomer(overrides: Partial<CustomerResult> = {}): CustomerResult {
  return {
    applicantId: 'c0',
    segment: 'healthy',
    fraud: null,
    industry: 'restaurant',
    arrivalMonth: 0,
    applicationDate: '2026-01-10',
    latentHealth: 0,
    outcome: 'APPROVED',
    engineOutcome: 'APPROVED',
    referred: false,
    fundingWaitMonths: 0,
    neverFunded: false,
    score: 80,
    grade: 'A',
    feeBps: 150,
    pdBps: null,
    expectedLossBps: null,
    approvedLimitCents: 500_000,
    requestedRentCents: 100_000,
    counterOffer: false,
    unusableCounterOffer: false,
    planRentCents: 100_000,
    installmentsPerMonth: 2,
    payoutCount: 0,
    payoutCents: 0,
    heldPayouts: 0,
    releasedPayouts: 0,
    cancelledPayouts: 0,
    principalCollectedCents: 0,
    feesCollectedCents: 0,
    chargedOffCents: 0,
    recoveredCents: 0,
    outstandingCents: 0,
    outstandingCentDays: 0,
    failedDebits: 0,
    deferredDebits: 0,
    manualPayments: 0,
    lateInstallments: 0,
    maxDaysPastDue: 0,
    firstPaymentDefault: false,
    bad: false,
    closedOn: null,
    veracityCodes: [],
    veracityEffect: null,
    outcomeWithoutVeracity: null,
    usableWithoutVeracity: null,
    veracityTags: [],
    graduated: false,
    passThroughMonths: 0,
    passThroughOnTimeMonths: 0,
    passThroughMissedMonths: 0,
    ...overrides,
  };
}

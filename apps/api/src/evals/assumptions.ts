import { BASELINE_SERVICING_POLICY } from '../servicing/policy.ts';

/**
 * Every economic and measurement assumption behind the portfolio evals, in one place.
 * Change a number here and the report, the gates, and `baseline.json` all move with it.
 */
export const ASSUMPTIONS = {
  /**
   * Cost of funds: 12% a year, charged on the principal outstanding each day (rent paid to
   * landlords and not yet repaid or written off). Typical for a warehouse line to a young
   * nonbank lender.
   */
  costOfFundsAprBps: 1200,

  /**
   * Servicing cost per plan per month in which a landlord payout goes out: $12.00. Built up
   * as roughly $1.50 of payment costs (one payout and two to four debits, plus the odd
   * retry), $1.50 for refreshing bank data, and $9 of support, collections, and operations
   * time. The average plan in the default run fronts about $4,300 of rent a month (median
   * about $3,400), so this comes to roughly 0.28% of volume. The measured figure is in the
   * report.
   */
  servicingCostCentsPerPlanMonth: 1200,

  /**
   * Recovery on written off principal. Lives on the servicing policy because better
   * collections work is a servicing choice; repeated here so all assumptions read in one
   * place. 10% is at the low end for unsecured small business credit with no personal
   * guarantee.
   */
  recoveryRateBps: BASELINE_SERVICING_POLICY.recoveryRateBps,

  /**
   * Measurement only: an installment still unpaid this many days past due when a plan's
   * observation ends is counted as a loss, whether or not the servicing policy ever writes
   * anything off.
   */
  measurementChargeOffDays: 90,

  /**
   * Manual review. A reviewer who is sent a referred application catches and declines this
   * share of fraud applicants, in basis points, and approves everything else at the terms
   * the engine recommended. 70% is an assumption, not a measurement: a reviewer who asks for
   * the lease and calls the landlord stops most staged applications, and misses some. Honest
   * applicants are unaffected, because the reviewer has no information about them that the
   * engine lacks.
   */
  reviewFraudCatchRateBps: 7000,

  /**
   * An approved plan the pool cannot take under the exposure rules waits and is tried again
   * on each of this many following rent dates. After that the applicant is counted as
   * approved but never funded.
   */
  maxFundingWaitMonths: 3,

  /** A plan is "bad" if any installment reaches this many days past due, or is written off. */
  badDaysPastDue: 30,

  /**
   * Capital pool for the default run of 2,000 applicants: $7,500,000. Other population sizes
   * scale it in proportion. All rent is due on the first and landlords are paid before the
   * day's installments are collected, so the pool must fund a whole month of payouts at once.
   * The planned book peaks near $5.8 million of payouts on one day (the report shows the
   * measured figure as "peak monthly payouts"), so this is the planned peak plus roughly 30%
   * headroom. The size was set from that rule after the first measurement of the peak, not
   * tuned to pass the pool gate.
   */
  poolSizeCents: 750_000_000,
  poolSizedForApplicants: 2000,

  /** Applications grow 10% a month over the arrival window. */
  monthlyGrowthBps: 1000,
  /** Months over which applications arrive. */
  arrivalMonths: 12,
  /** Rent periods each approved plan is played forward. */
  horizonMonths: 12,
  /**
   * Days each plan is observed after its last installment falls due, so that every
   * installment has had time to reach the write off age.
   */
  runoffDays: 95,

  /** First month of applications. Fixed so runs are reproducible. */
  startDate: '2026-01-01',
} as const;

export type Assumptions = { readonly [K in keyof typeof ASSUMPTIONS]: (typeof ASSUMPTIONS)[K] };

/** Pool size for a population of `n` applicants, scaled from the default. */
export function poolSizeFor(n: number): number {
  return Math.round((ASSUMPTIONS.poolSizeCents * n) / ASSUMPTIONS.poolSizedForApplicants);
}

/** A revenue shock applied to every business in the book at the same time. */
export interface StressScenario {
  name: 'base' | 'mild' | 'severe';
  /** Months after `startDate` at which the shock begins. */
  startMonth: number;
  days: number;
  /** Share of revenue lost while the shock lasts. 0.15 is a 15% drop. */
  depth: number;
}

/**
 * Stress presets. The shock starts halfway through the arrival window, so it hits plans
 * already on the book and also shows up in the bank history of later applicants.
 * Mild is a soft patch: revenue down 15% for six months. Severe is a recession: down 30% for
 * nine months.
 */
export const STRESS: Record<'mild' | 'severe', StressScenario> = {
  mild: { name: 'mild', startMonth: 6, days: 180, depth: 0.15 },
  severe: { name: 'severe', startMonth: 6, days: 270, depth: 0.3 },
};

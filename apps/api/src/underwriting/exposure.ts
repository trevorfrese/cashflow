import type { ExposurePolicy } from './policy.ts';

/**
 * Exposure rules: how much rent CashFlow will front for one business, and whether the pool
 * can take another plan right now.
 *
 * Pure functions. The caller gathers the state (what the business already has with us, what
 * its industry holds, what the pool looks like) and passes it in. The underwriting engine
 * calls these when it decides, `createRentPlan` calls them again when a plan is opened, and
 * the portfolio simulator calls them on its own in-memory state, so all three enforce the
 * same rules.
 *
 * "Committed" always means monthly rent on active plans. Under the servicing policy a plan
 * is never more than one rent period ahead of its repayments, so a plan's monthly rent is
 * its largest principal exposure.
 */

export interface PoolState {
  /** Cash in the pool available to fund payouts. */
  cashCents: number;
  /** Principal out with businesses and not yet repaid or written off. */
  receivableCents: number;
  /** Monthly rent committed across every active plan. */
  committedCents: number;
}

export interface ExposureContext {
  /** Monthly rent already committed on this business's active plans, across all leases. */
  businessCommittedCents: number;
  /** Rent periods this business has repaid in full without a late installment. */
  onTimePeriods: number;
  /** Monthly rent committed to active plans in the business's industry. */
  industryCommittedCents: number;
  /** Null when the caller has no pool to check against. Pool rules are then skipped. */
  pool: PoolState | null;
}

/** A brand new customer and no pool information. */
export const NO_EXPOSURE_CONTEXT: ExposureContext = {
  businessCommittedCents: 0,
  onTimePeriods: 0,
  industryCommittedCents: 0,
  pool: null,
};

export type LimitCap =
  'REQUEST' | 'CAPACITY' | 'OBSERVED_RENT' | 'LADDER' | 'BUSINESS_AGGREGATE' | 'SINGLE_NAME';

export interface LimitInput {
  requestedCents: number;
  /** Largest rent the cash flow supports, from the engine. */
  capacityCents: number;
  /** Rent seen in the bank account, or null when none was. */
  observedRentCents: number | null;
  /** A reviewer verified the lease, which lifts the observed rent cap. */
  leaseVerified?: boolean;
  /** Limits are rounded down to this increment. */
  incrementCents: number;
  context: ExposureContext;
}

export interface LimitResult {
  /** The approved monthly limit: the smallest cap, rounded down. Never negative. */
  limitCents: number;
  /** Every cap that applied, in cents, before rounding. */
  caps: Partial<Record<LimitCap, number>>;
  /** The cap that set the limit. */
  binding: LimitCap;
}

export function poolCapitalCents(pool: PoolState): number {
  return pool.cashCents + pool.receivableCents;
}

/** Largest total monthly rent the ladder allows a business with this record. */
export function ladderCapCents(policy: ExposurePolicy, onTimePeriods: number): number {
  let cap = policy.ladder[0]?.capCents ?? policy.maxBusinessExposureCents;
  for (const rung of policy.ladder) {
    if (onTimePeriods >= rung.afterOnTimePeriods) cap = rung.capCents;
  }
  return cap;
}

/**
 * The approved monthly limit for a new plan.
 *
 *   - never above the request: an approval is for the lease in front of us, not a credit line
 *   - never above what cash flow supports
 *   - at most a multiple of the rent seen in the account, unless the lease was verified
 *   - the ladder: a first plan cap that rises with on time periods
 *   - an aggregate cap per business across all its plans
 *
 * The ladder and aggregate caps are on the business's total, so what it already has
 * committed comes off them.
 *
 * These are credit rules: they depend on the business, never on how full the pool is. The
 * rules that depend on the pool (utilization, industry share, single name share) are in
 * `checkFunding`. Keeping the two apart means a small or empty pool makes a plan wait; it
 * never turns into a decline or a smaller limit.
 */
export function approvedLimit(policy: ExposurePolicy, input: LimitInput): LimitResult {
  const { context } = input;
  const caps: Partial<Record<LimitCap, number>> = {
    REQUEST: input.requestedCents,
    CAPACITY: input.capacityCents,
    LADDER: ladderCapCents(policy, context.onTimePeriods) - context.businessCommittedCents,
    BUSINESS_AGGREGATE: policy.maxBusinessExposureCents - context.businessCommittedCents,
  };
  if (input.observedRentCents !== null && input.observedRentCents > 0 && !input.leaseVerified) {
    caps.OBSERVED_RENT = Math.floor(
      (input.observedRentCents * policy.maxObservedRentMultipleBps) / 10_000,
    );
  }
  let binding: LimitCap = 'REQUEST';
  let lowest = Infinity;
  for (const [name, cap] of Object.entries(caps) as [LimitCap, number][]) {
    if (cap < lowest) {
      lowest = cap;
      binding = name;
    }
  }
  // The request is honored to the cent. Any other cap rounds down to the increment.
  const limitCents =
    binding === 'REQUEST'
      ? Math.max(0, lowest)
      : Math.max(0, Math.floor(lowest / input.incrementCents) * input.incrementCents);
  return { limitCents, caps, binding };
}

export type FundingBlocker = 'POOL_UTILIZATION' | 'INDUSTRY_CONCENTRATION' | 'SINGLE_NAME';

export interface FundingCheck {
  ok: boolean;
  blockers: FundingBlocker[];
  /** Committed rent including this plan, as a share of pool capital, in basis points. */
  utilizationBps: number | null;
  /** The industry's committed rent including this plan, as a share of pool capital. */
  industryShareBps: number | null;
}

/**
 * Can the pool take a plan of `rentCents` a month right now.
 *
 * These are funding rules, not credit rules: failing one does not make the business less
 * creditworthy, it means the plan waits. An unknown pool (null) passes; an empty pool fails
 * on utilization.
 */
export function checkFunding(
  policy: ExposurePolicy,
  rentCents: number,
  context: ExposureContext,
): FundingCheck {
  const pool = context.pool;
  if (!pool) return { ok: true, blockers: [], utilizationBps: null, industryShareBps: null };
  const capital = poolCapitalCents(pool);
  const share = (cents: number) =>
    capital <= 0 ? Number.MAX_SAFE_INTEGER : Math.round((cents * 10_000) / capital);
  const utilizationBps = share(pool.committedCents + rentCents);
  const industryShareBps = share(context.industryCommittedCents + rentCents);
  const singleNameBps = share(context.businessCommittedCents + rentCents);
  const blockers: FundingBlocker[] = [];
  if (utilizationBps > policy.maxPoolUtilizationBps) blockers.push('POOL_UTILIZATION');
  if (industryShareBps > policy.maxIndustryShareBps) blockers.push('INDUSTRY_CONCENTRATION');
  if (singleNameBps > policy.maxSingleNameShareBps) blockers.push('SINGLE_NAME');
  return { ok: blockers.length === 0, blockers, utilizationBps, industryShareBps };
}

export interface PlanCheckInput {
  /** Monthly rent of the plan being opened. */
  rentCents: number;
  /** The limit on the current decision. */
  approvedLimitCents: number;
  observedRentCents: number | null;
  leaseVerified?: boolean;
  context: ExposureContext;
}

export type PlanRefusal =
  | { code: 'RENT_OVER_LIMIT'; message: string }
  | { code: 'EXPOSURE_CAP'; message: string; cap: LimitCap }
  | { code: 'FUNDING_UNAVAILABLE'; message: string; blockers: FundingBlocker[] };

/**
 * The checks `createRentPlan` runs, against the state on the day the plan is opened. A
 * decision can be weeks old by then: the business may have opened another plan, or the pool
 * may have filled up.
 */
export function checkNewPlan(policy: ExposurePolicy, input: PlanCheckInput): PlanRefusal | null {
  if (input.rentCents > input.approvedLimitCents) {
    return { code: 'RENT_OVER_LIMIT', message: 'Monthly rent exceeds the approved limit' };
  }
  const limit = approvedLimit(policy, {
    requestedCents: input.rentCents,
    capacityCents: input.approvedLimitCents,
    observedRentCents: input.observedRentCents,
    leaseVerified: input.leaseVerified,
    incrementCents: 1,
    context: input.context,
  });
  if (limit.limitCents < input.rentCents) {
    const messages: Record<LimitCap, string> = {
      REQUEST: 'Monthly rent exceeds the approved limit',
      CAPACITY: 'Monthly rent exceeds the approved limit',
      OBSERVED_RENT:
        'Monthly rent is well above the rent seen in the linked bank account. The lease needs to be verified first',
      LADDER:
        'Total monthly rent across plans is above what a business can hold at this point. The cap rises with on time rent periods',
      BUSINESS_AGGREGATE:
        'Total monthly rent across plans would exceed the maximum for one business',
      SINGLE_NAME: 'This plan would exceed the share of the capital pool one business may hold',
    };
    return { code: 'EXPOSURE_CAP', message: messages[limit.binding], cap: limit.binding };
  }
  const funding = checkFunding(policy, input.rentCents, input.context);
  if (!funding.ok) {
    return {
      code: 'FUNDING_UNAVAILABLE',
      message:
        'The capital pool cannot take this plan yet. Nothing is wrong with the application: the plan can start when capacity frees up',
      blockers: funding.blockers,
    };
  }
  return null;
}

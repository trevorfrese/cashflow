import type { CreditGrade, DecisionOutcome, IsoDate } from '@cashflow/shared';
import {
  addDays,
  buildInstallmentSchedule,
  followingDueDate,
  nextRentDueDate,
  parseIsoDate,
  toIsoDate,
} from '@cashflow/shared';

import {
  createForwardSimulation,
  type BusinessSimulation,
  type ExternalDebit,
} from '../providers/bank-link/business-sim.ts';
import { generateSalesFromPath } from '../providers/commerce/synthetic.ts';
import {
  balanceCoversDebit,
  BASELINE_SERVICING_POLICY,
  daysPastDue,
  delinquencyBucket,
  expectedRecoveryCents,
  isLate,
  OPEN_BUCKETS,
  payoutAction,
  shouldAttemptCollection,
  shouldChargeOff,
  shouldHoldPayout,
  type OpenBucket,
  type ServicingPolicy,
} from '../servicing/policy.ts';
import {
  passThroughSchedule,
  STANDARD_PASS_THROUGH_POLICY,
  type PassThroughPolicy,
} from '../servicing/pass-through.ts';
import { decide, type EngineInput, type EngineResult } from '../underwriting/engine.ts';
import { checkFunding, type ExposureContext } from '../underwriting/exposure.ts';
import { passThroughEligibility, snapshotKnockouts } from '../underwriting/pass-through.ts';
import {
  summarizePaymentHistory,
  type PaymentHistoryMonth,
} from '../underwriting/payment-history.ts';
import {
  CURRENT_POLICY,
  type ExposurePolicy,
  type GraduationPolicy,
} from '../underwriting/policy.ts';
import { ASSUMPTIONS, poolSizeFor, type StressScenario } from './assumptions.ts';
import type { Applicant, FraudType, Industry } from './population.ts';
import { hash32 } from './random.ts';
import { observe } from './veracity-sim.ts';

/**
 * Portfolio simulator.
 *
 * Walks a calendar one day at a time. On its application date each applicant's bank history
 * (and point of sale history, if connected) is built and handed to the real `decide()`. An
 * approval opens a plan: on every rent due date the landlord is paid in full from a finite
 * capital pool, and installments are then debited from the same simulated bank account the
 * history came from. A debit fails when the balance cannot cover it, so delinquency and loss
 * emerge from the business's cash, not from a label.
 *
 * Servicing follows the `ServicingPolicy` passed in, through the same functions the services
 * call, and in the order the jobs run each day: returns are reconciled, payouts are paid,
 * held, released, or cancelled, installments are debited (after the balance check, when the
 * policy has one), and then plans are aged and written off. A plan fronts the whole rent or
 * nothing, as `createRentPlan` does, unless `partialAdvance` is set.
 *
 * Pure and in memory: no database, no network, no clock.
 */

export type DecideFn = (input: EngineInput) => EngineResult;

export interface PortfolioConfig {
  /** Name used in reports, for example `base` or `challenger`. */
  label: string;
  decide: DecideFn;
  servicing: ServicingPolicy;
  /** Rent periods each approved plan is played forward. */
  horizonMonths: number;
  poolSizeCents: number;
  /** Revenue shock applied to the whole book, or null for the base case. */
  stress: StressScenario | null;
  /** First day of the arrival window. Anchors the stress dates. */
  startDate: IsoDate;
  /** Days each plan is observed after its last installment falls due. */
  runoffDays: number;
  /** Unpaid at least this many days past due at the end of observation is a loss. */
  measurementChargeOffDays: number;
  /** Days past due at which a plan is flagged bad. */
  badDaysPastDue: number;
  /**
   * How a human reviewer treats a referred application: this share of fraud applicants is
   * caught and declined, in basis points. Every other referral is approved at the terms the
   * engine recommended. The reviewer has no information the engine lacks about honest
   * applicants, so review neither helps nor hurts them here.
   */
  reviewFraudCatchRateBps: number;
  /**
   * Exposure rules applied when a plan is about to start: the pool utilization ceiling and
   * the industry and single name caps. A plan that fails waits and is tried again at the
   * next rent date, up to `maxWaitMonths`. Null (policy version 1) starts every plan. When
   * `decide` is replaced with another policy's engine, pass that policy's `exposure` too.
   */
  exposure: ExposurePolicy | null;
  maxWaitMonths: number;
  /**
   * What happens when the approved limit is below the rent requested. False is the product
   * as built: `createRentPlan` refuses a lease above the limit, so a counter offer cannot be
   * used and no plan opens. True fronts the limit while the business pays the rest of its
   * rent itself, which the product does not do. Reported both ways; the gated run is false.
   */
  partialAdvance: boolean;
  /**
   * Days until the bank returns a debit the account could not cover. Until then the debit
   * is booked as collected and the plan is treated as paid up, as in the services. 0 books
   * the failure on the day, which is how the services behaved before they handled returns.
   */
  returnDelayDays: number;
  /**
   * Manual payment after automatic collection has failed, or null for none (the gated
   * assumption). See `manualPaymentShareBps` in `assumptions.ts`.
   */
  manualPayment: { shareBps: number; firstDay: number; lastDay: number } | null;
  /**
   * Counterfactual "through the door" run, or null for a normal run (every gated and
   * comparison run). When set, the decision still comes from `decide` and is recorded as
   * usual, but it no longer chooses who gets a plan: every applicant the engine scored is
   * given one at the rent requested, whether approved, referred, countered, or declined.
   * The only purpose is to see who would have gone bad, so that the score can be judged on
   * the people it turned away as well as the people it let in. Use `runThroughTheDoor`,
   * which also lifts the pool and exposure limits. `fallbackFeeBps` is the fee for a
   * declined applicant the engine never priced.
   */
  throughTheDoor: { fallbackFeeBps: number } | null;
  /**
   * Decide without the veracity facts (the same observed data otherwise). Used only for the
   * counterfactual of applicants a veracity finding affected: how would they have done.
   */
  stripVeracity?: boolean;
  /**
   * The free pass-through plan and graduation, or null for a run without them (every
   * comparison configuration, the challengers and sensitivities, and every counterfactual).
   * See `PassThroughSimConfig`.
   */
  passThrough?: PassThroughSimConfig | null;
}

/**
 * Pass-through and graduation in the simulation. Every applicant the engine declines for
 * credit capacity (`passThroughEligibility`) starts a pass-through plan on the next rent date
 * it can still be collected for: the rent is debited `collectionLeadBusinessDays` before the
 * due date after the same balance check the services make, retried while it can still settle
 * in time, and the month is missed (the business pays its landlord itself, a day late) when
 * nothing could be collected. CashFlow never pays from the pool on these plans.
 *
 * The day after each due date, a plan with `graduation.minOnTimeMonths` on time months in a
 * row is re-underwritten through the same `decide` on the bank history up to that day, with
 * its payment history, at most once a month, as the refresh-eligibility job does. An approval
 * for at least the rent is offered, `acceptShareBps` of offers are accepted, and an accepted
 * offer becomes a financed plan from the next rent date: a graduate, played like any other
 * plan from the same capital pool and reported as its own cohort.
 */
export interface PassThroughSimConfig {
  policy: PassThroughPolicy;
  graduation: GraduationPolicy;
  /** Months of payment history the factor reads. */
  lookbackMonths: number;
  /** Share of offers the owner accepts, in basis points. */
  acceptShareBps: number;
}

/** Pass-through and graduation counts for one run. */
export interface PassThroughStats {
  /** Applicants the engine declined. */
  declined: number;
  /** Of those, declined for credit capacity alone: offered a pass-through plan. */
  eligible: number;
  /** Pass-through plans that collected or missed at least one month. */
  plans: number;
  months: number;
  onTimeMonths: number;
  missedMonths: number;
  /** Rent paid to landlords through pass-through plans. */
  volumeCents: number;
  /** Eligibility reviews run, and their outcomes. */
  reviews: number;
  reviewApproved: number;
  reviewDeclined: number;
  /** Would have gone to a reviewer: not offered, and not sent to the queue. */
  reviewReferred: number;
  reviewNeedsInfo: number;
  offers: number;
  /** Offers accepted: graduates. */
  graduated: number;
  /** Graduates that are fraud archetypes. */
  graduatedFraud: number;
}

export function emptyPassThroughStats(): PassThroughStats {
  return {
    declined: 0,
    eligible: 0,
    plans: 0,
    months: 0,
    onTimeMonths: 0,
    missedMonths: 0,
    volumeCents: 0,
    reviews: 0,
    reviewApproved: 0,
    reviewDeclined: 0,
    reviewReferred: 0,
    reviewNeedsInfo: 0,
    offers: 0,
    graduated: 0,
    graduatedFraud: 0,
  };
}

/** The pass-through settings the gated configuration runs with. */
export function defaultPassThroughSim(
  graduation: GraduationPolicy,
  lookbackMonths: number,
): PassThroughSimConfig {
  return {
    policy: STANDARD_PASS_THROUGH_POLICY,
    graduation,
    lookbackMonths,
    acceptShareBps: ASSUMPTIONS.graduationAcceptShareBps,
  };
}

export function defaultPortfolioConfig(n: number): PortfolioConfig {
  return {
    label: 'base',
    decide,
    servicing: BASELINE_SERVICING_POLICY,
    horizonMonths: ASSUMPTIONS.horizonMonths,
    poolSizeCents: poolSizeFor(n),
    stress: null,
    startDate: ASSUMPTIONS.startDate,
    runoffDays: ASSUMPTIONS.runoffDays,
    measurementChargeOffDays: ASSUMPTIONS.measurementChargeOffDays,
    badDaysPastDue: ASSUMPTIONS.badDaysPastDue,
    reviewFraudCatchRateBps: ASSUMPTIONS.reviewFraudCatchRateBps,
    exposure: CURRENT_POLICY.exposure,
    maxWaitMonths: ASSUMPTIONS.maxFundingWaitMonths,
    partialAdvance: false,
    returnDelayDays: 0,
    manualPayment: null,
    throughTheDoor: null,
  };
}

/**
 * Pool for the through the door run: $1 trillion, so no payout ever waits for cash. Far
 * inside the safe integer range even with every receivable added to it.
 */
export const UNCONSTRAINED_POOL_CENTS = 100_000_000_000_000;

/**
 * The fee a through the door plan is charged. An approved or referred applicant pays the fee
 * the engine quoted. A declined applicant the engine got as far as pricing pays the fee the
 * pricing built up, held to the fee cap, since the product never charges more than the cap.
 * A declined applicant who was knocked out before pricing pays `fallbackFeeBps`.
 */
export function throughTheDoorFeeBps(decision: EngineResult, fallbackFeeBps: number): number {
  if (decision.feeBps !== null) return decision.feeBps;
  const priced = decision.snapshot.pricing;
  if (priced) return Math.min(priced.feeBps, priced.maxFeeBps);
  return fallbackFeeBps;
}

/** What happened to one applicant. Money fields are zero unless a plan was opened. */
export interface CustomerResult {
  applicantId: string;
  segment: string;
  fraud: FraudType | null;
  industry: Industry;
  arrivalMonth: number;
  applicationDate: IsoDate;
  latentHealth: number;
  /** The final outcome: the engine's, or the reviewer's when the engine referred. */
  outcome: DecisionOutcome;
  /** What the engine returned. REFER when it sent the application to a reviewer. */
  engineOutcome: DecisionOutcome;
  /** The engine referred this application. */
  referred: boolean;
  /** Rent periods the plan waited for pool capacity before it started. */
  fundingWaitMonths: number;
  /** Approved, but the pool never had room within the wait limit. No plan was opened. */
  neverFunded: boolean;
  score: number | null;
  grade: CreditGrade | null;
  feeBps: number | null;
  /** PD and expected loss per period the fee was priced on. Null without expected loss pricing. */
  pdBps: number | null;
  expectedLossBps: number | null;
  approvedLimitCents: number | null;
  requestedRentCents: number;
  /** Approved for less than the rent requested. */
  counterOffer: boolean;
  /**
   * A counter offer that could not be used: the product fronts a whole lease rent or
   * nothing. Approved on paper, but no plan was opened. Never set under `partialAdvance`.
   */
  unusableCounterOffer: boolean;
  /** Rent fronted each period. The request, or the limit under `partialAdvance`. */
  planRentCents: number;
  installmentsPerMonth: number;
  /** Landlord payouts made. Each one is a plan-month. */
  payoutCount: number;
  /** Total rent paid to the landlord. */
  payoutCents: number;
  /** Payouts the servicing policy held for at least a day. Each was then released or cancelled. */
  heldPayouts: number;
  /** Held payouts paid after the business cured inside the release window. */
  releasedPayouts: number;
  /** Payouts never made: still held, or still unfunded, when the release window closed. */
  cancelledPayouts: number;
  principalCollectedCents: number;
  feesCollectedCents: number;
  /** Principal written off, by the policy during the run or by measurement at the end. */
  chargedOffCents: number;
  recoveredCents: number;
  /** Principal still owed and not written off when observation ended. */
  outstandingCents: number;
  /** Sum over days of principal outstanding, in cent-days. Drives cost of funds. */
  outstandingCentDays: number;
  /** Debits presented and returned for insufficient funds. */
  failedDebits: number;
  /** Scheduled debits put off by the balance check. Not attempts. */
  deferredDebits: number;
  /** Installments paid by hand under the manual payment sensitivity. */
  manualPayments: number;
  lateInstallments: number;
  maxDaysPastDue: number;
  /** An installment of the first period reached the bad threshold. */
  firstPaymentDefault: boolean;
  /** Any installment reached the bad threshold or was written off. */
  bad: boolean;
  /** Date the business shut, if it did while observed. */
  closedOn: IsoDate | null;
  /** Veracity finding codes on the decision. Empty without veracity facts or findings. */
  veracityCodes: string[];
  /**
   * How a veracity finding changed the engine's outcome: knocked out, sent for information,
   * or referred. Null when none did.
   */
  veracityEffect: 'KNOCKOUT' | 'NEEDS_INFO' | 'REFER' | null;
  /**
   * For an applicant a veracity finding affected: the engine's outcome on the same data
   * without the veracity facts, and whether that would have been usable (approved, or
   * referred and approved by the reviewer, at the rent requested).
   */
  outcomeWithoutVeracity: DecisionOutcome | null;
  usableWithoutVeracity: boolean | null;
  /** Honest messiness and connection events from the population (see veracity-sim.ts). */
  veracityTags: string[];
  /**
   * A financed plan that began as a pass-through plan: the result of graduation, reported
   * apart from the origination book. Score, grade and fee are the eligibility review's.
   */
  graduated: boolean;
  /** Pass-through months for this applicant, when it had a pass-through plan. */
  passThroughMonths: number;
  passThroughOnTimeMonths: number;
  passThroughMissedMonths: number;
}

const VERACITY_NEEDS_INFO_CODES = new Set([
  'PAYOUT_ACCOUNT_NOT_CONNECTED',
  'RECONNECT_REQUIRED',
  'CONNECTION_ACTION_NEEDED',
]);

/** How a veracity finding changed this decision, if it did. */
export function veracityEffect(decision: EngineResult): CustomerResult['veracityEffect'] {
  const v = decision.snapshot.veracity;
  if (!v || v.findings.length === 0) return null;
  if (decision.outcome === 'DECLINED' && v.findings.some((f) => f.consequence === 'KNOCKOUT')) {
    return 'KNOCKOUT';
  }
  if (
    decision.outcome === 'NEEDS_INFO' &&
    decision.reasons.some((r) => VERACITY_NEEDS_INFO_CODES.has(r.code))
  ) {
    return 'NEEDS_INFO';
  }
  if (
    decision.outcome === 'REFER' &&
    decision.snapshot.referTriggers.some((t) => t.startsWith('VERACITY:'))
  ) {
    return 'REFER';
  }
  return null;
}

export interface PoolMonth {
  /** YYYY-MM */
  month: string;
  payoutsCents: number;
  collectedCents: number;
  /** Lowest pool cash in the month, measured right after payouts go out. */
  minPoolCents: number;
  endPoolCents: number;
  /** Principal outstanding at month end. */
  endReceivableCents: number;
  /** Share of total capital (cash plus receivables) that was out at the low point, in bps. */
  peakUtilizationBps: number;
  activePlans: number;
}

export interface PortfolioResult {
  label: string;
  servicingPolicy: string;
  stress: StressScenario['name'];
  horizonMonths: number;
  poolStartCents: number;
  poolEndCents: number;
  poolMinCents: number;
  /** Payouts that could not be funded on their due date. */
  unfundedPayouts: number;
  /** Payout-days spent waiting for the pool. */
  unfundedPayoutDays: number;
  /** Plans whose start waited at least one rent date for pool capacity. */
  plansDelayed: number;
  /** Approved applicants never funded because the pool had no room within the wait limit. */
  plansNeverFunded: number;
  pool: PoolMonth[];
  customers: CustomerResult[];
  /**
   * Roll to charge-off by delinquency bucket. On the evening of the first of every month,
   * which is when the provision job sets the allowance, each unpaid installment is recorded
   * under the bucket its plan is in. `chargedOffCents` is the part of that principal that
   * was later written off. The servicing policy's reserve rates are read off this table.
   */
  bucketRoll: BucketRoll;
  /**
   * The same, measured on entry: each unpaid installment is recorded once under every
   * bucket its plan moves into. All rent here is due on the first, so no plan is ever in
   * the grace bucket on a provision date, and this is the only measure of that bucket.
   */
  bucketEntryRoll: BucketRoll;
  /** Pass-through and graduation counts. Null when the run has no pass-through. */
  passThrough: PassThroughStats | null;
  /**
   * Financed plans opened by graduation, one per graduate. They draw on the same pool as the
   * origination book and are in its pool path, but not in `customers`, so that every
   * applicant metric and gate reads the origination decisions it always did.
   */
  graduates: CustomerResult[];
}

export type BucketRoll = Record<OpenBucket, { observedCents: number; chargedOffCents: number }>;

export function emptyBucketRoll(): BucketRoll {
  return Object.fromEntries(
    OPEN_BUCKETS.map((b) => [b, { observedCents: 0, chargedOffCents: 0 }]),
  ) as BucketRoll;
}

interface Installment {
  dueDate: IsoDate;
  principalCents: number;
  feeCents: number;
  totalCents: number;
  firstPeriod: boolean;
  attempts: number;
  lastAttemptDate: IsoDate | null;
  late: boolean;
  paid: boolean;
  /**
   * A debit the account could not cover is booked as collected until the bank's return
   * arrives on this date. Until then the installment is believed paid.
   */
  returnOn: IsoDate | null;
  /** The bucket of the plan at each provision snapshot while this was unpaid. */
  seen: OpenBucket[];
  /** Every bucket the plan has moved into while this was unpaid, once each. */
  entered: OpenBucket[];
  /** Days past due on which the owner pays by hand, under the manual payment sensitivity. */
  manualPayDay: number | null;
}

interface DuePayout {
  dueDate: IsoDate;
  held: boolean;
  unfundedCounted: boolean;
}

interface ActivePlan {
  applicant: Applicant;
  result: CustomerResult;
  sim: BusinessSimulation;
  feeBps: number;
  nextDueDate: IsoDate;
  periodsLeft: number;
  /** Payouts that are due and not yet paid or cancelled, oldest first. */
  duePayouts: DuePayout[];
  /** The plan's balance has been written off. Anything that reopens is written off too. */
  chargedOff: boolean;
  unpaid: Installment[];
  outstandingCents: number;
  /** Last day this plan is observed. Set once the final period is known. */
  endDate: IsoDate | null;
  /** False until the first payout has passed the funding rules. */
  started: boolean;
  /** The plan's rent is counted in committed exposure. */
  committed: boolean;
}

function emptyResult(applicant: Applicant, decision: EngineResult): CustomerResult {
  return {
    applicantId: applicant.id,
    segment: applicant.segment,
    fraud: applicant.fraud,
    industry: applicant.industry,
    arrivalMonth: applicant.arrivalMonth,
    applicationDate: applicant.applicationDate,
    latentHealth: applicant.latentHealth,
    outcome: decision.outcome,
    engineOutcome: decision.outcome,
    referred: decision.outcome === 'REFER',
    fundingWaitMonths: 0,
    neverFunded: false,
    score: decision.score,
    grade: decision.grade,
    feeBps: decision.feeBps,
    pdBps: decision.snapshot.pricing?.pdBps ?? null,
    expectedLossBps: decision.snapshot.pricing?.expectedLossBps ?? null,
    approvedLimitCents: decision.approvedMonthlyLimitCents,
    requestedRentCents: applicant.requestedRentCents,
    counterOffer:
      decision.approvedMonthlyLimitCents !== null &&
      decision.approvedMonthlyLimitCents < applicant.requestedRentCents,
    unusableCounterOffer: false,
    planRentCents: 0,
    installmentsPerMonth: 0,
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
    veracityCodes: decision.snapshot.veracity?.findings.map((f) => f.code) ?? [],
    veracityEffect: veracityEffect(decision),
    outcomeWithoutVeracity: null,
    usableWithoutVeracity: null,
    veracityTags: applicant.veracity
      ? [
          ...applicant.veracity.tags,
          ...(applicant.veracity.fraud ? [applicant.veracity.fraud] : []),
        ]
      : [],
    graduated: false,
    passThroughMonths: 0,
    passThroughOnTimeMonths: 0,
    passThroughMissedMonths: 0,
  };
}

/** A pass-through plan in the simulation. */
interface PassThroughPlan {
  applicant: Applicant;
  result: CustomerResult;
  sim: BusinessSimulation;
  /** The next rent date to collect for. */
  nextDueDate: IsoDate;
  /** Months still to play. */
  periodsLeft: number;
  /** The month being collected, if any. */
  current: {
    dueDate: IsoDate;
    collectOn: IsoDate;
    lastCollectOn: IsoDate;
    attempts: number;
    collected: boolean;
  } | null;
  months: PaymentHistoryMonth[];
  /** YYYY-MM of the last eligibility review. */
  lastReview: string | null;
  done: boolean;
}

function monthStart(startDate: IsoDate, months: number): IsoDate {
  const { year, month } = parseIsoDate(startDate);
  const index = month - 1 + months;
  return toIsoDate(year + Math.floor(index / 12), (index % 12) + 1, 1);
}

/** The applicant's simulation parameters with the book wide stress shock added, if any. */
function stressedParams(
  applicant: Applicant,
  config: Pick<PortfolioConfig, 'stress' | 'startDate'>,
) {
  if (!config.stress) return applicant.params;
  return {
    ...applicant.params,
    events: [
      ...applicant.params.events,
      {
        kind: 'revenue_shock' as const,
        start: monthStart(config.startDate, config.stress.startMonth),
        days: config.stress.days,
        depth: config.stress.depth,
      },
    ],
  };
}

/**
 * Build the applicant's history up to and including the application date, run the decision,
 * and return the simulation positioned on the following day.
 */
export function underwrite(
  applicant: Applicant,
  config: Pick<PortfolioConfig, 'decide' | 'stress' | 'startDate' | 'stripVeracity'>,
  exposureContext: ExposureContext | null = null,
  /** Keep the transactions: a pass-through plan may re-underwrite on them later. */
  keepHistory = false,
): {
  decision: EngineResult;
  sim: BusinessSimulation | null;
  withoutVeracity: EngineResult | null;
} {
  const base = {
    statedMonthlyRevenueCents: applicant.statedMonthlyRevenueCents,
    timeInBusinessMonths: applicant.timeInBusinessMonths,
    requestedMonthlyRentCents: applicant.requestedRentCents,
    exposureContext,
  };
  if (applicant.historyDays <= 0) {
    return {
      decision: config.decide({ ...base, bankData: null }),
      sim: null,
      withoutVeracity: null,
    };
  }
  const start = addDays(applicant.applicationDate, -(applicant.historyDays - 1));
  const sim = createForwardSimulation(stressedParams(applicant, config), applicant.seedHex, start);
  const posFrom = applicant.pos ? applicant.historyDays - applicant.pos.days : Infinity;
  const salesPath: { date: IsoDate; grossCents: number }[] = [];
  for (let i = 0; i < applicant.historyDays; i++) {
    const date = i >= posFrom ? sim.date : '';
    sim.step();
    if (i >= posFrom && sim.lastSalesCents > 0) {
      salesPath.push({ date, grossCents: sim.lastSalesCents });
    }
  }
  const commerce = applicant.pos ? generateSalesFromPath(salesPath, applicant.seedHex) : null;
  // What the connections show: the true account seen through each connection's quirks, and
  // the facts the veracity checks read. Without veracity facts, exactly the simulation.
  const observed = applicant.veracity
    ? observe(
        { ...applicant, veracity: applicant.veracity },
        sim.transactions,
        commerce?.dailySales ?? null,
      )
    : null;
  const bankFailed = observed?.veracity.banks[0]?.current === null;
  const posFailed = observed !== null && observed.veracity.commerce[0]?.current === null;
  const dailySales = observed?.dailySales ?? commerce?.dailySales ?? null;
  const input = {
    ...base,
    bankData:
      bankFailed && !config.stripVeracity
        ? null
        : {
            transactions: observed?.transactions ?? sim.transactions,
            currentBalanceCents: sim.balanceCents,
            asOf: applicant.applicationDate,
          },
    commerceData:
      dailySales && applicant.pos && (!posFailed || config.stripVeracity)
        ? {
            platform: applicant.pos.platform,
            dailySales,
            connectedSince: dailySales[0]?.date ?? commerce!.connectedSince,
          }
        : null,
  };
  const decision = config.decide({
    ...input,
    ...(observed && !config.stripVeracity ? { veracity: observed.veracity } : {}),
  });
  // The counterfactual on the same data, for an applicant a veracity finding affected.
  const withoutVeracity =
    observed && veracityEffect(decision) !== null
      ? config.decide({
          ...input,
          bankData: input.bankData ?? {
            transactions: observed.transactions,
            currentBalanceCents: sim.balanceCents,
            asOf: applicant.applicationDate,
          },
        })
      : null;
  // The history has done its job. Stop keeping transactions for the forward run.
  if (!keepHistory) {
    sim.record = false;
    sim.transactions = [];
  }
  return { decision, sim, withoutVeracity };
}

export function runPortfolio(
  population: readonly Applicant[],
  overrides: Partial<PortfolioConfig> = {},
): PortfolioResult {
  const config: PortfolioConfig = { ...defaultPortfolioConfig(population.length), ...overrides };
  const policy = config.servicing;
  const applicants = [...population].sort((a, b) =>
    a.applicationDate === b.applicationDate
      ? a.id < b.id
        ? -1
        : 1
      : a.applicationDate < b.applicationDate
        ? -1
        : 1,
  );

  const customers: CustomerResult[] = [];
  const pool: PoolMonth[] = [];
  let active: ActivePlan[] = [];
  let poolCents = config.poolSizeCents;
  let poolMinCents = poolCents;
  let receivableCents = 0;
  let unfundedPayouts = 0;
  let unfundedPayoutDays = 0;
  let plansDelayed = 0;
  let plansNeverFunded = 0;
  let month: PoolMonth | null = null;
  let cursor = 0;
  // Monthly rent committed on plans that have started and are still being funded, in total
  // and by industry. This is the state the exposure rules read.
  let committedCents = 0;
  const committedByIndustry = new Map<Industry, number>();
  const commit = (plan: ActivePlan, sign: 1 | -1) => {
    const rent = plan.result.planRentCents * sign;
    committedCents += rent;
    committedByIndustry.set(
      plan.applicant.industry,
      (committedByIndustry.get(plan.applicant.industry) ?? 0) + rent,
    );
  };
  const exposureFor = (industry: Industry): ExposureContext => ({
    businessCommittedCents: 0,
    onTimePeriods: 0,
    industryCommittedCents: committedByIndustry.get(industry) ?? 0,
    pool: { cashCents: poolCents, receivableCents, committedCents },
  });

  const bucketRoll = emptyBucketRoll();
  const bucketEntryRoll = emptyBucketRoll();
  // Pass-through and graduation. Never in a counterfactual run.
  const pt = config.throughTheDoor ? null : (config.passThrough ?? null);
  const ptStats = pt ? emptyPassThroughStats() : null;
  let passThroughPlans: PassThroughPlan[] = [];
  const graduates: CustomerResult[] = [];
  /** An installment is settled one way or the other: close out its roll observations. */
  const resolveRoll = (inst: Installment, lost: boolean) => {
    for (const bucket of inst.seen) {
      bucketRoll[bucket].observedCents += inst.principalCents;
      if (lost) bucketRoll[bucket].chargedOffCents += inst.principalCents;
    }
    inst.seen = [];
    for (const bucket of inst.entered) {
      bucketEntryRoll[bucket].observedCents += inst.principalCents;
      if (lost) bucketEntryRoll[bucket].chargedOffCents += inst.principalCents;
    }
    inst.entered = [];
  };

  /** Undo the booking of a debit the bank has now returned. */
  const landReturn = (inst: Installment) => {
    poolCents -= inst.totalCents;
    receivableCents += inst.principalCents;
    inst.returnOn = null;
  };

  const collect = (plan: ActivePlan, inst: Installment) => {
    poolCents += inst.totalCents;
    receivableCents -= inst.principalCents;
    plan.outstandingCents -= inst.principalCents;
    plan.result.principalCollectedCents += inst.principalCents;
    plan.result.feesCollectedCents += inst.feeCents;
    if (month) month.collectedCents += inst.totalCents;
    inst.paid = true;
    resolveRoll(inst, false);
  };

  const chargeOff = (plan: ActivePlan, inst: Installment) => {
    const recovery = expectedRecoveryCents(policy, inst.principalCents);
    plan.result.chargedOffCents += inst.principalCents;
    plan.result.recoveredCents += recovery;
    plan.result.bad = true;
    plan.outstandingCents -= inst.principalCents;
    receivableCents -= inst.principalCents;
    poolCents += recovery;
    resolveRoll(inst, true);
  };

  /** Close out a plan whose observation window has ended. */
  const finish = (plan: ActivePlan, asOf: IsoDate) => {
    const stillOwed: Installment[] = [];
    for (const inst of plan.unpaid) {
      if (inst.returnOn !== null) landReturn(inst);
      if (daysPastDue(inst.dueDate, asOf) >= config.measurementChargeOffDays) chargeOff(plan, inst);
      else stillOwed.push(inst);
    }
    plan.unpaid = stillOwed;
    plan.result.outstandingCents = plan.outstandingCents;
    plan.result.closedOn = plan.sim.closedOn;
  };

  /** Due date of the oldest installment the books show as unpaid. This is what a hold reads. */
  const oldestUnpaid = (plan: ActivePlan): IsoDate | null => {
    for (const inst of plan.unpaid) if (inst.returnOn === null) return inst.dueDate;
    return null;
  };

  /** On which day past due, if any, the owner pays this installment by hand. */
  const manualPayDay = (applicant: Applicant, dueDate: IsoDate): number | null => {
    const m = config.manualPayment;
    if (!m) return null;
    const h = hash32(`manual/${applicant.seedHex}/${dueDate}`);
    if (h % 10_000 >= m.shareBps) return null;
    return m.firstDay + ((h >>> 14) % (m.lastDay - m.firstDay + 1));
  };

  /** A plan that starts on the first rent date after `appliedOn`. */
  const openPlan = (
    applicant: Applicant,
    result: CustomerResult,
    sim: BusinessSimulation,
    feeBps: number,
    appliedOn: IsoDate,
  ) => {
    active.push({
      applicant,
      result,
      sim,
      feeBps,
      nextDueDate: nextRentDueDate(1, addDays(appliedOn, 1)),
      periodsLeft: config.horizonMonths,
      duePayouts: [],
      chargedOff: false,
      unpaid: [],
      outstandingCents: 0,
      endDate: null,
      started: false,
      committed: false,
    });
  };

  /**
   * One day of a pass-through plan: open the month when its collection window starts, debit
   * the rent after the balance check, and on the due date pay the landlord from what was
   * collected or record the month as missed. Then, if it has enough on time months in a row,
   * the eligibility review.
   */
  const stepPassThrough = (plan: PassThroughPlan, date: IsoDate) => {
    const settings = pt!;
    const stats = ptStats!;
    const rent = plan.result.requestedRentCents;
    if (!plan.current && plan.periodsLeft > 0) {
      const schedule = passThroughSchedule(settings.policy, plan.nextDueDate);
      if (date >= schedule.collectOn) {
        plan.current = { dueDate: plan.nextDueDate, ...schedule, attempts: 0, collected: false };
        if (plan.result.passThroughMonths === 0) stats.plans += 1;
        // From here the business's own rent debit is replaced by the collection.
        plan.sim.setExternalRent(rent);
      }
    }
    const c = plan.current;
    const debits: ExternalDebit[] = [];
    let attempting = false;
    if (
      c &&
      !c.collected &&
      date >= c.collectOn &&
      date <= c.lastCollectOn &&
      c.attempts < settings.policy.maxCollectionAttempts
    ) {
      // The balance check reads the account before the day's deposits, as for installments.
      attempting = plan.sim.balanceCents >= rent || !settings.policy.balancePreCheck;
      debits.push({
        amountCents: rent,
        description: 'CASHFLOW RENT COLLECTION',
        noticeOnly: !attempting,
      });
    }
    const results = plan.sim.step(debits);
    if (c && attempting) {
      c.attempts += 1;
      if (results[0]) c.collected = true;
    }
    if (!c || date !== c.dueDate) return;

    // The due date: the landlord is paid from the settled collection, or the month is missed
    // and the business pays the landlord itself.
    plan.result.passThroughMonths += 1;
    stats.months += 1;
    if (c.collected) {
      plan.result.passThroughOnTimeMonths += 1;
      stats.onTimeMonths += 1;
      stats.volumeCents += rent;
    } else {
      plan.result.passThroughMissedMonths += 1;
      stats.missedMonths += 1;
      plan.sim.payRentLate(rent);
    }
    plan.months.push({
      rentPlanId: plan.applicant.id,
      kind: 'PASS_THROUGH',
      periodMonth: c.dueDate.slice(0, 7),
      dueDate: c.dueDate,
      outcome: c.collected ? 'ON_TIME' : 'MISSED',
    });
    plan.current = null;
    plan.periodsLeft -= 1;
    plan.nextDueDate = followingDueDate(c.dueDate, 1);
    if (plan.periodsLeft <= 0) {
      plan.sim.setExternalRent(0);
      plan.done = true;
      return;
    }
    reviewEligibility(plan, date);
  };

  /** The refresh-eligibility review, at most once a month, and graduation on an offer. */
  const reviewEligibility = (plan: PassThroughPlan, date: IsoDate) => {
    const settings = pt!;
    const stats = ptStats!;
    const month = date.slice(0, 7);
    if (plan.lastReview === month) return;
    const summary = summarizePaymentHistory(plan.months, date, settings.lookbackMonths);
    if (summary.currentOnTimeStreak < settings.graduation.minOnTimeMonths) return;
    plan.lastReview = month;
    stats.reviews += 1;
    const applicant = plan.applicant;
    // Fresh data: the account up to today, a little over a year of it.
    const from = addDays(date, -399);
    plan.sim.transactions = plan.sim.transactions.filter((t) => t.date >= from);
    const elapsedMonths = Math.max(
      0,
      Math.round(daysPastDue(applicant.applicationDate, date) / 30.44),
    );
    const decision = config.decide({
      statedMonthlyRevenueCents: applicant.statedMonthlyRevenueCents,
      timeInBusinessMonths: applicant.timeInBusinessMonths + elapsedMonths,
      requestedMonthlyRentCents: applicant.requestedRentCents,
      bankData: {
        transactions: plan.sim.transactions,
        currentBalanceCents: plan.sim.balanceCents,
        asOf: date,
      },
      integrityContext: { leaseVerified: true },
      exposureContext: exposureFor(applicant.industry),
      periodicReview: true,
      paymentHistory: summary,
    });
    if (decision.outcome === 'APPROVED') stats.reviewApproved += 1;
    else if (decision.outcome === 'DECLINED') stats.reviewDeclined += 1;
    else if (decision.outcome === 'REFER') stats.reviewReferred += 1;
    else stats.reviewNeedsInfo += 1;
    const limit = decision.approvedMonthlyLimitCents ?? 0;
    if (decision.outcome !== 'APPROVED' || limit < applicant.requestedRentCents) return;
    stats.offers += 1;
    if (hash32(`graduate/${applicant.seedHex}`) % 10_000 >= settings.acceptShareBps) return;

    // Graduation: the pass-through plan ends with this month, and a financed plan starts on
    // the next rent date, from the pool, like any other.
    stats.graduated += 1;
    if (applicant.fraud !== null) stats.graduatedFraud += 1;
    plan.done = true;
    plan.sim.record = false;
    plan.sim.transactions = [];
    plan.sim.setExternalRent(0);
    const result = emptyResult(applicant, decision);
    result.graduated = true;
    result.applicationDate = date;
    result.planRentCents = applicant.requestedRentCents;
    result.installmentsPerMonth = decision.recommendedInstallmentsPerMonth ?? 2;
    result.passThroughMonths = plan.result.passThroughMonths;
    result.passThroughOnTimeMonths = plan.result.passThroughOnTimeMonths;
    result.passThroughMissedMonths = plan.result.passThroughMissedMonths;
    graduates.push(result);
    openPlan(applicant, result, plan.sim, decision.feeBps ?? 0, date);
  };

  /** Start a pass-through plan for a declined applicant, if it is offered one. */
  const maybeStartPassThrough = (
    applicant: Applicant,
    result: CustomerResult,
    decision: EngineResult,
    sim: BusinessSimulation,
    date: IsoDate,
  ): boolean => {
    if (!pt || !ptStats || decision.outcome !== 'DECLINED') return false;
    ptStats.declined += 1;
    const eligibility = passThroughEligibility({
      outcome: decision.outcome,
      kind: 'ENGINE',
      reasons: decision.reasons,
      knockouts: snapshotKnockouts(decision.snapshot),
    });
    if (!eligibility.eligible) return false;
    ptStats.eligible += 1;
    // The first rent date that can still be collected and settled in time.
    let due = nextRentDueDate(1, addDays(date, 1));
    while (passThroughSchedule(pt.policy, due).lastCollectOn <= date) {
      due = followingDueDate(due, 1);
    }
    passThroughPlans.push({
      applicant,
      result,
      sim,
      nextDueDate: due,
      periodsLeft: config.horizonMonths,
      current: null,
      months: [],
      lastReview: null,
      done: false,
    });
    return true;
  };

  if (applicants.length === 0) {
    return {
      label: config.label,
      servicingPolicy: policy.name,
      stress: config.stress?.name ?? 'base',
      horizonMonths: config.horizonMonths,
      poolStartCents: config.poolSizeCents,
      poolEndCents: poolCents,
      poolMinCents,
      unfundedPayouts,
      unfundedPayoutDays,
      plansDelayed,
      plansNeverFunded,
      pool,
      customers,
      bucketRoll,
      bucketEntryRoll,
      passThrough: ptStats,
      graduates,
    };
  }

  for (let date = applicants[0]!.applicationDate; ; date = addDays(date, 1)) {
    if (cursor >= applicants.length && active.length === 0 && passThroughPlans.length === 0) {
      break;
    }

    const monthKey = date.slice(0, 7);
    if (!month || month.month !== monthKey) {
      month = {
        month: monthKey,
        payoutsCents: 0,
        collectedCents: 0,
        minPoolCents: poolCents,
        endPoolCents: poolCents,
        endReceivableCents: receivableCents,
        peakUtilizationBps: 0,
        activePlans: 0,
      };
      pool.push(month);
    }

    // 0. Returns that arrive today are reversed before anything reads who is paid up, as
    //    the reconcile job does.
    if (config.returnDelayDays > 0) {
      for (const plan of active) {
        for (const inst of plan.unpaid) {
          if (inst.returnOn !== null && inst.returnOn <= date) landReturn(inst);
        }
      }
    }

    // 1. Landlord payouts, before any collection, as the jobs run in production.
    for (const plan of active) {
      if (plan.started && plan.periodsLeft === 0 && plan.nextDueDate === date) {
        // The observed periods are over: the business pays its own rent again.
        plan.sim.setExternalRent(0);
        if (plan.committed) {
          plan.committed = false;
          commit(plan, -1);
        }
      }
      if (!plan.started && plan.nextDueDate === date) {
        // First rent date: the plan starts only if the pool can take it under the exposure
        // rules. Otherwise it waits a month, and gives up after the wait limit.
        const funding = config.exposure
          ? checkFunding(
              config.exposure,
              plan.result.planRentCents,
              exposureFor(plan.applicant.industry),
            )
          : null;
        if (funding && !funding.ok) {
          if (plan.result.fundingWaitMonths === 0) plansDelayed += 1;
          plan.result.fundingWaitMonths += 1;
          if (plan.result.fundingWaitMonths > config.maxWaitMonths) {
            plan.result.neverFunded = true;
            plansNeverFunded += 1;
            plan.periodsLeft = 0;
            plan.endDate = date;
          } else {
            plan.nextDueDate = followingDueDate(date, 1);
          }
        } else {
          plan.started = true;
          plan.committed = true;
          commit(plan, 1);
        }
      }
      if (plan.started && plan.periodsLeft > 0 && plan.nextDueDate === date) {
        plan.periodsLeft -= 1;
        // A payout falls due. The business leaves this month's rent to CashFlow, whether or
        // not the payout goes out today: a held payout can still be released.
        plan.duePayouts.push({ dueDate: date, held: false, unfundedCounted: false });
        plan.sim.setExternalRent(plan.result.planRentCents);
        plan.nextDueDate = followingDueDate(date, 1);
        if (plan.periodsLeft === 0) {
          plan.endDate = addDays(date, 28 + config.runoffDays);
        }
      }
      // Decide what is due, oldest first, with the rule the payout service uses: pay it,
      // hold it while the business is past due, or cancel it once the release window has
      // passed. A payout the pool cannot cover waits and is tried again every day, inside
      // the same window.
      while (plan.duePayouts.length > 0) {
        const payout = plan.duePayouts[0]!;
        const rent = plan.result.planRentCents;
        const action = payoutAction(
          policy,
          payout.dueDate,
          shouldHoldPayout(policy, oldestUnpaid(plan), date),
          date,
        );
        if (action === 'cancel') {
          // Never paid. The business has to pay its landlord for the month itself, late.
          plan.duePayouts.shift();
          plan.result.cancelledPayouts += 1;
          plan.sim.payRentLate(rent);
          continue;
        }
        if (action === 'hold') {
          if (!payout.held) {
            payout.held = true;
            plan.result.heldPayouts += 1;
          }
          break;
        }
        if (poolCents < rent) {
          // Every payout waiting behind this one is unfunded too, each counted once.
          for (const waiting of plan.duePayouts) {
            if (!waiting.unfundedCounted) {
              waiting.unfundedCounted = true;
              unfundedPayouts += 1;
            }
          }
          unfundedPayoutDays += plan.duePayouts.length;
          break;
        }
        plan.duePayouts.shift();
        if (payout.held) plan.result.releasedPayouts += 1;
        poolCents -= rent;
        receivableCents += rent;
        plan.outstandingCents += rent;
        plan.result.payoutCount += 1;
        plan.result.payoutCents += rent;
        month.payoutsCents += rent;
        const schedule = buildInstallmentSchedule({
          rentCents: rent,
          feeBps: plan.feeBps,
          dueDate: payout.dueDate,
          installmentsPerMonth: plan.result.installmentsPerMonth,
        });
        // A payout made late moves its installments out by the same number of days.
        const delayDays = daysPastDue(payout.dueDate, date);
        const firstPeriod = plan.result.payoutCount === 1;
        for (const s of schedule.installments) {
          const dueDate = delayDays > 0 ? addDays(s.dueDate, delayDays) : s.dueDate;
          plan.unpaid.push({
            dueDate,
            principalCents: s.principalCents,
            feeCents: s.feeCents,
            totalCents: s.totalCents,
            firstPeriod,
            attempts: 0,
            lastAttemptDate: null,
            late: false,
            paid: false,
            returnOn: null,
            seen: [],
            entered: [],
            manualPayDay: manualPayDay(plan.applicant, dueDate),
          });
        }
      }
    }

    // The pool's low point is after payouts and before the day's collections.
    if (poolCents < month.minPoolCents) month.minPoolCents = poolCents;
    if (poolCents < poolMinCents) poolMinCents = poolCents;
    const capital = poolCents + receivableCents;
    if (capital > 0) {
      const utilization = Math.round((receivableCents * 10_000) / capital);
      if (utilization > month.peakUtilizationBps) month.peakUtilizationBps = utilization;
    }

    // 2. Collections against each business's simulated balance, then aging.
    let anyFinished = false;
    const provisionDay = date.endsWith('-01');
    for (const plan of active) {
      const due: Installment[] = [];
      const debits: ExternalDebit[] = [];
      // The balance check reads the account before the day's deposits arrive.
      const openingBalance = plan.sim.balanceCents;
      for (const inst of plan.unpaid) {
        if (inst.returnOn !== null) continue;
        if (shouldAttemptCollection(policy, inst, date)) {
          due.push(inst);
          debits.push({
            amountCents: inst.totalCents,
            description: 'CASHFLOW RENT INSTALLMENT',
            noticeOnly: !balanceCoversDebit(policy, openingBalance, inst.totalCents),
          });
        }
      }
      const results = plan.sim.step(debits);
      for (let k = 0; k < due.length; k++) {
        const inst = due[k]!;
        if (debits[k]!.noticeOnly) {
          // Put off by the balance check: not an attempt, and looked at again tomorrow.
          plan.result.deferredDebits += 1;
          continue;
        }
        inst.attempts += 1;
        inst.lastAttemptDate = date;
        if (results[k]) {
          collect(plan, inst);
        } else {
          plan.result.failedDebits += 1;
          if (config.returnDelayDays > 0) {
            // Booked as collected today. The bank's return undoes it in a couple of days.
            inst.returnOn = addDays(date, config.returnDelayDays);
            poolCents += inst.totalCents;
            receivableCents -= inst.principalCents;
          }
        }
      }
      if (plan.unpaid.length > 0) {
        const remaining: Installment[] = [];
        for (const inst of plan.unpaid) {
          if (inst.paid) continue;
          const dpd = daysPastDue(inst.dueDate, date);
          if (
            inst.manualPayDay !== null &&
            dpd === inst.manualPayDay &&
            inst.returnOn === null &&
            !plan.sim.closed
          ) {
            // Sensitivity only: the owner pays by hand from money outside the account.
            plan.result.manualPayments += 1;
            collect(plan, inst);
            continue;
          }
          if (dpd > plan.result.maxDaysPastDue) plan.result.maxDaysPastDue = dpd;
          if (!inst.late && isLate(policy, inst.dueDate, date)) {
            inst.late = true;
            plan.result.lateInstallments += 1;
          }
          if (dpd >= config.badDaysPastDue) {
            plan.result.bad = true;
            if (inst.firstPeriod) plan.result.firstPaymentDefault = true;
          }
          remaining.push(inst);
        }
        plan.unpaid = remaining;
        // Write off the whole unpaid balance once the oldest installment reaches the write
        // off age, as `chargeOffPlan` does, and anything that reopens on a written off plan.
        const oldest = oldestUnpaid(plan);
        if (oldest !== null && (plan.chargedOff || shouldChargeOff(policy, oldest, date))) {
          plan.chargedOff = true;
          const provisional: Installment[] = [];
          for (const inst of plan.unpaid) {
            if (inst.returnOn !== null) provisional.push(inst);
            else chargeOff(plan, inst);
          }
          plan.unpaid = provisional;
          // A written off plan is closed: no further landlord payouts. A payout that was
          // due and not made is cancelled, and the business pays that rent itself.
          for (let k = 0; k < plan.duePayouts.length; k++) {
            plan.result.cancelledPayouts += 1;
            plan.sim.payRentLate(plan.result.planRentCents);
          }
          plan.duePayouts = [];
          if (plan.committed) {
            plan.committed = false;
            commit(plan, -1);
          }
          plan.sim.setExternalRent(0);
          plan.periodsLeft = 0;
          plan.endDate ??= addDays(date, config.runoffDays);
        }
        // Roll observations: the bucket the plan is in tonight, recorded on every unpaid
        // installment the first time the plan is in it, and again on the evening of the
        // first of the month, when the allowance is set.
        const first = plan.chargedOff ? null : oldestUnpaid(plan);
        if (first !== null) {
          const bucket = delinquencyBucket(policy, daysPastDue(first, date)) as OpenBucket;
          for (const inst of plan.unpaid) {
            if (inst.returnOn !== null) continue;
            if (provisionDay) inst.seen.push(bucket);
            if (!inst.entered.includes(bucket)) inst.entered.push(bucket);
          }
        }
      }
      plan.result.outstandingCentDays += plan.outstandingCents;

      if (plan.endDate !== null) {
        // A payout that was never made is dropped when observation ends.
        if (date >= plan.endDate) plan.duePayouts = [];
        if (plan.duePayouts.length === 0 && (date >= plan.endDate || plan.unpaid.length === 0)) {
          if (plan.committed) {
            plan.committed = false;
            commit(plan, -1);
          }
          finish(plan, date);
          anyFinished = true;
          plan.periodsLeft = -1;
        }
      }
    }
    if (anyFinished) active = active.filter((p) => p.periodsLeft !== -1);

    // 2b. Pass-through plans: collections, landlord payments from what was collected, and
    //     the eligibility review. A graduate joins `active` and is played from tomorrow.
    if (passThroughPlans.length > 0) {
      for (const plan of passThroughPlans) stepPassThrough(plan, date);
      passThroughPlans = passThroughPlans.filter((p) => !p.done);
    }

    // 3. Today's applications. An approved plan starts on the next first of the month.
    while (cursor < applicants.length && applicants[cursor]!.applicationDate === date) {
      const applicant = applicants[cursor++]!;
      const { decision, sim, withoutVeracity } = underwrite(
        applicant,
        config,
        exposureFor(applicant.industry),
        pt !== null,
      );
      const result = emptyResult(applicant, decision);
      // A declined applicant offered a pass-through plan keeps its history for the review.
      // Everyone else stops recording transactions here.
      if (sim && !maybeStartPassThrough(applicant, result, decision, sim, date)) {
        sim.record = false;
        sim.transactions = [];
      }
      if (withoutVeracity) {
        result.outcomeWithoutVeracity = withoutVeracity.outcome;
        const limit = withoutVeracity.approvedMonthlyLimitCents ?? 0;
        result.usableWithoutVeracity =
          (withoutVeracity.outcome === 'APPROVED' || withoutVeracity.outcome === 'REFER') &&
          limit >= applicant.requestedRentCents;
      }
      customers.push(result);
      if (decision.outcome === 'REFER') {
        // The reviewer catches a fixed share of fraud and declines it. Which applicants are
        // caught depends only on the applicant, so every run reviews them the same way.
        const caught =
          applicant.fraud !== null &&
          hash32(`review/${applicant.seedHex}`) % 10_000 < config.reviewFraudCatchRateBps;
        result.outcome = caught ? 'DECLINED' : 'APPROVED';
      }
      if (config.throughTheDoor) {
        // Counterfactual: the decision above is kept as the record of what the policy said,
        // and everyone with a score gets a plan at the rent they asked for.
        if (decision.score === null || !sim) continue;
        const feeBps = throughTheDoorFeeBps(decision, config.throughTheDoor.fallbackFeeBps);
        result.feeBps = feeBps;
        result.planRentCents = applicant.requestedRentCents;
        result.installmentsPerMonth = decision.recommendedInstallmentsPerMonth ?? 2;
        if (result.planRentCents <= 0) continue;
        openPlan(applicant, result, sim, feeBps, date);
        continue;
      }
      if (result.outcome !== 'APPROVED' || !sim) continue;
      if (result.counterOffer && !config.partialAdvance) {
        // The product fronts a whole lease rent or nothing. A limit below the rent cannot be
        // used, so the approval opens no plan.
        result.unusableCounterOffer = true;
        continue;
      }
      result.planRentCents = Math.min(
        applicant.requestedRentCents,
        decision.approvedMonthlyLimitCents ?? 0,
      );
      result.installmentsPerMonth = decision.recommendedInstallmentsPerMonth ?? 2;
      if (result.planRentCents <= 0) continue;
      openPlan(applicant, result, sim, decision.feeBps ?? 0, date);
    }

    month.endPoolCents = poolCents;
    month.endReceivableCents = receivableCents;
    month.activePlans = active.length;
  }

  // Safety net: nothing should be left, but never lose a plan silently.
  for (const plan of active) finish(plan, plan.endDate ?? plan.nextDueDate);

  return {
    label: config.label,
    servicingPolicy: policy.name,
    stress: config.stress?.name ?? 'base',
    horizonMonths: config.horizonMonths,
    poolStartCents: config.poolSizeCents,
    poolEndCents: poolCents,
    poolMinCents,
    unfundedPayouts,
    unfundedPayoutDays,
    plansDelayed,
    plansNeverFunded,
    pool,
    customers,
    bucketRoll,
    bucketEntryRoll,
    passThrough: ptStats,
    graduates,
  };
}

/**
 * The counterfactual through the door run: `runPortfolio` with every scored applicant
 * funded at the rent requested, from a pool that never runs short and with no exposure or
 * concentration rule in the way. Servicing, the bad definition, the horizon, and the
 * applicants are whatever the caller passes, so they match the run being judged. It is a
 * separate run with its own state: nothing in it can reach the gated run's pool or metrics.
 *
 * Only a simulation can do this. A real lender never sees how a declined applicant would
 * have performed.
 */
export function runThroughTheDoor(
  population: readonly Applicant[],
  overrides: Partial<PortfolioConfig> & { fallbackFeeBps: number },
): PortfolioResult {
  const { fallbackFeeBps, ...rest } = overrides;
  return runPortfolio(population, {
    ...rest,
    throughTheDoor: { fallbackFeeBps },
    passThrough: null,
    exposure: null,
    poolSizeCents: UNCONSTRAINED_POOL_CENTS,
    partialAdvance: false,
  });
}

/**
 * The customers of `runThroughTheDoor(population, overrides)`, without playing again what
 * `funded` has already played. `funded` must be the ordinary run of the same applicants
 * under the same configuration (decisions, servicing, horizon, stress), which is the run
 * whose score is being judged.
 *
 * With no pool or exposure limit, a through the door plan depends on nothing but its own
 * business: no plan can delay or crowd out another. So an applicant the ordinary run funded
 * at the rent requested, on the first rent date, from a pool that never ran short, had
 * exactly the plan the through the door run would give them, and an applicant with no score
 * has no plan in either. Those results are taken as they are, and only the rest (the
 * declined, the counter offers, and any plan that had to wait) are simulated, each from
 * the same history the ordinary run decided on. A unit test checks the result against the
 * full run.
 */
export function throughTheDoorCustomers(
  population: readonly Applicant[],
  overrides: Partial<PortfolioConfig> & { fallbackFeeBps: number },
  funded: PortfolioResult,
): CustomerResult[] {
  const reused = new Map<string, CustomerResult>();
  // A payout that waited for pool cash moved its installments. Reuse nothing from such a run.
  if (funded.unfundedPayouts === 0) {
    for (const c of funded.customers) {
      const samePlan =
        c.payoutCount > 0 &&
        c.fundingWaitMonths === 0 &&
        c.planRentCents === c.requestedRentCents &&
        c.manualPayments === 0;
      if (c.score === null || samePlan) reused.set(c.applicantId, c);
    }
  }
  const rest = population.filter((a) => !reused.has(a.id));
  const played = new Map(
    runThroughTheDoor(rest, overrides).customers.map((c) => [c.applicantId, c]),
  );
  // In the order `runPortfolio` reports them: by application date, then id.
  return [...population]
    .sort((a, b) =>
      a.applicationDate === b.applicationDate
        ? a.id < b.id
          ? -1
          : 1
        : a.applicationDate < b.applicationDate
          ? -1
          : 1,
    )
    .map((a) => reused.get(a.id) ?? played.get(a.id)!);
}

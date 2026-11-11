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
  BASELINE_SERVICING_POLICY,
  daysPastDue,
  expectedRecoveryCents,
  isLate,
  shouldAttemptCollection,
  shouldChargeOff,
  shouldHoldPayout,
  type ServicingPolicy,
} from '../servicing/policy.ts';
import { decide, type EngineInput, type EngineResult } from '../underwriting/engine.ts';
import { ASSUMPTIONS, poolSizeFor, type StressScenario } from './assumptions.ts';
import type { Applicant, FraudType, Industry } from './population.ts';

/**
 * Portfolio simulator.
 *
 * Walks a calendar one day at a time. On its application date each applicant's bank history
 * (and point of sale history, if connected) is built and handed to the real `decide()`. An
 * approval opens a plan: on every rent due date the landlord is paid in full from a finite
 * capital pool, and installments are then debited from the same simulated bank account the
 * history came from. A debit fails when the balance cannot cover it, so delinquency and loss
 * emerge from the business's cash, not from a label. Retries, lateness, payout holds, and
 * write offs follow the `ServicingPolicy` passed in.
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
  };
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
  outcome: DecisionOutcome;
  score: number | null;
  grade: CreditGrade | null;
  feeBps: number | null;
  approvedLimitCents: number | null;
  requestedRentCents: number;
  /** Rent fronted each period: the lower of the request and the approved limit. */
  planRentCents: number;
  installmentsPerMonth: number;
  /** Landlord payouts made. Each one is a plan-month. */
  payoutCount: number;
  /** Total rent paid to the landlord. */
  payoutCents: number;
  /** Payouts skipped because the servicing policy held them. */
  heldPayouts: number;
  principalCollectedCents: number;
  feesCollectedCents: number;
  /** Principal written off, by the policy during the run or by measurement at the end. */
  chargedOffCents: number;
  recoveredCents: number;
  /** Principal still owed and not written off when observation ended. */
  outstandingCents: number;
  /** Sum over days of principal outstanding, in cent-days. Drives cost of funds. */
  outstandingCentDays: number;
  failedDebits: number;
  lateInstallments: number;
  maxDaysPastDue: number;
  /** An installment of the first period reached the bad threshold. */
  firstPaymentDefault: boolean;
  /** Any installment reached the bad threshold or was written off. */
  bad: boolean;
  /** Date the business shut, if it did while observed. */
  closedOn: IsoDate | null;
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
  pool: PoolMonth[];
  customers: CustomerResult[];
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
}

interface ActivePlan {
  applicant: Applicant;
  result: CustomerResult;
  sim: BusinessSimulation;
  feeBps: number;
  nextDueDate: IsoDate;
  periodsLeft: number;
  /** Due dates of payouts that are due but waiting for pool cash, oldest first. */
  pendingPayouts: IsoDate[];
  unpaid: Installment[];
  outstandingCents: number;
  /** Last day this plan is observed. Set once the final period is known. */
  endDate: IsoDate | null;
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
    score: decision.score,
    grade: decision.grade,
    feeBps: decision.feeBps,
    approvedLimitCents: decision.approvedMonthlyLimitCents,
    requestedRentCents: applicant.requestedRentCents,
    planRentCents: 0,
    installmentsPerMonth: 0,
    payoutCount: 0,
    payoutCents: 0,
    heldPayouts: 0,
    principalCollectedCents: 0,
    feesCollectedCents: 0,
    chargedOffCents: 0,
    recoveredCents: 0,
    outstandingCents: 0,
    outstandingCentDays: 0,
    failedDebits: 0,
    lateInstallments: 0,
    maxDaysPastDue: 0,
    firstPaymentDefault: false,
    bad: false,
    closedOn: null,
  };
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
  config: Pick<PortfolioConfig, 'decide' | 'stress' | 'startDate'>,
): { decision: EngineResult; sim: BusinessSimulation | null } {
  const base = {
    statedMonthlyRevenueCents: applicant.statedMonthlyRevenueCents,
    timeInBusinessMonths: applicant.timeInBusinessMonths,
    requestedMonthlyRentCents: applicant.requestedRentCents,
  };
  if (applicant.historyDays <= 0) {
    return { decision: config.decide({ ...base, bankData: null }), sim: null };
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
  const decision = config.decide({
    ...base,
    bankData: {
      transactions: sim.transactions,
      currentBalanceCents: sim.balanceCents,
      asOf: applicant.applicationDate,
    },
    commerceData:
      commerce && applicant.pos
        ? {
            platform: applicant.pos.platform,
            dailySales: commerce.dailySales,
            connectedSince: commerce.connectedSince,
          }
        : null,
  });
  // The history has done its job. Stop keeping transactions for the forward run.
  sim.record = false;
  sim.transactions = [];
  return { decision, sim };
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
  let month: PoolMonth | null = null;
  let cursor = 0;

  const chargeOff = (plan: ActivePlan, inst: Installment) => {
    const recovery = expectedRecoveryCents(policy, inst.principalCents);
    plan.result.chargedOffCents += inst.principalCents;
    plan.result.recoveredCents += recovery;
    plan.result.bad = true;
    plan.outstandingCents -= inst.principalCents;
    receivableCents -= inst.principalCents;
    poolCents += recovery;
  };

  /** Close out a plan whose observation window has ended. */
  const finish = (plan: ActivePlan, asOf: IsoDate) => {
    const stillOwed: Installment[] = [];
    for (const inst of plan.unpaid) {
      if (daysPastDue(inst.dueDate, asOf) >= config.measurementChargeOffDays) chargeOff(plan, inst);
      else stillOwed.push(inst);
    }
    plan.unpaid = stillOwed;
    plan.result.outstandingCents = plan.outstandingCents;
    plan.result.closedOn = plan.sim.closedOn;
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
      pool,
      customers,
    };
  }

  for (let date = applicants[0]!.applicationDate; ; date = addDays(date, 1)) {
    if (cursor >= applicants.length && active.length === 0) break;

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

    // 1. Landlord payouts, before any collection, as the jobs run in production.
    for (const plan of active) {
      if (plan.periodsLeft === 0 && plan.nextDueDate === date) {
        // The observed periods are over: the business pays its own rent again.
        plan.sim.setExternalRent(0);
      }
      if (plan.periodsLeft > 0 && plan.nextDueDate === date) {
        plan.periodsLeft -= 1;
        const oldest = plan.unpaid.length > 0 ? plan.unpaid[0]!.dueDate : null;
        if (shouldHoldPayout(policy, oldest, date)) {
          // Held: CashFlow does not pay this month, so the business owes its landlord itself.
          plan.result.heldPayouts += 1;
          plan.sim.setExternalRent(0);
        } else {
          plan.pendingPayouts.push(date);
          plan.sim.setExternalRent(plan.result.planRentCents);
        }
        plan.nextDueDate = followingDueDate(date, 1);
        if (plan.periodsLeft === 0) {
          plan.endDate = addDays(date, 28 + config.runoffDays);
        }
      }
      // Fund what is due, oldest first. A payout the pool cannot cover waits and is tried
      // again every day, as the payout job does.
      while (plan.pendingPayouts.length > 0) {
        const dueDate = plan.pendingPayouts[0]!;
        const rent = plan.result.planRentCents;
        if (poolCents < rent) {
          if (plan.pendingPayouts[plan.pendingPayouts.length - 1] === date) unfundedPayouts += 1;
          unfundedPayoutDays += plan.pendingPayouts.length;
          break;
        }
        plan.pendingPayouts.shift();
        poolCents -= rent;
        receivableCents += rent;
        plan.outstandingCents += rent;
        plan.result.payoutCount += 1;
        plan.result.payoutCents += rent;
        month.payoutsCents += rent;
        const schedule = buildInstallmentSchedule({
          rentCents: rent,
          feeBps: plan.feeBps,
          dueDate,
          installmentsPerMonth: plan.result.installmentsPerMonth,
        });
        const firstPeriod = plan.result.payoutCount === 1;
        for (const s of schedule.installments) {
          plan.unpaid.push({
            dueDate: s.dueDate,
            principalCents: s.principalCents,
            feeCents: s.feeCents,
            totalCents: s.totalCents,
            firstPeriod,
            attempts: 0,
            lastAttemptDate: null,
            late: false,
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
    for (const plan of active) {
      const due: Installment[] = [];
      const debits: ExternalDebit[] = [];
      for (const inst of plan.unpaid) {
        if (shouldAttemptCollection(policy, inst, date)) {
          due.push(inst);
          debits.push({ amountCents: inst.totalCents, description: 'CASHFLOW RENT INSTALLMENT' });
        }
      }
      const results = plan.sim.step(debits);
      if (due.length > 0) {
        for (let k = 0; k < due.length; k++) {
          const inst = due[k]!;
          inst.attempts += 1;
          inst.lastAttemptDate = date;
          if (results[k]) {
            poolCents += inst.totalCents;
            receivableCents -= inst.principalCents;
            plan.outstandingCents -= inst.principalCents;
            plan.result.principalCollectedCents += inst.principalCents;
            plan.result.feesCollectedCents += inst.feeCents;
            month.collectedCents += inst.totalCents;
            inst.totalCents = 0; // marks it paid for the filter below
          } else {
            plan.result.failedDebits += 1;
          }
        }
      }
      if (plan.unpaid.length > 0) {
        const remaining: Installment[] = [];
        for (const inst of plan.unpaid) {
          if (inst.totalCents === 0) continue;
          const dpd = daysPastDue(inst.dueDate, date);
          if (dpd > plan.result.maxDaysPastDue) plan.result.maxDaysPastDue = dpd;
          if (!inst.late && isLate(policy, inst.dueDate, date)) {
            inst.late = true;
            plan.result.lateInstallments += 1;
          }
          if (dpd >= config.badDaysPastDue) {
            plan.result.bad = true;
            if (inst.firstPeriod) plan.result.firstPaymentDefault = true;
          }
          if (shouldChargeOff(policy, inst.dueDate, date)) {
            chargeOff(plan, inst);
            // A written off plan is closed: no further landlord payouts.
            plan.pendingPayouts = [];
            if (plan.periodsLeft > 0) {
              plan.periodsLeft = 0;
              plan.sim.setExternalRent(0);
            }
            plan.endDate ??= addDays(date, config.runoffDays);
          } else {
            remaining.push(inst);
          }
        }
        plan.unpaid = remaining;
      }
      plan.result.outstandingCentDays += plan.outstandingCents;

      if (plan.endDate !== null) {
        // A payout the pool never managed to fund is dropped when observation ends.
        if (date >= plan.endDate) plan.pendingPayouts = [];
        if (
          plan.pendingPayouts.length === 0 &&
          (date >= plan.endDate || plan.unpaid.length === 0)
        ) {
          finish(plan, date);
          anyFinished = true;
          plan.periodsLeft = -1;
        }
      }
    }
    if (anyFinished) active = active.filter((p) => p.periodsLeft !== -1);

    // 3. Today's applications. An approved plan starts on the next first of the month.
    while (cursor < applicants.length && applicants[cursor]!.applicationDate === date) {
      const applicant = applicants[cursor++]!;
      const { decision, sim } = underwrite(applicant, config);
      const result = emptyResult(applicant, decision);
      customers.push(result);
      if (decision.outcome !== 'APPROVED' || !sim) continue;
      result.planRentCents = Math.min(
        applicant.requestedRentCents,
        decision.approvedMonthlyLimitCents ?? 0,
      );
      result.installmentsPerMonth = decision.recommendedInstallmentsPerMonth ?? 2;
      if (result.planRentCents <= 0) continue;
      active.push({
        applicant,
        result,
        sim,
        feeBps: decision.feeBps ?? 0,
        nextDueDate: nextRentDueDate(1, addDays(date, 1)),
        periodsLeft: config.horizonMonths,
        pendingPayouts: [],
        unpaid: [],
        outstandingCents: 0,
        endDate: null,
      });
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
    pool,
    customers,
  };
}

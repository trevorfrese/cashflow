import { CONTROLS_POLICY } from '../controls/policy.ts';
import { CURRENT_POLICY } from '../underwriting/policy.ts';

/**
 * Every monitoring threshold, in one object, each with the reasoning behind it.
 *
 * Rates are basis points. Where a number follows a network rule or a regulation it is the
 * working assumption, to be confirmed by counsel or the bank partner, not a legal conclusion.
 * The numbers that come from the portfolio evaluation (`apps/api/evals/report.md`) are tied
 * to a simulated population and have to be re-set on real performance.
 */
export interface RateThreshold {
  /** Rate at or above which the rule fires at its full severity. */
  thresholdBps: number;
  /** Fewest items in the denominator before the rate means anything. */
  minSample: number;
  /** Fewest events in the numerator. One event on a small book is an event, not a rate. */
  minEvents: number;
}

export interface VeracityMonitoringPolicy {
  /** A settlement match this many bps below the one the plan was approved on is a drop... */
  settlementDropBps: number;
  /** ...when the latest is also under this. */
  settlementWarnBelowBps: number;
  /** Under this it is high severity. */
  settlementHighBelowBps: number;
  /** Fewest payouts in both assessments before a match rate is compared. */
  settlementMinPayouts: number;
  /** Businesses under different users on one platform account or payout destination. */
  sharedAccountWarnBusinesses: number;
  sharedAccountHighBusinesses: number;
}

export interface MonitoringPolicy {
  /**
   * A person who resolves an alert has looked at the condition. The same condition does not
   * open a new alert for this many days, so resolving is not undone by the next run.
   */
  reopenSuppressionDays: number;
  /** Data connections and veracity (data veracity phase). New rules; nothing above changed. */
  veracity: VeracityMonitoringPolicy;
  fraud: {
    /** A landlord change this close before a scheduled payout is the takeover pattern. */
    payoutProximityDays: number;
    /** Distinct users paying one landlord account before it is worth a look, and a hard look. */
    sharedLandlordWarnUsers: number;
    sharedLandlordHighUsers: number;
    /** Applications by one user inside the window. */
    velocityWindowDays: number;
    velocityWarnApplications: number;
    velocityHighApplications: number;
    /** New applications by a user inside the window after one of theirs was declined. */
    reapplyWindowDays: number;
    reapplyWarnApplications: number;
  };
  payments: {
    /** Trailing days the return rates are measured over. */
    returnWindowDays: number;
    unauthorized: RateThreshold;
    administrative: RateThreshold;
    overall: RateThreshold;
    /** A rate at this share of its threshold is a warning. */
    warnAtShareBps: number;
    /** Failed or returned debits on one bank account inside the window. */
    repeatedFailureWindowDays: number;
    repeatedFailureCount: number;
  };
  portfolio: {
    /** Fewest plans in a cohort, or with a balance, before a portfolio rate is read. */
    minPlans: number;
    /** A first installment this many days past due counts as a first payment default. */
    firstPaymentDefaultDays: number;
    firstPaymentDefaultWarnBps: number;
    firstPaymentDefaultCriticalBps: number;
    /** Share of outstanding principal in DELINQUENT and DEFAULT. */
    delinquentShareWarnBps: number;
    delinquentShareCriticalBps: number;
    /** Share of last month's current balance that is delinquent or worse today. */
    rollWindowDays: number;
    rollWarnBps: number;
    rollCriticalBps: number;
    /** Caps from the credit policy, so monitoring and underwriting cannot drift apart. */
    maxSingleNameShareBps: number;
    maxIndustryShareBps: number;
    maxPoolUtilizationBps: number;
    /** Share of a cap at which an informational alert opens. */
    concentrationInfoShareBps: number;
    /** Share of a cap above which the breach is high severity. */
    concentrationHighShareBps: number;
    /** Share of the utilization ceiling at which a warning opens. */
    utilizationWarnShareBps: number;
    /** Committed rent over this share of pool capital cannot all be funded. */
    utilizationCriticalBps: number;
    /** A cohort younger than this has had no time to charge off. */
    lossCohortMinAgeDays: number;
    /** Realized over expected loss, in basis points (10000 is on expectation). */
    lossRatioWarnBps: number;
    lossRatioCriticalBps: number;
  };
  operations: {
    /** A job whose last good run is more than this many days behind the monitor's date. */
    maxJobGapDays: number;
    /** Receivable differences smaller than this are ignored. Zero: the books are exact. */
    receivableToleranceCents: number;
  };
  compliance: {
    decisionWarnDays: number;
    decisionCriticalDays: number;
    /** Days a current screening may age past the rescreen interval before it is stale. */
    screeningGraceDays: number;
    rescreenIntervalDays: number;
    retentionMonths: number;
    /**
     * The adverse action notice is built in a later phase. Until then no decision can have
     * one, so the rule is switched off rather than left to fire on every decline.
     */
    adverseActionNoticeRuleActive: boolean;
    /** Days after a decline or counter offer by which the notice must be stored. */
    adverseActionNoticeDays: number;
  };
}

const exposure = CURRENT_POLICY.exposure;

export const MONITORING_POLICY: MonitoringPolicy = {
  // Thirty days: long enough that a dismissed false positive stays dismissed for a month of
  // daily runs, short enough that a condition nobody fixed comes back.
  reopenSuppressionDays: 30,
  veracity: {
    // Origination needs 85% of payouts matched for platform sales to count (the credit
    // policy's `excludeBelowBps`). A fall of 20 points from what the plan was approved on,
    // to under that bar, means sales stopped reaching the account we debit: a warning.
    // Under 50%, where an application would be referred, it is high.
    settlementDropBps: 2000,
    settlementWarnBelowBps: CURRENT_POLICY.veracity?.reconciliation.excludeBelowBps ?? 8500,
    settlementHighBelowBps: CURRENT_POLICY.veracity?.reconciliation.referBelowBps ?? 5000,
    settlementMinPayouts: CURRENT_POLICY.veracity?.reconciliation.minPayouts ?? 8,
    // One platform account or payout account behind two unrelated businesses is already
    // unusual (a franchise group applies as one business); three is a ring.
    sharedAccountWarnBusinesses: 2,
    sharedAccountHighBusinesses: 3,
  },
  fraud: {
    // Ten days: the cooling-off period plus the payout release window. A change inside it
    // can still decide where the next rent payment goes.
    payoutProximityDays: CONTROLS_POLICY.leaseChangeCoolingOffDays + 5,
    // One landlord with two tenants is a building. Three unrelated users paying the same
    // account on a book this size is worth a look, five is a pattern.
    sharedLandlordWarnUsers: 3,
    sharedLandlordHighUsers: 5,
    // An owner applies once per lease. Four in a week is someone testing what gets through;
    // eight is automation.
    velocityWindowDays: 7,
    velocityWarnApplications: 4,
    velocityHighApplications: 8,
    // Two more applications within thirty days of a decline is shopping the inputs.
    reapplyWindowDays: 30,
    reapplyWarnApplications: 2,
  },
  payments: {
    // The ACH network measures return rates over the preceding sixty days (two calendar
    // months). Working assumption, to be confirmed with the originating bank.
    returnWindowDays: 60,
    // Network thresholds, as working assumptions: unauthorized returns (R05, R07, R10, R29,
    // and R11 where used) at or above 0.5% of debits, administrative returns (R02, R03,
    // R04) at or above 3%, all returns at or above 15%. The minimum samples are ours: at
    // fewer than 200 debits one return is already 0.5%, so a rate is not a rate yet, and a
    // single unauthorized return is alerted on its own as an event either way.
    unauthorized: { thresholdBps: 50, minSample: 200, minEvents: 2 },
    administrative: { thresholdBps: 300, minSample: 100, minEvents: 3 },
    overall: { thresholdBps: 1500, minSample: 50, minEvents: 5 },
    // Warn at 80% of a threshold: time to act before the bank does.
    warnAtShareBps: 8000,
    // Three failed or returned debits on one account in thirty days is a whole retry cycle
    // lost: the account is dead or empty and a person should call.
    repeatedFailureWindowDays: 30,
    repeatedFailureCount: 3,
  },
  portfolio: {
    // Twenty plans: below that one bad plan moves any rate by five points or more.
    minPlans: 20,
    // The servicing policy's DEFAULT bucket starts at 30 days past due.
    firstPaymentDefaultDays: 30,
    // The evaluation measured first payment defaults at 0.2% to 0.4% of plans, at most 0.8%
    // in any seed. 1.5% is about twice the worst seed; 3% is past anything the policy was
    // evaluated for and almost always means fraud getting through, so it trips the breaker.
    firstPaymentDefaultWarnBps: 150,
    firstPaymentDefaultCriticalBps: 300,
    // The evaluated book carries well under 1% of principal past grace. 5% is a book that
    // is visibly off; 10% means one dollar in ten is not coming back on schedule.
    delinquentShareWarnBps: 500,
    delinquentShareCriticalBps: 1000,
    // Month over month. 3% of a current book rolling delinquent in one month is several
    // times the evaluated rate; 8% in a month is a shock to the whole book.
    rollWindowDays: 30,
    rollWarnBps: 300,
    rollCriticalBps: 800,
    maxSingleNameShareBps: exposure?.maxSingleNameShareBps ?? 500,
    maxIndustryShareBps: exposure?.maxIndustryShareBps ?? 4000,
    maxPoolUtilizationBps: exposure?.maxPoolUtilizationBps ?? 8500,
    // Three quarters of a cap is the point to know about it. Over the cap is a warning,
    // because the funding rules already stop new plans; half as much again is high.
    concentrationInfoShareBps: 7500,
    concentrationHighShareBps: 15_000,
    utilizationWarnShareBps: 9000,
    // Committed rent above pool capital: next month's payouts cannot all be funded.
    utilizationCriticalBps: 10_000,
    // Charge-off is at 90 days past due, so a cohort needs 120 days before its realized
    // loss can be compared with what its decisions expected.
    lossCohortMinAgeDays: 120,
    // Expected loss is a mean; single cohorts scatter around it. 1.5 times is a cohort to
    // watch. 2.5 times means the PD table is wrong for that cohort and pricing is under
    // water, so it trips the breaker.
    lossRatioWarnBps: 15_000,
    lossRatioCriticalBps: 25_000,
  },
  operations: {
    // Jobs run daily. More than one day behind means a whole run was missed.
    maxJobGapDays: 1,
    receivableToleranceCents: 0,
  },
  compliance: {
    // Regulation B working assumption: notice of action taken within 30 days of a completed
    // application. Twenty days leaves ten to work the queue.
    decisionWarnDays: 20,
    decisionCriticalDays: CONTROLS_POLICY.decisionNoticeDays,
    // A week of slack for a rescreen job that was down or a provider that was.
    screeningGraceDays: 7,
    rescreenIntervalDays: CONTROLS_POLICY.rescreenIntervalDays,
    retentionMonths: CONTROLS_POLICY.retentionMonths,
    adverseActionNoticeRuleActive: false,
    // The notice goes out with the decision. A day covers a batch that runs overnight.
    adverseActionNoticeDays: 1,
  },
};

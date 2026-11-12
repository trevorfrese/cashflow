import { z } from 'zod';

import {
  AlertCategory,
  ApplicationStatus,
  BankLinkStatus,
  BusinessStatus,
  DecisionKind,
  DecisionOutcome,
  DelinquencyStatus,
  LeaseStatus,
  VerificationStatus,
} from '../enums';
import { CashFlowSummary } from './bank-data';
import { Industry } from './business';
import {
  Address,
  Bps,
  Cents,
  Id,
  IsoDateSchema,
  IsoDateTimeSchema,
  Paginated,
  PeriodMonth,
} from './common';
import { BusinessIdentityView, LeaseChangeView, ScreeningResult } from './identity';
import { Alert, AuditEventView } from './monitoring';
import { GraduationOffer, PassThroughPeriod, PaymentHistory } from './pass-through';
import { DelinquencySummary, Installment, LandlordPayout, RentPlan, Repayment } from './rent-plan';
import {
  ApplicationReview,
  CreditGrade,
  DecisionReason,
  IntegrityFlagView,
  ReasonImpact,
} from './underwriting';

/**
 * What the operations console reads. Operator only: every shape here may carry internals a
 * business owner never sees (engine recommendations on a referral, integrity flags, the fee
 * build-up, screening detail, policy thresholds). None of them is used by a customer route.
 */

// ---------- Businesses ----------

export const OperatorBusinessListQuery = z.object({
  /** Matches legal name, trading name, owner email, or an exact business id. */
  q: z.string().trim().max(100).optional(),
  status: BusinessStatus.optional(),
  verification: VerificationStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** `nextCursor` from the previous page. */
  cursor: z.string().optional(),
});
export type OperatorBusinessListQuery = z.infer<typeof OperatorBusinessListQuery>;

export const OperatorBusinessListItem = z.object({
  id: Id,
  legalName: z.string(),
  dba: z.string().nullable(),
  industry: Industry,
  status: BusinessStatus,
  verificationStatus: VerificationStatus,
  city: z.string(),
  state: z.string(),
  ownerEmail: z.string(),
  createdAt: IsoDateTimeSchema,
  /** Plans that are not closed. */
  openPlans: z.number().int().min(0),
  /** Plans frozen from further advances. */
  frozenPlans: z.number().int().min(0),
  /** The worst stored delinquency bucket across all of the business's plans. Null with no plan. */
  worstDelinquency: DelinquencyStatus.nullable(),
  /** Status of the most recent application. Null when there is none. */
  latestApplicationStatus: ApplicationStatus.nullable(),
  openScreeningHits: z.number().int().min(0),
});
export type OperatorBusinessListItem = z.infer<typeof OperatorBusinessListItem>;

export const OperatorBusinessList = Paginated(OperatorBusinessListItem);
export type OperatorBusinessList = z.infer<typeof OperatorBusinessList>;

/** One decision row as an operator sees it: the raw terms, even on a referral. */
export const OperatorDecisionSummary = z.object({
  id: Id,
  kind: DecisionKind,
  outcome: DecisionOutcome,
  approvedMonthlyLimitCents: Cents.nullable(),
  feeBps: Bps.nullable(),
  score: z.number().int().nullable(),
  grade: CreditGrade.nullable(),
  policyVersion: z.string(),
  isOverride: z.boolean(),
  /** The person who reviewed, on a REVIEW decision. */
  reviewer: z.string().nullable(),
  /** YYYY-MM on a periodic review. */
  reviewPeriod: z.string().nullable(),
  decidedAt: IsoDateTimeSchema,
  /** Set when a later decision replaced this one. Null on the current decision. */
  supersededAt: IsoDateTimeSchema.nullable(),
});
export type OperatorDecisionSummary = z.infer<typeof OperatorDecisionSummary>;

export const OperatorApplicationSummary = z.object({
  id: Id,
  businessId: Id,
  status: ApplicationStatus,
  requestedMonthlyRentCents: Cents,
  statedMonthlyRevenueCents: Cents,
  timeInBusinessMonths: z.number().int(),
  submittedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  currentDecision: OperatorDecisionSummary.nullable(),
  decisions: z.number().int().min(0),
  reviews: z.number().int().min(0),
});
export type OperatorApplicationSummary = z.infer<typeof OperatorApplicationSummary>;

/** A lease as an operator sees it. The payout token is never included. */
export const OperatorLease = z.object({
  id: Id,
  status: LeaseStatus,
  landlordName: z.string(),
  landlordEmail: z.string(),
  propertyAddress: Address,
  monthlyRentCents: Cents,
  dueDayOfMonth: z.number().int(),
  startsOn: IsoDateSchema,
  endsOn: IsoDateSchema.nullable(),
  accountHolderName: z.string(),
  routingNumber: z.string(),
  accountNumberLast4: z.string(),
});
export type OperatorLease = z.infer<typeof OperatorLease>;

export const OperatorRepayment = Repayment.extend({
  /** Paid by the owner by hand, not by a scheduled debit. */
  manual: z.boolean(),
  /** Received on an installment that had been written off. */
  recovery: z.boolean(),
  /** The return code in words, for example "Insufficient funds". Null without a code. */
  returnReason: z.string().nullable(),
  /** How servicing treats the code: RETRYABLE, HARD, or UNAUTHORIZED. Null without a code. */
  returnClass: z.enum(['RETRYABLE', 'HARD', 'UNAUTHORIZED']).nullable(),
});
export type OperatorRepayment = z.infer<typeof OperatorRepayment>;

export const OperatorInstallment = Installment.extend({
  lastAttemptOn: IsoDateSchema.nullable(),
  repayments: z.array(OperatorRepayment),
});
export type OperatorInstallment = z.infer<typeof OperatorInstallment>;

export const OperatorPayout = LandlordPayout.extend({
  /** Times a reviewer has sent this payout again after it came back. */
  resendCount: z.number().int().min(0),
  /** True when the payout came back and can be sent again once details are corrected. */
  canResend: z.boolean(),
});
export type OperatorPayout = z.infer<typeof OperatorPayout>;

/** A plan with everything on it: the freeze, every payout, every installment and debit. */
export const OperatorRentPlan = RentPlan.extend({
  landlordName: z.string(),
  advanceFrozenAt: IsoDateTimeSchema.nullable(),
  /** Why advances are frozen, for example `PERIODIC_REVIEW` or `SCREENING_REVIEW`. */
  advanceFrozenReason: z.string().nullable(),
  /** A rent increase waiting for a new decision. Null when there is none. */
  pendingRentCents: Cents.nullable(),
  payouts: z.array(OperatorPayout),
  installments: z.array(OperatorInstallment),
  /** Pass-through plans only: every month, with what was collected and paid. Empty otherwise. */
  passThroughPeriods: z.array(PassThroughPeriod).default([]),
});
export type OperatorRentPlan = z.infer<typeof OperatorRentPlan>;

export const OperatorBusinessDetail = z.object({
  business: z.object({
    id: Id,
    legalName: z.string(),
    dba: z.string().nullable(),
    industry: Industry,
    status: BusinessStatus,
    address: Address,
    foundedOn: IsoDateSchema,
    statedMonthlyRevenueCents: Cents,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    owner: z.object({ userId: Id, email: z.string(), fullName: z.string() }),
  }),
  identity: BusinessIdentityView,
  bankLinks: z.array(
    z.object({
      id: Id,
      provider: z.string(),
      institutionName: z.string(),
      accountMask: z.string(),
      status: BankLinkStatus,
      createdAt: IsoDateTimeSchema,
    }),
  ),
  leases: z.array(OperatorLease),
  applications: z.array(OperatorApplicationSummary),
  /** Changes to a landlord or payout account that are waiting. */
  pendingLeaseChanges: z.array(LeaseChangeView),
  /** Current screenings of the business, its owners, and its landlords. */
  screenings: z.array(ScreeningResult),
  /** Alerts about the business or anything it owns, newest first, capped. */
  alerts: z.array(Alert),
  /** Rent paid through CashFlow, month by month, on either kind of plan. Derived on read. */
  paymentHistory: PaymentHistory.nullable().default(null),
  /** Graduation offers from a pass-through plan, newest first. */
  graduationOffers: z.array(GraduationOffer).default([]),
});
export type OperatorBusinessDetail = z.infer<typeof OperatorBusinessDetail>;

// ---------- Applications ----------

/** One scorecard factor with the points it earned. Internal: owners see the message only. */
export const ScoreFactorView = z.object({
  code: z.string(),
  label: z.string(),
  points: z.number().int(),
  maxPoints: z.number().int(),
  impact: ReasonImpact,
  message: z.string(),
});
export type ScoreFactorView = z.infer<typeof ScoreFactorView>;

/** How the fee was built from expected loss, funding, servicing, and margin. Internal. */
export const FeeBuildUpView = z.object({
  rentCents: Cents,
  scoreBand: z.string(),
  pdBps: z.number().int(),
  lossGivenDefaultBps: z.number().int(),
  expectedPeriods: z.number(),
  expectedLossBps: z.number(),
  costOfFundsBps: z.number(),
  servicingBps: z.number(),
  targetMarginBps: z.number(),
  requiredBps: z.number(),
  gradeFloorBps: z.number(),
  minFeeBps: z.number(),
  feeBps: z.number().int(),
  feeCents: z.number().int(),
  maxFeeBps: z.number().int(),
  withinCap: z.boolean(),
  driver: z.enum(['GRADE_FLOOR', 'EXPECTED_LOSS', 'MINIMUM_FEE']),
});
export type FeeBuildUpView = z.infer<typeof FeeBuildUpView>;

export const OperatorIntegrityFlag = IntegrityFlagView.extend({
  /** The numbers behind the flag. */
  metrics: z.record(z.string(), z.number()),
});
export type OperatorIntegrityFlag = z.infer<typeof OperatorIntegrityFlag>;

/** The decision with what the engine stored beside it. */
export const OperatorDecision = OperatorDecisionSummary.extend({
  reasons: z.array(DecisionReason),
  cashFlow: CashFlowSummary.nullable(),
  recommendedInstallmentsPerMonth: z.number().int().nullable(),
  /** What the engine would have done on its own. */
  recommendation: z.object({
    outcome: DecisionOutcome,
    approvedMonthlyLimitCents: Cents.nullable(),
    feeBps: Bps.nullable(),
  }),
  referTriggers: z.array(z.string()),
  integrityFlags: z.array(OperatorIntegrityFlag),
  /**
   * Scorecard factors, rebuilt from the stored cash flow under the policy version that made
   * the decision. Null when there was no cash flow to score.
   */
  factors: z.array(ScoreFactorView).nullable(),
  /** False when the rebuilt points do not add up to the stored score. Treat them as a guide. */
  factorsMatchScore: z.boolean(),
  pricing: FeeBuildUpView.nullable(),
  /** The caps that applied to the limit, in cents, and the one that set it. */
  exposure: z
    .object({
      limitCents: z.number().int(),
      binding: z.string(),
      caps: z.record(z.string(), z.number()),
    })
    .nullable(),
  funding: z
    .object({
      ok: z.boolean(),
      blockers: z.array(z.string()),
      utilizationBps: z.number().nullable(),
      industryShareBps: z.number().nullable(),
    })
    .nullable(),
});
export type OperatorDecision = z.infer<typeof OperatorDecision>;

export const OperatorApplicationDetail = z.object({
  application: z.object({
    id: Id,
    businessId: Id,
    businessName: z.string(),
    industry: Industry,
    status: ApplicationStatus,
    requestedMonthlyRentCents: Cents,
    statedMonthlyRevenueCents: Cents,
    timeInBusinessMonths: z.number().int(),
    submittedAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  }),
  /** Whole days since the application was submitted. Null before it is. */
  ageDays: z.number().int().min(0).nullable(),
  /** The date by which the applicant must have an answer. Null before submission. */
  decisionDueOn: IsoDateSchema.nullable(),
  /** The decision in force. Null on a draft. */
  current: OperatorDecision.nullable(),
  /** Every decision, newest first, the current one included. */
  history: z.array(OperatorDecisionSummary),
  /** Reviews recorded on the application, newest first. */
  reviews: z.array(ApplicationReview),
  identity: BusinessIdentityView,
  openScreeningHits: z.array(ScreeningResult),
  /** Audit trail of the application, newest first, capped. */
  auditEvents: z.array(AuditEventView),
});
export type OperatorApplicationDetail = z.infer<typeof OperatorApplicationDetail>;

// ---------- Audit log ----------

export const AuditLogQuery = z.object({
  subjectType: z.string().trim().max(40).optional(),
  subjectId: z.string().trim().max(100).optional(),
  eventType: z.string().trim().max(60).optional(),
  /** `system`, `job`, `user`, `reviewer`, or `admin`. */
  actorType: z.string().trim().max(20).optional(),
  /** Part of the actor's name or id, case insensitive. */
  actor: z.string().trim().max(120).optional(),
  /** Everything about one business: the business, its applications, plans, and leases. */
  businessId: Id.optional(),
  /** First and last calendar day (UTC), inclusive. */
  from: IsoDateSchema.optional(),
  to: IsoDateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuery>;

/** Newest first. `eventTypes` and `subjectTypes` are what the filters can be set to. */
export const AuditLogPage = z.object({
  items: z.array(AuditEventView),
  nextCursor: z.string().nullable(),
  eventTypes: z.array(z.string()),
  subjectTypes: z.array(z.string()),
});
export type AuditLogPage = z.infer<typeof AuditLogPage>;

// ---------- Portfolio ----------

export const ConcentrationRow = z.object({
  /** Industry code, or business id. */
  key: z.string(),
  label: z.string(),
  committedCents: Cents,
  /** Share of pool capital, in basis points. Null when the pool has no capital. */
  shareBps: z.number().int().nullable(),
  capBps: Bps,
  overCap: z.boolean(),
});
export type ConcentrationRow = z.infer<typeof ConcentrationRow>;

export const FirstPaymentDefaultCohort = z.object({
  /** Origination month, YYYY-MM. */
  month: PeriodMonth,
  /** Plans whose first installment is old enough to judge. */
  plans: z.number().int().min(0),
  defaults: z.number().int().min(0),
  rateBps: z.number().int().min(0),
  /** True when the cohort is too small for monitoring to alert on its rate. */
  belowMinSample: z.boolean(),
});
export type FirstPaymentDefaultCohort = z.infer<typeof FirstPaymentDefaultCohort>;

export const OperatorPortfolio = z.object({
  asOf: IsoDateSchema,
  delinquency: DelinquencySummary,
  pool: z.object({
    provider: z.string(),
    /** Cash available to fund payouts, pool plus collected cash not yet swept. */
    cashCents: z.number().int(),
    /** Principal out with businesses, gross of the allowance. */
    receivableCents: z.number().int(),
    /** Cash plus receivables: what the caps are measured against. */
    capitalCents: z.number().int(),
    /** Monthly rent committed across plans that can still draw a payout. */
    committedCents: z.number().int(),
    /** Committed rent as a share of capital. Null when the pool has no capital. */
    utilizationBps: z.number().int().nullable(),
    maxUtilizationBps: Bps,
  }),
  plans: z.object({
    active: z.number().int().min(0),
    paused: z.number().int().min(0),
    closed: z.number().int().min(0),
  }),
  concentration: z.object({
    industries: z.array(ConcentrationRow),
    /** The largest businesses by committed rent, at most ten. */
    businesses: z.array(ConcentrationRow),
  }),
  firstPaymentDefault: z.object({
    /** A first installment this many days past due counts as a default. */
    defaultDays: z.number().int(),
    minPlans: z.number().int(),
    warnBps: Bps,
    criticalBps: Bps,
    /** Newest month first. */
    cohorts: z.array(FirstPaymentDefaultCohort),
  }),
});
export type OperatorPortfolio = z.infer<typeof OperatorPortfolio>;

// ---------- Policy ----------

/** A named number with its unit, so the console can format it without knowing the policy. */
export const PolicyParameter = z.object({
  key: z.string(),
  label: z.string(),
  value: z.union([z.number(), z.string(), z.boolean()]).nullable(),
  unit: z.enum(['bps', 'cents', 'days', 'months', 'count', 'score', 'ratio', 'text', 'flag']),
  /** One line on what the number does. */
  note: z.string().optional(),
});
export type PolicyParameter = z.infer<typeof PolicyParameter>;

export const PolicySection = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  parameters: z.array(PolicyParameter),
});
export type PolicySection = z.infer<typeof PolicySection>;

export const OperatorPolicy = z.object({
  creditPolicyVersion: z.string(),
  servicingPolicy: z.string(),
  /** Credit, exposure, escalation, pricing, servicing, controls, and monitoring numbers. */
  sections: z.array(PolicySection),
  gradeTable: z.array(
    z.object({
      grade: CreditGrade,
      minScore: z.number().int(),
      feeFloorBps: Bps,
      maxRentShareBps: Bps,
    }),
  ),
  /** Largest monthly rent across a business's plans, by on time periods repaid. */
  ladder: z.array(z.object({ afterOnTimePeriods: z.number().int(), capCents: Cents })),
  /** Probability of default by score band, which expected loss pricing reads. */
  pdBands: z.array(
    z.object({
      minScore: z.number().int(),
      maxScore: z.number().int(),
      pdBps: z.number().int(),
      plans: z.number().int(),
    }),
  ),
  scorecardWeights: z.array(z.object({ factor: z.string(), maxPoints: z.number().int() })),
  integrityRules: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
      action: z.enum(['KNOCKOUT', 'REFER', 'CAP', 'NEEDS_INFO', 'INFORM']),
      why: z.string(),
    }),
  ),
  provisionRates: z.array(z.object({ bucket: DelinquencyStatus, rateBps: Bps })),
  returnCodes: z.array(
    z.object({
      code: z.string(),
      class: z.enum(['RETRYABLE', 'HARD', 'UNAUTHORIZED']),
      reason: z.string(),
    }),
  ),
  monitoringRules: z.array(
    z.object({
      type: z.string(),
      category: AlertCategory,
      description: z.string(),
      autoResolves: z.boolean(),
      tripsCircuitBreaker: z.boolean(),
    }),
  ),
});
export type OperatorPolicy = z.infer<typeof OperatorPolicy>;

export const EvaluationGate = z.object({
  id: z.string(),
  description: z.string(),
  /** Mean across seeds. Null when it could not be measured, which fails. */
  value: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  threshold: z.number(),
  comparator: z.enum(['<=', '>=', '>', '<', '=']),
  unit: z.string(),
  pass: z.boolean(),
});
export type EvaluationGate = z.infer<typeof EvaluationGate>;

/**
 * The gate results of the last checked in portfolio evaluation. They come from a simulated
 * population, not from the live book.
 */
export const OperatorEvaluation = z.object({
  /** False when no baseline file is available to the API process. */
  available: z.boolean(),
  /** Where the results were read from. */
  source: z.string(),
  policyVersion: z.string().nullable(),
  servicingPolicy: z.string().nullable(),
  /** True when the evaluated version is the credit policy in force. */
  matchesCurrentPolicy: z.boolean(),
  run: z
    .object({
      applicantsPerSeed: z.number().int(),
      seeds: z.array(z.string()),
      horizonMonths: z.number().int(),
      poolSizeCents: z.number().int(),
    })
    .nullable(),
  gates: z.array(EvaluationGate),
  allPass: z.boolean(),
});
export type OperatorEvaluation = z.infer<typeof OperatorEvaluation>;

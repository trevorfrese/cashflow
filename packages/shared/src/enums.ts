import { z } from 'zod';

export const BusinessStatus = z.enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED']);
export type BusinessStatus = z.infer<typeof BusinessStatus>;

export const BankLinkStatus = z.enum(['PENDING', 'LINKED', 'ERROR', 'DISCONNECTED']);
export type BankLinkStatus = z.infer<typeof BankLinkStatus>;

export const ApplicationStatus = z.enum([
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'DECLINED',
  'NEEDS_INFO',
  /** Referred to a reviewer. No terms are shown until the review is recorded. */
  'IN_REVIEW',
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatus>;

/** `REFER` means the engine would not decide alone: a reviewer records the outcome. */
export const DecisionOutcome = z.enum(['APPROVED', 'DECLINED', 'NEEDS_INFO', 'REFER']);
export type DecisionOutcome = z.infer<typeof DecisionOutcome>;

/** What a reviewer decided about a referred or reconsidered application. */
export const ReviewDecision = z.enum(['APPROVE', 'DECLINE', 'REQUEST_INFO']);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/**
 * Why a decision row exists: the engine ran, a reviewer decided, a periodic review ran, the
 * refresh-eligibility job re-scored a pass-through customer, or the owner accepted a
 * graduation offer.
 */
export const DecisionKind = z.enum([
  'ENGINE',
  'REVIEW',
  'PERIODIC_REVIEW',
  'ELIGIBILITY_REVIEW',
  'GRADUATION',
]);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const LeaseStatus = z.enum(['DRAFT', 'ACTIVE', 'ENDED']);
export type LeaseStatus = z.infer<typeof LeaseStatus>;

export const RentPlanStatus = z.enum(['ACTIVE', 'PAUSED', 'CLOSED']);
export type RentPlanStatus = z.infer<typeof RentPlanStatus>;

/**
 * `FINANCED`: CashFlow pays the landlord in full on the due date and the business repays in
 * installments plus a fee. `PASS_THROUGH`: free. CashFlow collects the rent from the business
 * a few business days early and pays the landlord once that collection has settled.
 */
export const RentPlanKind = z.enum(['FINANCED', 'PASS_THROUGH']);
export type RentPlanKind = z.infer<typeof RentPlanKind>;

/** One month of a pass-through plan. */
export const PassThroughPeriodStatus = z.enum([
  /** Generated. Nothing debited yet. */
  'SCHEDULED',
  /** Debited, and inside the window in which the debit can still come back. */
  'COLLECTING',
  /** Collected and settled. The landlord is paid on the due date. */
  'SETTLED',
  /** The landlord was paid. */
  'PAID',
  /** Nothing collected in time, or the debit came back: CashFlow did not pay the landlord. */
  'MISSED',
  /** Collected, but the landlord payout was held too long: the money went back. */
  'REFUNDED',
  /** The debit came back after the landlord was paid. The business owes the rent to CashFlow. */
  'RETURNED_AFTER_PAYOUT',
  /** Closed before any money moved. */
  'CANCELLED',
]);
export type PassThroughPeriodStatus = z.infer<typeof PassThroughPeriodStatus>;

/** An offer to move from a pass-through plan to a financed one. */
export const GraduationOfferStatus = z.enum([
  'OFFERED',
  'ACCEPTED',
  'COMPLETED',
  'EXPIRED',
  'WITHDRAWN',
]);
export type GraduationOfferStatus = z.infer<typeof GraduationOfferStatus>;

/** How a month of rent through CashFlow went. */
export const PaymentMonthOutcome = z.enum(['ON_TIME', 'LATE', 'MISSED']);
export type PaymentMonthOutcome = z.infer<typeof PaymentMonthOutcome>;

/**
 * `HELD`: due, but not paid while something holds it (a past due balance, a frozen or paused
 * plan). `CANCELLED`: never paid and never will be; its installments are voided.
 */
export const PayoutStatus = z.enum(['SCHEDULED', 'HELD', 'PAID', 'FAILED', 'CANCELLED']);
export type PayoutStatus = z.infer<typeof PayoutStatus>;

/**
 * `CHARGED_OFF`: written off as a loss, still owed and still payable. `VOIDED`: never owed,
 * because the landlord payout it belonged to was cancelled or came back.
 */
export const InstallmentStatus = z.enum([
  'SCHEDULED',
  'PAID',
  'FAILED',
  'LATE',
  'CHARGED_OFF',
  'VOIDED',
]);
export type InstallmentStatus = z.infer<typeof InstallmentStatus>;

/** `RETURNED`: the debit went through and the bank later sent it back. */
export const RepaymentStatus = z.enum(['SUCCEEDED', 'FAILED', 'RETURNED']);
export type RepaymentStatus = z.infer<typeof RepaymentStatus>;

/** Where a plan stands, from the age of its oldest unpaid installment. */
export const DelinquencyStatus = z.enum([
  'CURRENT',
  'GRACE',
  'DELINQUENT',
  'DEFAULT',
  'CHARGED_OFF',
]);
export type DelinquencyStatus = z.infer<typeof DelinquencyStatus>;

/** Why a landlord payout is, or was, held. */
export const PayoutHoldReason = z.enum([
  /** An earlier installment is past the grace period. */
  'PAST_DUE',
  /** The plan is frozen: a periodic review, an unauthorized return, or a returned payout. */
  'ADVANCE_FROZEN',
  /** The owner paused the plan. */
  'PLAN_PAUSED',
  /** The plan was closed before the payout fell due. */
  'PLAN_CLOSED',
  /** Not held by anything, but not paid within the release window (no capital, provider down). */
  'NOT_PAID_IN_TIME',
  /** A change to the landlord's details on the lease is inside its waiting period. */
  'LEASE_CHANGE_PENDING',
  /** The lease's rent went up past the approved amount and a new decision is needed. */
  'RENT_INCREASE_PENDING',
  /** The landlord was already paid for this month, by this plan or another on the lease. */
  'PERIOD_ALREADY_PAID',
]);
export type PayoutHoldReason = z.infer<typeof PayoutHoldReason>;

export const LedgerAccountType = z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);
export type LedgerAccountType = z.infer<typeof LedgerAccountType>;

export const LedgerDirection = z.enum(['DEBIT', 'CREDIT']);
export type LedgerDirection = z.infer<typeof LedgerDirection>;

export const ProviderName = z.enum(['mock', 'plaid', 'stripe']);
export type ProviderName = z.infer<typeof ProviderName>;

/** Where identity verification of a business or an owner stands. Operator facing. */
export const VerificationStatus = z.enum(['UNVERIFIED', 'VERIFIED', 'REVIEW', 'FAILED']);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

/** Result of screening a name against sanctions and watchlists. Operator facing. */
export const ScreeningOutcome = z.enum(['CLEAR', 'POSSIBLE_MATCH', 'MATCH']);
export type ScreeningOutcome = z.infer<typeof ScreeningOutcome>;

export const ScreeningPartyType = z.enum(['BUSINESS', 'OWNER', 'LANDLORD']);
export type ScreeningPartyType = z.infer<typeof ScreeningPartyType>;

export const LeaseChangeStatus = z.enum(['PENDING', 'APPLIED', 'CANCELLED', 'REJECTED']);
export type LeaseChangeStatus = z.infer<typeof LeaseChangeStatus>;

export const AlertSeverity = z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL']);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

export const AlertStatus = z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const AlertCategory = z.enum(['FRAUD', 'PAYMENTS', 'PORTFOLIO', 'BOOKS', 'COMPLIANCE']);
export type AlertCategory = z.infer<typeof AlertCategory>;

/** Who is calling an operator route. `admin` can do everything a `reviewer` can. */
export const AdminRole = z.enum(['reviewer', 'admin']);
export type AdminRole = z.infer<typeof AdminRole>;

/**
 * Data connections and their provenance.
 *
 * Every connection records how its data is obtained, and that method is used everywhere
 * downstream: in the trust tier, in what underwriting lets the source verify, and in what the
 * owner and an operator are shown. There is no upload method on purpose: CashFlow pulls the
 * data itself or does not use it. See `apps/api/DATA_CONNECTIONS.md`.
 *
 *   DIRECT_OAUTH    The owner approved read-only access on the platform's own site. CashFlow
 *                   holds the platform-issued token and calls the platform API itself.
 *   DELEGATED_SEAT  The owner invited CashFlow's own read-only service user onto the account.
 *                   CashFlow's agent signs in with CashFlow's credentials for that seat. The
 *                   owner's password is never shared.
 *   AGGREGATOR      A bank data aggregator's connection, authorized at the bank.
 */
export const ConnectionAccessMethod = z.enum(['DIRECT_OAUTH', 'DELEGATED_SEAT', 'AGGREGATOR']);
export type ConnectionAccessMethod = z.infer<typeof ConnectionAccessMethod>;

/**
 * How far a source can be trusted, derived from the access method and from what the veracity
 * checks found. Never chosen by the applicant.
 */
export const TrustTier = z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']);
export type TrustTier = z.infer<typeof TrustTier>;

/** Where a connection stands for pulling data. */
export const ConnectionHealth = z.enum([
  /** Pulls work. */
  'HEALTHY',
  /** Waiting on the owner: an OAuth approval or a seat invitation that is not active yet. */
  'PENDING',
  /** The token expired and could not be refreshed, or consent lapsed: the owner reconnects. */
  'REAUTH_REQUIRED',
  /** The last pull failed. Nothing partial was stored. */
  'ERROR',
  /** Disconnected by the owner, or revoked at the platform. */
  'REVOKED',
]);
export type ConnectionHealth = z.infer<typeof ConnectionHealth>;

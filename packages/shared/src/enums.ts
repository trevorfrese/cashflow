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

/** Why a decision row exists: the engine ran, a reviewer decided, or a periodic review ran. */
export const DecisionKind = z.enum(['ENGINE', 'REVIEW', 'PERIODIC_REVIEW']);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const LeaseStatus = z.enum(['DRAFT', 'ACTIVE', 'ENDED']);
export type LeaseStatus = z.infer<typeof LeaseStatus>;

export const RentPlanStatus = z.enum(['ACTIVE', 'PAUSED', 'CLOSED']);
export type RentPlanStatus = z.infer<typeof RentPlanStatus>;

export const PayoutStatus = z.enum(['SCHEDULED', 'PROCESSING', 'PAID', 'FAILED']);
export type PayoutStatus = z.infer<typeof PayoutStatus>;

export const InstallmentStatus = z.enum(['SCHEDULED', 'COLLECTING', 'PAID', 'FAILED', 'LATE']);
export type InstallmentStatus = z.infer<typeof InstallmentStatus>;

export const RepaymentStatus = z.enum(['PENDING', 'SUCCEEDED', 'FAILED']);
export type RepaymentStatus = z.infer<typeof RepaymentStatus>;

export const LedgerAccountType = z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);
export type LedgerAccountType = z.infer<typeof LedgerAccountType>;

export const LedgerDirection = z.enum(['DEBIT', 'CREDIT']);
export type LedgerDirection = z.infer<typeof LedgerDirection>;

export const ProviderName = z.enum(['mock', 'plaid', 'stripe']);
export type ProviderName = z.infer<typeof ProviderName>;

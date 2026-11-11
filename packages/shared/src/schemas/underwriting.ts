import { z } from 'zod';

import { CashFlowSummary } from './bank-data';

import { ApplicationStatus, DecisionKind, DecisionOutcome, ReviewDecision } from '../enums';
import { Bps, Cents, Id, IsoDateTimeSchema } from './common';

export const CreateApplicationRequest = z.object({
  businessId: Id,
  statedMonthlyRevenueCents: Cents,
  timeInBusinessMonths: z.number().int().min(0).max(1200),
  requestedMonthlyRentCents: Cents.refine((v) => v > 0, 'Rent must be greater than zero'),
  bankLinkId: Id.optional(),
  commerceLinkId: Id.optional(),
});
export type CreateApplicationRequest = z.infer<typeof CreateApplicationRequest>;

export const ReasonImpact = z.enum(['POSITIVE', 'NEGATIVE', 'INFO']);
export type ReasonImpact = z.infer<typeof ReasonImpact>;

/**
 * One factor behind a decision. Codes are stable identifiers in the spirit of adverse
 * action reason codes; messages are written for the applicant.
 */
export const DecisionReason = z.object({
  code: z.string(),
  message: z.string(),
  impact: ReasonImpact,
});
export type DecisionReason = z.infer<typeof DecisionReason>;

export const CreditGrade = z.enum(['A', 'B', 'C', 'D', 'F']);
export type CreditGrade = z.infer<typeof CreditGrade>;

export const UnderwritingDecision = z.object({
  id: Id,
  applicationId: Id,
  outcome: DecisionOutcome,
  /** Maximum monthly rent CashFlow will front. Present when approved. */
  approvedMonthlyLimitCents: Cents.nullable(),
  /** Fee charged per period, in basis points of rent. Present when approved. */
  feeBps: Bps.nullable(),
  /** CashFlow score, 0 to 100. Null when there was not enough data to score. */
  score: z.number().int().min(0).max(100).nullable(),
  grade: CreditGrade.nullable(),
  /** How many installments per month the engine suggests given cash flow timing. */
  recommendedInstallmentsPerMonth: z.number().int().min(1).max(4).nullable(),
  reasons: z.array(DecisionReason),
  /** Features the decision was based on. Null when no bank data was available. */
  cashFlow: CashFlowSummary.nullable(),
  /** Which provider produced the decision (for example "cashflow"). */
  provider: z.string(),
  /** Version of the credit policy that made the decision (for example "cashflow-v2"). */
  policyVersion: z.string().optional(),
  /** Whether the engine, a reviewer, or a periodic review produced it. */
  kind: DecisionKind.optional(),
  decidedAt: IsoDateTimeSchema,
});
export type UnderwritingDecision = z.infer<typeof UnderwritingDecision>;

export const UnderwritingApplication = CreateApplicationRequest.extend({
  id: Id,
  status: ApplicationStatus,
  submittedAt: IsoDateTimeSchema.nullable(),
  decision: UnderwritingDecision.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type UnderwritingApplication = z.infer<typeof UnderwritingApplication>;

/**
 * Reason codes a reviewer picks from. At least one is required whenever the reviewer's
 * outcome or terms differ from the engine's recommendation.
 */
export const ReviewReasonCode = z.enum([
  'LEASE_VERIFIED',
  'REVENUE_VERIFIED_OTHER_SOURCE',
  'IDENTITY_VERIFIED',
  'INTEGRITY_FLAG_CLEARED',
  'INTEGRITY_FLAG_CONFIRMED',
  'FRAUD_SUSPECTED',
  'DOCUMENTS_NOT_PROVIDED',
  'COMPENSATING_FACTORS',
  'EXPOSURE_ADJUSTED',
  'PRICING_ADJUSTED',
  'OTHER',
]);
export type ReviewReasonCode = z.infer<typeof ReviewReasonCode>;

/**
 * A reviewer's decision. Who reviewed is not in the body: it is the person named in the
 * `X-Admin-Actor` header of the authenticated request.
 */
export const RecordReviewRequest = z.object({
  decision: ReviewDecision,
  reasonCodes: z.array(ReviewReasonCode).max(10).default([]),
  /** Internal notes. Never shown to the applicant. */
  notes: z.string().max(2000).optional(),
  /** What the applicant is asked to provide. Required with REQUEST_INFO, shown to them. */
  applicantMessage: z.string().min(1).max(500).optional(),
  /** Approve at this limit instead of the engine's recommended one. */
  approvedMonthlyLimitCents: Cents.optional(),
  /** Approve at this fee instead of the engine's recommended one. */
  feeBps: Bps.optional(),
});
export type RecordReviewRequest = z.infer<typeof RecordReviewRequest>;

export const ApplicationReview = z.object({
  id: Id,
  applicationId: Id,
  reviewer: z.string(),
  decision: ReviewDecision,
  reasonCodes: z.array(z.string()),
  notes: z.string().nullable(),
  approvedMonthlyLimitCents: Cents.nullable(),
  feeBps: Bps.nullable(),
  /** The reviewer's outcome or terms differed from the engine's recommendation. */
  isOverride: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type ApplicationReview = z.infer<typeof ApplicationReview>;

/** One integrity finding, as an operator sees it. Never sent to applicants. */
export const IntegrityFlagView = z.object({
  code: z.string(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  action: z.enum(['KNOCKOUT', 'REFER', 'CAP', 'NEEDS_INFO', 'INFORM']),
  detail: z.string(),
});
export type IntegrityFlagView = z.infer<typeof IntegrityFlagView>;

/** An application waiting for a reviewer, with what the engine found. Operator only. */
export const ReviewQueueItem = z.object({
  applicationId: Id,
  businessId: Id,
  businessName: z.string(),
  status: ApplicationStatus,
  requestedMonthlyRentCents: Cents,
  submittedAt: IsoDateTimeSchema.nullable(),
  policyVersion: z.string(),
  score: z.number().int().nullable(),
  grade: CreditGrade.nullable(),
  /** What the engine would have done without the referral. */
  recommendedOutcome: DecisionOutcome,
  recommendedMonthlyLimitCents: Cents.nullable(),
  recommendedFeeBps: Bps.nullable(),
  referTriggers: z.array(z.string()),
  integrityFlags: z.array(IntegrityFlagView),
  reasons: z.array(DecisionReason),
});
export type ReviewQueueItem = z.infer<typeof ReviewQueueItem>;

export const RecordReviewResponse = z.object({
  review: ApplicationReview,
  application: UnderwritingApplication,
});
export type RecordReviewResponse = z.infer<typeof RecordReviewResponse>;

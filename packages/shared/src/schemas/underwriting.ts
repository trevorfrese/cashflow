import { z } from 'zod';

import { CashFlowSummary } from './bank-data';

import { ApplicationStatus, DecisionOutcome } from '../enums';
import { Bps, Cents, Id, IsoDateTimeSchema } from './common';

export const CreateApplicationRequest = z.object({
  businessId: Id,
  statedMonthlyRevenueCents: Cents,
  timeInBusinessMonths: z.number().int().min(0).max(1200),
  requestedMonthlyRentCents: Cents.refine((v) => v > 0, 'Rent must be greater than zero'),
  bankLinkId: Id.optional(),
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
  /** Which provider produced the decision (for example "cashflow-v1"). */
  provider: z.string(),
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

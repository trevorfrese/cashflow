import { z } from 'zod';

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

export const DecisionReason = z.object({
  code: z.string(),
  message: z.string(),
});
export type DecisionReason = z.infer<typeof DecisionReason>;

export const UnderwritingDecision = z.object({
  id: Id,
  applicationId: Id,
  outcome: DecisionOutcome,
  /** Maximum monthly rent CashFlow will front. Present when approved. */
  approvedMonthlyLimitCents: Cents.nullable(),
  /** Fee charged per period, in basis points of rent. Present when approved. */
  feeBps: Bps.nullable(),
  reasons: z.array(DecisionReason),
  /** Which provider produced the decision (for example "mock"). */
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

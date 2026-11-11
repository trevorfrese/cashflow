import { z } from 'zod';

import {
  LeaseChangeStatus,
  ScreeningOutcome,
  ScreeningPartyType,
  VerificationStatus,
} from '../enums';
import { Cents, Id, IsoDateSchema, IsoDateTimeSchema, PeriodMonth } from './common';
import { LeaseChangeField } from './lease';

/**
 * Operator views of identity verification, screening, and lease change control. None of
 * these shapes is ever sent to a business owner: the owner sees `Business.verification`,
 * `Lease.pendingChange`, and `LandlordPayout.heldMessage`.
 */

/** One screening of one party against sanctions and watchlists. */
export const ScreeningResult = z.object({
  id: Id,
  businessId: Id,
  businessName: z.string(),
  partyType: ScreeningPartyType,
  /** Business id, beneficial owner id, or lease id, by party type. */
  partyRef: Id,
  nameScreened: z.string(),
  country: z.string().nullable(),
  result: ScreeningOutcome,
  provider: z.string(),
  /** The provider's reference for the match. */
  providerRef: z.string().nullable(),
  /** Set when the name is the proposed landlord on a lease change that has not applied. */
  leaseChangeId: Id.nullable(),
  screenedAt: IsoDateTimeSchema,
  /** A later screening of the same party replaced this one. */
  supersededAt: IsoDateTimeSchema.nullable(),
  clearedBy: z.string().nullable(),
  clearedAt: IsoDateTimeSchema.nullable(),
  clearedReason: z.string().nullable(),
  /** True for a current POSSIBLE_MATCH or MATCH that nobody has cleared. */
  open: z.boolean(),
  /** Plans frozen from further advances because of this hit. */
  frozenRentPlanIds: z.array(Id),
});
export type ScreeningResult = z.infer<typeof ScreeningResult>;

export const ClearScreeningRequest = z.object({
  /** Why the hit is not the party: what was checked. Stored and audited. */
  reason: z.string().trim().min(3).max(1000),
});
export type ClearScreeningRequest = z.infer<typeof ClearScreeningRequest>;

/** Verification state of a business as an operator sees it. */
export const BusinessIdentityView = z.object({
  businessId: Id,
  legalName: z.string(),
  taxIdLast4: z.string().nullable(),
  verificationStatus: VerificationStatus,
  verificationCheckedAt: IsoDateTimeSchema.nullable(),
  verificationProvider: z.string().nullable(),
  verificationRef: z.string().nullable(),
  verificationReasons: z.array(z.string()),
  owners: z.array(
    z.object({
      id: Id,
      fullName: z.string(),
      title: z.string(),
      ownershipBps: z.number().int(),
      verificationStatus: VerificationStatus,
      verificationRef: z.string().nullable(),
    }),
  ),
});
export type BusinessIdentityView = z.infer<typeof BusinessIdentityView>;

/** Landlord and payout details as shown to an operator. Never the payout token. */
export const LandlordDetailsView = z.object({
  landlordName: z.string().optional(),
  landlordEmail: z.string().optional(),
  accountHolderName: z.string().optional(),
  routingNumber: z.string().optional(),
  accountNumberLast4: z.string().optional(),
  /** True when the opaque payout destination changes. The token itself is not shown. */
  payoutTokenChanged: z.boolean().optional(),
});
export type LandlordDetailsView = z.infer<typeof LandlordDetailsView>;

/** A requested change to a lease's landlord or payout account, for the review queue. */
export const LeaseChangeView = z.object({
  id: Id,
  leaseId: Id,
  businessId: Id,
  businessName: z.string(),
  status: LeaseChangeStatus,
  fields: z.array(LeaseChangeField),
  previous: LandlordDetailsView,
  proposed: LandlordDetailsView,
  requestedByUserId: Id,
  requestedAt: IsoDateTimeSchema,
  effectiveOn: IsoDateSchema,
  appliedAt: IsoDateTimeSchema.nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: IsoDateTimeSchema.nullable(),
  decisionReason: z.string().nullable(),
  cancelledAt: IsoDateTimeSchema.nullable(),
  /** Screening of the proposed landlord, when it has run. */
  screening: z.object({ id: Id, result: ScreeningOutcome, cleared: z.boolean() }).nullable(),
  /** Payouts on the lease that are held or fall due before the change takes effect. */
  affectedPayouts: z.array(
    z.object({
      id: Id,
      periodMonth: PeriodMonth,
      scheduledFor: IsoDateSchema,
      amountCents: Cents,
      status: z.string(),
    }),
  ),
});
export type LeaseChangeView = z.infer<typeof LeaseChangeView>;

export const DecideLeaseChangeRequest = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().min(3).max(1000),
});
export type DecideLeaseChangeRequest = z.infer<typeof DecideLeaseChangeRequest>;

export const ResendPayoutRequest = z.object({
  /** What was corrected and how it was confirmed with the landlord. */
  reason: z.string().trim().min(3).max(1000),
});
export type ResendPayoutRequest = z.infer<typeof ResendPayoutRequest>;

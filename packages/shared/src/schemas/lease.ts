import { z } from 'zod';

import { LeaseChangeStatus, LeaseStatus } from '../enums';
import { Address, Cents, DueDayOfMonth, Id, IsoDateSchema, IsoDateTimeSchema } from './common';

/**
 * Where the landlord gets paid. In mock mode nothing is validated beyond shape.
 * A real PaymentsProvider would tokenize this and store only a reference.
 */
export const LandlordPayoutDetails = z.object({
  accountHolderName: z.string().min(1).max(120),
  routingNumber: z.string().regex(/^\d{9}$/, 'Routing number is 9 digits'),
  accountNumberLast4: z.string().regex(/^\d{4}$/),
  /** Opaque provider token, for example a Stripe external account id. Mock accepts anything. */
  providerToken: z.string().min(1),
});
export type LandlordPayoutDetails = z.infer<typeof LandlordPayoutDetails>;

export const CreateLeaseRequest = z.object({
  businessId: Id,
  landlordName: z.string().min(1).max(200),
  landlordEmail: z.string().email().max(254),
  propertyAddress: Address,
  monthlyRentCents: Cents.refine((v) => v > 0, 'Rent must be greater than zero'),
  dueDayOfMonth: DueDayOfMonth,
  startsOn: IsoDateSchema,
  endsOn: IsoDateSchema.nullable().optional(),
  landlordPayout: LandlordPayoutDetails,
});
export type CreateLeaseRequest = z.infer<typeof CreateLeaseRequest>;

export const UpdateLeaseRequest = CreateLeaseRequest.omit({ businessId: true }).partial();
export type UpdateLeaseRequest = z.infer<typeof UpdateLeaseRequest>;

/** The parts of a lease that decide who gets paid. A change to any of them is controlled. */
export const LeaseChangeField = z.enum(['landlordName', 'landlordEmail', 'landlordPayout']);
export type LeaseChangeField = z.infer<typeof LeaseChangeField>;

/**
 * A change to the landlord or the landlord's payout account that is waiting to take effect.
 * On a lease with a running plan such a change does not apply at once: it waits out a short
 * period, and rent payments to the landlord are held until it has.
 */
export const PendingLeaseChange = z.object({
  id: Id,
  status: LeaseChangeStatus,
  fields: z.array(LeaseChangeField),
  requestedAt: IsoDateTimeSchema,
  /** The date the change takes effect if nothing stops it. */
  effectiveOn: IsoDateSchema,
  /** Plain words for the owner. */
  message: z.string(),
});
export type PendingLeaseChange = z.infer<typeof PendingLeaseChange>;

/**
 * A rent increase the current approval does not cover. CashFlow fronts a whole month's rent
 * or nothing, so rent payments on the plan are held until a new decision covers the new
 * rent, or the rent on the lease is put back.
 */
export const PendingRentIncrease = z.object({
  rentPlanId: Id,
  /** The rent the plan was approved and priced for. */
  currentRentCents: Cents,
  /** The new rent on the lease. */
  requestedRentCents: Cents,
  message: z.string(),
});
export type PendingRentIncrease = z.infer<typeof PendingRentIncrease>;

export const Lease = CreateLeaseRequest.omit({ landlordPayout: true }).extend({
  id: Id,
  status: LeaseStatus,
  /** Masked payout details. Never the full account number. */
  landlordPayout: LandlordPayoutDetails.omit({ providerToken: true }),
  /** A landlord or payout change waiting to take effect, if there is one. */
  pendingChange: PendingLeaseChange.nullable(),
  /** A rent increase waiting for a new decision, if there is one. */
  pendingRentIncrease: PendingRentIncrease.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Lease = z.infer<typeof Lease>;

import { z } from 'zod';

import { LeaseStatus } from '../enums';
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

export const Lease = CreateLeaseRequest.omit({ landlordPayout: true }).extend({
  id: Id,
  status: LeaseStatus,
  /** Masked payout details. Never the full account number. */
  landlordPayout: LandlordPayoutDetails.omit({ providerToken: true }),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Lease = z.infer<typeof Lease>;

import { z } from 'zod';

import { InstallmentStatus, PayoutStatus, RentPlanStatus, RepaymentStatus } from '../enums';
import { Bps, Cents, Id, IsoDateSchema, IsoDateTimeSchema, PeriodMonth } from './common';

export const CreateRentPlanRequest = z.object({
  leaseId: Id,
  applicationId: Id,
  installmentsPerMonth: z.number().int().min(1).max(4).default(2),
});
export type CreateRentPlanRequest = z.infer<typeof CreateRentPlanRequest>;

export const LandlordPayout = z.object({
  id: Id,
  rentPlanId: Id,
  periodMonth: PeriodMonth,
  amountCents: Cents,
  scheduledFor: IsoDateSchema,
  status: PayoutStatus,
  paidAt: IsoDateTimeSchema.nullable(),
  providerRef: z.string().nullable(),
  failureReason: z.string().nullable(),
});
export type LandlordPayout = z.infer<typeof LandlordPayout>;

export const Installment = z.object({
  id: Id,
  rentPlanId: Id,
  payoutId: Id,
  periodMonth: PeriodMonth,
  sequence: z.number().int().min(1),
  principalCents: Cents,
  feeCents: Cents,
  totalCents: Cents,
  dueDate: IsoDateSchema,
  status: InstallmentStatus,
  paidAt: IsoDateTimeSchema.nullable(),
});
export type Installment = z.infer<typeof Installment>;

export const Repayment = z.object({
  id: Id,
  installmentId: Id,
  amountCents: Cents,
  provider: z.string(),
  providerRef: z.string().nullable(),
  status: RepaymentStatus,
  failureReason: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Repayment = z.infer<typeof Repayment>;

export const RentPlan = z.object({
  id: Id,
  businessId: Id,
  leaseId: Id,
  applicationId: Id,
  installmentsPerMonth: z.number().int().min(1).max(4),
  feeBps: Bps,
  monthlyRentCents: Cents,
  dueDayOfMonth: z.number().int().min(1).max(31),
  status: RentPlanStatus,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type RentPlan = z.infer<typeof RentPlan>;

export const RentPlanDetail = RentPlan.extend({
  nextInstallment: Installment.nullable(),
  nextPayout: LandlordPayout.nullable(),
  upcomingInstallments: z.array(Installment),
  payouts: z.array(LandlordPayout),
});
export type RentPlanDetail = z.infer<typeof RentPlanDetail>;

/**
 * Settings the owner can change on a running plan. A new cadence applies to periods generated
 * after the change; a paused plan skips landlord payouts and collections until it is resumed.
 */
export const UpdateRentPlanRequest = z.object({
  installmentsPerMonth: z.number().int().min(1).max(4).optional(),
  status: z.enum(['ACTIVE', 'PAUSED']).optional(),
});
export type UpdateRentPlanRequest = z.infer<typeof UpdateRentPlanRequest>;

export const PayInstallmentRequest = z.object({
  installmentId: Id,
});
export type PayInstallmentRequest = z.infer<typeof PayInstallmentRequest>;

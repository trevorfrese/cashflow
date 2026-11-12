import { z } from 'zod';

import {
  DelinquencyStatus,
  InstallmentStatus,
  PayoutHoldReason,
  PayoutStatus,
  RentPlanKind,
  RentPlanStatus,
  RepaymentStatus,
} from '../enums';
import { Bps, Cents, Id, IsoDateSchema, IsoDateTimeSchema, PeriodMonth } from './common';
import { GraduationOffer, PassThroughPeriod } from './pass-through';

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
  /** Why the payout is held, or was when it was cancelled. Null when it was never held. */
  heldReason: PayoutHoldReason.nullable(),
  /**
   * Why the payout is held, in plain words for the owner. Null when it is not held. It never
   * says more than the owner needs: a hold for a review says the account is under review.
   */
  heldMessage: z.string().nullable(),
  heldAt: IsoDateTimeSchema.nullable(),
  /**
   * Last calendar date on which a held payout can still be released and paid. After it the
   * payout is cancelled and the business pays the landlord for that month itself.
   */
  releaseBy: IsoDateSchema.nullable(),
  cancelledAt: IsoDateTimeSchema.nullable(),
  /** Bank return code when the payout came back from the landlord's account, for example R03. */
  returnCode: z.string().nullable(),
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
  /** Set when the installment was written off. It stays set if the installment is paid later. */
  chargedOffAt: IsoDateTimeSchema.nullable(),
  /** Automatic debits made so far on the current bank account, and the most the policy allows. */
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1).nullable(),
  /**
   * Why the last scheduled debit was not attempted (`INSUFFICIENT_BALANCE`, `NO_BANK_LINK`),
   * and the date. Null once a debit has been attempted since.
   */
  collectionSkipReason: z.string().nullable(),
  collectionSkippedOn: IsoDateSchema.nullable(),
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
  /** Bank return code, for example R01, on a failed or returned debit. */
  returnCode: z.string().nullable(),
  returnedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Repayment = z.infer<typeof Repayment>;

export const RentPlan = z.object({
  id: Id,
  /** FINANCED or PASS_THROUGH. A pass-through plan has no fee, payouts or installments. */
  kind: RentPlanKind,
  businessId: Id,
  leaseId: Id,
  applicationId: Id,
  installmentsPerMonth: z.number().int().min(1).max(4),
  feeBps: Bps,
  monthlyRentCents: Cents,
  dueDayOfMonth: z.number().int().min(1).max(31),
  status: RentPlanStatus,
  /**
   * True when the plan is frozen (a periodic review, an unauthorized return, a returned
   * landlord payout): no new rent period is generated or paid to the landlord until a
   * reviewer releases it. Rent already fronted is still collected.
   */
  advanceFrozen: z.boolean().optional(),
  /** Where the plan stands today, from the age of its oldest unpaid installment. */
  delinquencyStatus: DelinquencyStatus,
  /** Days the oldest unpaid installment is past its due date today. 0 when nothing is. */
  daysPastDue: z.number().int().min(0),
  /** Total of the installments that are past due today, fees included. */
  pastDueCents: Cents,
  /**
   * True when automatic debits have stopped and the business has to act: the bank account
   * link is gone or was disabled by a return, or an installment has used all its attempts.
   */
  needsPayment: z.boolean(),
  closedAt: IsoDateTimeSchema.nullable(),
  /** Why the plan was closed, for example `CHARGED_OFF`. */
  closedReason: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type RentPlan = z.infer<typeof RentPlan>;

export const RentPlanDetail = RentPlan.extend({
  nextInstallment: Installment.nullable(),
  nextPayout: LandlordPayout.nullable(),
  upcomingInstallments: z.array(Installment),
  payouts: z.array(LandlordPayout),
  /** The payout that is held right now, if any, with the reason and the release deadline. */
  heldPayout: LandlordPayout.nullable(),
  /** Pass-through plans only: the month in progress and every month. Null on a financed plan. */
  passThrough: z
    .object({
      /** The next month not yet paid to the landlord, or null. */
      nextPeriod: PassThroughPeriod.nullable(),
      periods: z.array(PassThroughPeriod),
    })
    .nullable(),
  /** An open offer to move this pass-through plan onto a financed plan. */
  graduationOffer: GraduationOffer.nullable(),
});
export type RentPlanDetail = z.infer<typeof RentPlanDetail>;

/**
 * Settings the owner can change on a running plan. A new cadence applies to periods generated
 * after the change. A paused plan gets no new landlord payouts until it is resumed; rent already
 * paid to the landlord is still collected on schedule.
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

/** One row of the delinquency summary: plans and principal in a bucket, and the reserve held. */
export const DelinquencyBucketSummary = z.object({
  status: DelinquencyStatus,
  plans: z.number().int().min(0),
  /** Principal outstanding (rent paid to landlords and not repaid or written off). */
  principalCents: Cents,
  /** Reserve rate the servicing policy applies to this bucket. Null for CHARGED_OFF. */
  provisionRateBps: Bps.nullable(),
  /** Allowance the policy calls for on this bucket today. */
  requiredReserveCents: Cents,
});
export type DelinquencyBucketSummary = z.infer<typeof DelinquencyBucketSummary>;

/** Operator view of the book: delinquency by bucket and the loss accounts. */
export const DelinquencySummary = z.object({
  asOf: IsoDateSchema,
  servicingPolicy: z.string(),
  buckets: z.array(DelinquencyBucketSummary),
  /** Sum of the receivable accounts in the ledger. */
  receivableCents: z.number().int(),
  /** Balance of the allowance for credit losses. */
  allowanceCents: z.number().int(),
  /** What the policy says the allowance should be today. */
  requiredAllowanceCents: Cents,
  netReceivableCents: z.number().int(),
  /** To date. */
  provisionExpenseCents: z.number().int(),
  chargedOffCents: Cents,
  chargedOffPlans: z.number().int().min(0),
  recoveredCents: Cents,
  heldPayouts: z.number().int().min(0),
  frozenPlans: z.number().int().min(0),
});
export type DelinquencySummary = z.infer<typeof DelinquencySummary>;

/** The reviewer is the person named in the `X-Admin-Actor` header, not a body field. */
export const ReleaseFreezeRequest = z.object({
  reason: z.string().min(1).max(500),
});
export type ReleaseFreezeRequest = z.infer<typeof ReleaseFreezeRequest>;

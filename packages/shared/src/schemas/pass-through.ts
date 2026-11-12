import { z } from 'zod';

import {
  GraduationOfferStatus,
  PassThroughPeriodStatus,
  PaymentMonthOutcome,
  RentPlanKind,
} from '../enums';
import { Bps, Cents, Id, IsoDateSchema, IsoDateTimeSchema, PeriodMonth } from './common';

/**
 * The free pass-through plan, payment history, and graduation to a financed plan.
 *
 * A business declined for credit capacity can start a pass-through plan on its lease: CashFlow
 * collects the month's rent from its bank a few business days before the due date and pays
 * the landlord on the due date once that collection has settled. No fee and no late fee.
 * On time months build a payment history, and once there are enough of them CashFlow
 * re-underwrites the business and may offer a financed plan.
 */

/** Why a declined application is not offered a pass-through plan. */
export const PassThroughIneligibleReason = z.enum([
  'NOT_DECLINED',
  'REVIEWED',
  'TRUST_DECLINE',
  'NO_CAPACITY_REASON',
]);
export type PassThroughIneligibleReason = z.infer<typeof PassThroughIneligibleReason>;

/** `GET /v1/underwriting/applications/:id/pass-through`: the offer on a declined application. */
export const PassThroughOffer = z.object({
  applicationId: Id,
  eligible: z.boolean(),
  /** Why not, when not eligible. Never names a rule the owner cannot act on. */
  ineligibleReason: PassThroughIneligibleReason.nullable(),
  /** The rent the plan would carry: the application's requested rent. */
  monthlyRentCents: Cents,
  /** Always zero. Stated so the client never has to assume it. */
  feeCents: Cents,
  /** Business days before the due date that the rent is collected. */
  collectionLeadBusinessDays: z.number().int().min(1),
  /** Business days a collection takes to settle before the landlord is paid. */
  settlementBusinessDays: z.number().int().min(1),
  /** On time months before CashFlow looks again at a financed plan. */
  monthsToReview: z.number().int().min(1),
  /** Plain words for the owner. */
  headline: z.string(),
  explanation: z.string(),
  /** A pass-through plan already running for this application, if any. */
  existingPlanId: Id.nullable(),
});
export type PassThroughOffer = z.infer<typeof PassThroughOffer>;

export const StartPassThroughPlanRequest = z.object({
  applicationId: Id,
  leaseId: Id,
});
export type StartPassThroughPlanRequest = z.infer<typeof StartPassThroughPlanRequest>;

/** One month of a pass-through plan, as the owner sees it. */
export const PassThroughPeriod = z.object({
  id: Id,
  rentPlanId: Id,
  periodMonth: PeriodMonth,
  amountCents: Cents,
  /** The day the landlord is due to be paid. */
  dueDate: IsoDateSchema,
  /** The first day the rent is debited from the business. */
  collectOn: IsoDateSchema,
  /** The last day a debit can still be made in time. */
  lastCollectOn: IsoDateSchema,
  status: PassThroughPeriodStatus,
  collectedOn: IsoDateSchema.nullable(),
  /** When the collection is treated as settled. */
  settlesOn: IsoDateSchema.nullable(),
  /** The day the landlord was paid, when it was. */
  paidOn: IsoDateSchema.nullable(),
  landlordPaid: z.boolean(),
  /** Why a settled payout is waiting, when it is. */
  heldReason: z.string().nullable(),
  /** Why the month was missed, when it was. */
  missedReason: z.string().nullable(),
  returnCode: z.string().nullable(),
  /** What the owner needs to know about this month, in plain words. */
  message: z.string(),
});
export type PassThroughPeriod = z.infer<typeof PassThroughPeriod>;

/** An offer to move from a pass-through plan to a financed plan. */
export const GraduationOffer = z.object({
  id: Id,
  businessId: Id,
  passThroughPlanId: Id,
  status: GraduationOfferStatus,
  /** The lease rent the financed plan would front each month. */
  monthlyRentCents: Cents,
  approvedMonthlyLimitCents: Cents,
  feeBps: Bps,
  /** The fee in dollars and cents per month at the lease rent. */
  feeCentsPerMonth: Cents,
  installmentsPerMonth: z.number().int().min(1).max(4),
  /** On time pass-through months in a row when the offer was made. */
  onTimeMonths: z.number().int().min(0),
  offeredOn: IsoDateSchema,
  expiresOn: IsoDateSchema,
  acceptedOn: IsoDateSchema.nullable(),
  /** YYYY-MM of the first financed month, once it is known. */
  effectivePeriod: PeriodMonth.nullable(),
  financedPlanId: Id.nullable(),
  /** Plain words for the owner. */
  message: z.string(),
});
export type GraduationOffer = z.infer<typeof GraduationOffer>;

export const AcceptGraduationOfferRequest = z.object({
  /** Installments per month on the financed plan. The offer's recommendation by default. */
  installmentsPerMonth: z.number().int().min(1).max(4).optional(),
});
export type AcceptGraduationOfferRequest = z.infer<typeof AcceptGraduationOfferRequest>;

/** One month of rent through CashFlow, on either kind of plan. */
export const PaymentHistoryMonth = z.object({
  rentPlanId: Id,
  kind: RentPlanKind,
  periodMonth: PeriodMonth,
  dueDate: IsoDateSchema,
  outcome: PaymentMonthOutcome,
});
export type PaymentHistoryMonth = z.infer<typeof PaymentHistoryMonth>;

export const PaymentHistorySummary = z.object({
  months: z.number().int().min(0),
  onTimeMonths: z.number().int().min(0),
  lateMonths: z.number().int().min(0),
  missedMonths: z.number().int().min(0),
  currentOnTimeStreak: z.number().int().min(0),
  lastMissedPeriod: PeriodMonth.nullable(),
});
export type PaymentHistorySummary = z.infer<typeof PaymentHistorySummary>;

/**
 * `GET /v1/businesses/:id/payment-history`. Derived on every read from repayment and
 * pass-through facts, never entered by hand.
 */
export const PaymentHistory = z.object({
  businessId: Id,
  asOf: IsoDateSchema,
  /** Months that count toward the summary. */
  lookbackMonths: z.number().int().min(1),
  summary: PaymentHistorySummary,
  /** Every month with an outcome, newest first, including those outside the lookback. */
  months: z.array(PaymentHistoryMonth),
  /**
   * For a business on a pass-through plan: on time months still needed before CashFlow
   * looks again at a financed plan. Null otherwise.
   */
  monthsUntilReview: z.number().int().min(0).nullable(),
  /** The open graduation offer, if there is one. */
  graduationOffer: GraduationOffer.nullable(),
  generatedAt: IsoDateTimeSchema,
});
export type PaymentHistory = z.infer<typeof PaymentHistory>;

import { z } from 'zod';

import { DelinquencyStatus, RentPlanKind, RentPlanStatus } from '../enums';
import { Cents, Id, IsoDateSchema, IsoDateTimeSchema } from './common';

/**
 * Operator controls and the read-only operations views that go with them: jobs, late plans,
 * a business's limit, and a reviewer's approval authority. Operator only.
 *
 * Every control here only tightens: it pauses approvals, freezes a plan, or lowers a limit.
 * Each needs a typed reason, writes an audit event, is admin only, and is undone by an admin.
 */

/** The reason every control asks for. Kept with the change and in the audit log. */
export const ControlReason = z.string().trim().min(3).max(500);

// ---------- Controls ----------

/** Pause new automatic approvals by hand: trips the circuit breaker. Admin only. */
export const TripCircuitBreakerRequest = z.object({ reason: ControlReason });
export type TripCircuitBreakerRequest = z.infer<typeof TripCircuitBreakerRequest>;

/** Freeze a plan's next period. Released through `rent-plans/:id/release-freeze`. Admin only. */
export const FreezeRentPlanRequest = z.object({ reason: ControlReason });
export type FreezeRentPlanRequest = z.infer<typeof FreezeRentPlanRequest>;

/**
 * Lower the monthly rent a business may have fronted. The API refuses a value at or above
 * the limit in force: raising a limit goes through underwriting. Admin only.
 */
export const LowerLimitRequest = z.object({
  limitCents: Cents,
  reason: ControlReason,
});
export type LowerLimitRequest = z.infer<typeof LowerLimitRequest>;

/** Take an admin's cap off, back to the decision's limit. Admin only. */
export const RemoveLimitCapRequest = z.object({ reason: ControlReason });
export type RemoveLimitCapRequest = z.infer<typeof RemoveLimitCapRequest>;

/** A business's limit: what underwriting approved, the admin cap on it, and what applies. */
export const BusinessLimitView = z.object({
  businessId: Id,
  /** The current approved decision's monthly limit. Null without an approval. */
  decisionLimitCents: Cents.nullable(),
  /** The application that decision belongs to. */
  applicationId: Id.nullable(),
  /** The admin's cap, when there is one. */
  capCents: Cents.nullable(),
  capSetAt: IsoDateTimeSchema.nullable(),
  capSetBy: z.string().nullable(),
  capReason: z.string().nullable(),
  /** The smaller of the two. Null when nothing is approved and there is no cap. */
  effectiveLimitCents: Cents.nullable(),
  /** Open financed plans whose rent is above the effective limit. They keep running. */
  plansAboveLimit: z.array(z.object({ id: Id, monthlyRentCents: Cents })),
});
export type BusinessLimitView = z.infer<typeof BusinessLimitView>;

// ---------- Reviewer authority ----------

/** How far a reviewer may approve alone. Above the ceiling only an admin approves. */
export const ReviewAuthority = z.object({
  reviewerApprovalCeilingCents: Cents,
  /** The limit an approval at the engine's terms would carry, when there is one. */
  recommendedLimitCents: Cents.nullable(),
  /** True when the engine's limit is above the reviewer ceiling. */
  needsAdmin: z.boolean(),
});
export type ReviewAuthority = z.infer<typeof ReviewAuthority>;

// ---------- Jobs ----------

export const JobRunRow = z.object({
  id: Id,
  name: z.string(),
  asOf: IsoDateSchema,
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
  /** Null while running, or when the process died mid run. */
  ok: z.boolean().nullable(),
  /** First line of the error, at most 300 characters. */
  error: z.string().nullable(),
  durationMs: z.number().int().nullable(),
});
export type JobRunRow = z.infer<typeof JobRunRow>;

/**
 * How a job stands as of today. `LATE`: its last good run is older than the monitoring
 * policy's gap allows. `FAILED`: its last run failed. `RUNNING`: started, not finished.
 * `NEVER_RAN`: no run recorded.
 */
export const JobHealth = z.enum(['OK', 'RUNNING', 'FAILED', 'LATE', 'NEVER_RAN']);
export type JobHealth = z.infer<typeof JobHealth>;

export const OperatorJobs = z.object({
  asOf: IsoDateSchema,
  /** Days a job may go without a good run before it is late (monitoring policy). */
  maxGapDays: z.number().int(),
  jobs: z.array(
    z.object({
      name: z.string(),
      health: JobHealth,
      lastRun: JobRunRow.nullable(),
      lastSuccessAsOf: IsoDateSchema.nullable(),
      /** Days from the last good run's as-of date to today. Null when it never succeeded. */
      daysSinceSuccess: z.number().int().nullable(),
      /** Runs and failures in the history window below. */
      recentRuns: z.number().int().min(0),
      recentFailures: z.number().int().min(0),
    }),
  ),
  /** The latest runs of every job, newest first. */
  recent: z.array(JobRunRow),
});
export type OperatorJobs = z.infer<typeof OperatorJobs>;

export const OperatorJobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type OperatorJobsQuery = z.infer<typeof OperatorJobsQuery>;

// ---------- Late plans ----------

export const LatePlanRow = z.object({
  planId: Id,
  businessId: Id,
  businessName: z.string(),
  kind: RentPlanKind,
  status: RentPlanStatus,
  bucket: DelinquencyStatus,
  daysPastDue: z.number().int().min(0),
  pastDueCents: Cents,
  monthlyRentCents: Cents,
  /** Automatic debits have stopped: only a payment by the owner clears the balance. */
  needsPayment: z.boolean(),
  heldPayouts: z.number().int().min(0),
  heldPayoutCents: Cents,
  /** The earliest date a held payout can still be paid, when one is held. */
  heldReleaseBy: IsoDateSchema.nullable(),
  frozenReason: z.string().nullable(),
});
export type LatePlanRow = z.infer<typeof LatePlanRow>;

export const OperatorLatePlans = z.object({
  asOf: IsoDateSchema,
  plans: z.array(LatePlanRow),
});
export type OperatorLatePlans = z.infer<typeof OperatorLatePlans>;

import { z } from 'zod';

import { AdminRole, AlertCategory, AlertSeverity, AlertStatus } from '../enums';
import { Id, IsoDateSchema, IsoDateTimeSchema } from './common';

/**
 * Monitoring: alerts raised by rules, the circuit breaker, and the summary the operations
 * console reads. Operator only.
 */

/** How a person closed an alert. `CONDITION_CLEARED` is set by the monitor, never by a person. */
export const AlertDisposition = z.enum([
  'CONFIRMED',
  'FALSE_POSITIVE',
  'NO_ACTION',
  'DUPLICATE',
  'CONDITION_CLEARED',
]);
export type AlertDisposition = z.infer<typeof AlertDisposition>;

export const Alert = z.object({
  id: Id,
  /** The rule that raised it, for example `fraud.payout_change_before_payout`. */
  type: z.string(),
  category: AlertCategory,
  severity: AlertSeverity,
  /** What the alert is about: `rent_plan`, `lease`, `business`, `application`, and so on. */
  subjectType: z.string(),
  subjectId: z.string(),
  title: z.string(),
  /** The numbers and ids behind the alert. Shape depends on the rule. */
  detail: z.record(z.string(), z.unknown()),
  status: AlertStatus,
  disposition: AlertDisposition.nullable(),
  dedupeKey: z.string(),
  createdAt: IsoDateTimeSchema,
  /** The last monitor run that still found the condition. */
  lastSeenAt: IsoDateTimeSchema,
  acknowledgedBy: z.string().nullable(),
  acknowledgedAt: IsoDateTimeSchema.nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: IsoDateTimeSchema.nullable(),
  notes: z.string().nullable(),
});
export type Alert = z.infer<typeof Alert>;

export const AuditEventView = z.object({
  id: Id,
  at: IsoDateTimeSchema,
  actorType: z.string(),
  actorId: z.string().nullable(),
  eventType: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type AuditEventView = z.infer<typeof AuditEventView>;

/** What an alert is about, resolved to names an operator can read and ids to follow. */
export const AlertSubjectContext = z.object({
  subjectType: z.string(),
  subjectId: z.string(),
  /** A one line description, for example "Rent plan for Blue Door Bakery LLC". */
  label: z.string(),
  businessId: Id.nullable(),
  businessName: z.string().nullable(),
  rentPlanId: Id.nullable(),
  leaseId: Id.nullable(),
  applicationId: Id.nullable(),
});
export type AlertSubjectContext = z.infer<typeof AlertSubjectContext>;

export const AlertDetail = z.object({
  alert: Alert,
  subject: AlertSubjectContext,
  /** What the rule does, its thresholds in force, and whether it resolves on its own. */
  rule: z
    .object({
      type: z.string(),
      description: z.string(),
      autoResolves: z.boolean(),
      tripsCircuitBreaker: z.boolean(),
    })
    .nullable(),
  /** Earlier and other open alerts on the same subject, newest first. */
  relatedAlerts: z.array(Alert),
  /** Audit trail for the subject and for the alert itself, newest first, capped. */
  auditEvents: z.array(AuditEventView),
});
export type AlertDetail = z.infer<typeof AlertDetail>;

export const ListAlertsQuery = z.object({
  /** One status, or `ACTIVE` for everything not resolved. Default `ACTIVE`. */
  status: z.union([AlertStatus, z.literal('ACTIVE'), z.literal('ALL')]).default('ACTIVE'),
  severity: AlertSeverity.optional(),
  category: AlertCategory.optional(),
  type: z.string().optional(),
  subjectType: z.string().optional(),
  subjectId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** `nextCursor` from the previous page. */
  cursor: z.string().optional(),
});
export type ListAlertsQuery = z.infer<typeof ListAlertsQuery>;

export const AlertList = z.object({
  items: z.array(Alert),
  nextCursor: z.string().nullable(),
});
export type AlertList = z.infer<typeof AlertList>;

export const AcknowledgeAlertRequest = z.object({
  notes: z.string().trim().max(2000).optional(),
});
export type AcknowledgeAlertRequest = z.infer<typeof AcknowledgeAlertRequest>;

export const ResolveAlertRequest = z.object({
  disposition: AlertDisposition.exclude(['CONDITION_CLEARED']),
  notes: z.string().trim().min(3).max(2000),
});
export type ResolveAlertRequest = z.infer<typeof ResolveAlertRequest>;

/**
 * The switch on automatic approvals. While tripped, an application the engine would approve
 * is referred to a reviewer instead.
 */
export const CircuitBreakerStatus = z.object({
  id: z.string(),
  tripped: z.boolean(),
  reason: z.string().nullable(),
  trippedAt: IsoDateTimeSchema.nullable(),
  trippedByRule: z.string().nullable(),
  trippedAlertId: Id.nullable(),
  resetAt: IsoDateTimeSchema.nullable(),
  resetBy: z.string().nullable(),
  resetReason: z.string().nullable(),
});
export type CircuitBreakerStatus = z.infer<typeof CircuitBreakerStatus>;

export const ResetCircuitBreakerRequest = z.object({
  reason: z.string().trim().min(3).max(1000),
});
export type ResetCircuitBreakerRequest = z.infer<typeof ResetCircuitBreakerRequest>;

export const JobRunView = z.object({
  name: z.string(),
  /** Null when the job has never run. */
  lastRun: z
    .object({
      id: Id,
      asOf: IsoDateSchema,
      startedAt: IsoDateTimeSchema,
      finishedAt: IsoDateTimeSchema.nullable(),
      ok: z.boolean().nullable(),
      error: z.string().nullable(),
      summary: z.record(z.string(), z.unknown()).nullable(),
    })
    .nullable(),
  lastSuccessAsOf: IsoDateSchema.nullable(),
});
export type JobRunView = z.infer<typeof JobRunView>;

export const RuleStatusView = z.object({
  type: z.string(),
  category: AlertCategory,
  description: z.string(),
  autoResolves: z.boolean(),
  tripsCircuitBreaker: z.boolean(),
  /** Alerts of this rule that are not resolved. */
  openAlerts: z.number().int().min(0),
  /** Candidates the rule produced on the last monitor run. Null before the first run. */
  lastRunCandidates: z.number().int().min(0).nullable(),
  /** False when the rule threw on the last run. Its alerts were left as they were. */
  lastRunOk: z.boolean().nullable(),
});
export type RuleStatusView = z.infer<typeof RuleStatusView>;

export const MonitoringSummary = z.object({
  asOf: IsoDateSchema,
  /** Alerts that are not resolved, by severity. */
  openBySeverity: z.record(AlertSeverity, z.number().int().min(0)),
  openByCategory: z.record(AlertCategory, z.number().int().min(0)),
  openByType: z.array(
    z.object({ type: z.string(), severity: AlertSeverity, count: z.number().int().min(0) }),
  ),
  unacknowledged: z.number().int().min(0),
  circuitBreaker: CircuitBreakerStatus,
  /** Last monitor run, when there has been one. */
  lastMonitorRun: JobRunView.shape.lastRun,
  jobs: z.array(JobRunView),
  rules: z.array(RuleStatusView),
  pendingLeaseChanges: z.number().int().min(0),
  openScreeningHits: z.number().int().min(0),
  applicationsInReview: z.number().int().min(0),
});
export type MonitoringSummary = z.infer<typeof MonitoringSummary>;

/** Who the caller is, as the API resolved it from the token and the actor header. */
export const AdminIdentity = z.object({
  role: AdminRole,
  actor: z.string(),
});
export type AdminIdentity = z.infer<typeof AdminIdentity>;

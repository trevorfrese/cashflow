import type {
  AdminIdentity,
  Alert as AlertDto,
  AlertCategory,
  AlertDetail,
  AlertDisposition,
  AlertSeverity,
  AlertSubjectContext,
  AuditEventView,
  IsoDate,
  ListAlertsQuery,
  MonitoringSummary,
} from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import type { Db, Tx } from '../db.ts';
import { notFound, unprocessable } from '../errors.ts';
import type { Alert, AuditEvent, JobRun, Prisma } from '../generated/prisma/client.ts';
import { recordAudit, type AuditActor } from '../services/audit.ts';
import { breakerStatus, tripBreaker } from '../services/circuit-breaker.ts';
import { gatherMonitoringInputs, leaseChangeFacts } from './data.ts';
import {
  evaluateRules,
  MONITOR_ACTOR,
  planAlertActions,
  ruleByType,
  RULES,
  type ExistingAlert,
} from './engine.ts';
import { MONITORING_POLICY } from './policy.ts';
import { pendingLeaseChangeCandidate } from './rules/fraud.ts';
import type { AlertCandidate } from './types.ts';

/**
 * Monitoring, with the database: run the rules and write what they found, and the
 * operations on alerts that the operator routes expose.
 */

const JOB_ACTOR: AuditActor = { type: 'job', id: 'monitor' };
export const MONITOR_JOB = 'monitor';

export const toAlert = (a: Alert): AlertDto => ({
  id: a.id,
  type: a.type,
  category: a.category as AlertCategory,
  severity: a.severity,
  subjectType: a.subjectType,
  subjectId: a.subjectId,
  title: a.title,
  detail: (a.detail ?? {}) as Record<string, unknown>,
  status: a.status,
  disposition: a.disposition as AlertDisposition | null,
  dedupeKey: a.dedupeKey,
  createdAt: a.createdAt.toISOString(),
  lastSeenAt: a.lastSeenAt.toISOString(),
  acknowledgedBy: a.acknowledgedBy,
  acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
  resolvedBy: a.resolvedBy,
  resolvedAt: a.resolvedAt?.toISOString() ?? null,
  notes: a.notes,
});

export const toAuditEventView = (e: AuditEvent): AuditEventView => ({
  id: e.id,
  at: e.at.toISOString(),
  actorType: e.actorType,
  actorId: e.actorId,
  eventType: e.eventType,
  subjectType: e.subjectType,
  subjectId: e.subjectId,
  payload: (e.payload ?? {}) as Record<string, unknown>,
});

/**
 * Open an alert unless one with the same key is already open. Returns the new alert, or
 * null when there was one. Used by the monitor, and by a service that wants its alert up
 * at once instead of on the next run.
 */
export async function openAlert(
  tx: Tx,
  candidate: AlertCandidate,
  at: Date,
  actor: AuditActor = JOB_ACTOR,
): Promise<Alert | null> {
  const existing = await tx.alert.findFirst({
    where: { dedupeKey: candidate.dedupeKey, status: { not: 'RESOLVED' } },
    select: { id: true },
  });
  if (existing) return null;
  const alert = await tx.alert.create({
    data: {
      type: candidate.type,
      category: candidate.category,
      severity: candidate.severity,
      subjectType: candidate.subjectType,
      subjectId: candidate.subjectId,
      title: candidate.title,
      detail: candidate.detail as Prisma.InputJsonValue,
      dedupeKey: candidate.dedupeKey,
      createdAt: at,
      lastSeenAt: at,
    },
  });
  await recordAudit(tx, {
    actor,
    eventType: 'ALERT_OPENED',
    subjectType: 'alert',
    subjectId: alert.id,
    payload: {
      type: alert.type,
      alertSeverity: alert.severity,
      subjectType: alert.subjectType,
      subjectId: alert.subjectId,
      title: alert.title,
    },
    at,
  });
  return alert;
}

/** Open the alert for a lease change the moment it is requested. The monitor keeps it current. */
export async function openLeaseChangeAlert(tx: Tx, changeId: string, at: Date): Promise<void> {
  const [fact] = await leaseChangeFacts(tx, { id: changeId, status: 'PENDING' });
  if (!fact) return;
  await openAlert(
    tx,
    pendingLeaseChangeCandidate(fact, MONITORING_POLICY.fraud.payoutProximityDays),
    at,
    { type: 'system', id: 'lease-change-control' },
  );
}

export interface MonitorResult {
  rules: number;
  ruleErrors: number;
  candidates: number;
  opened: number;
  refreshed: number;
  escalated: number;
  autoResolved: number;
  breakerTripped: boolean;
  [key: `rule:${string}`]: number;
}

/**
 * One monitoring run as of `asOf`: gather, evaluate, and reconcile with the alerts that
 * exist. Idempotent: a second run on the same state opens nothing, because every candidate
 * finds its alert already there.
 */
export async function runMonitor(
  ctx: AppContext,
  asOf: IsoDate,
  jobNames: readonly string[],
): Promise<MonitorResult> {
  const policy = MONITORING_POLICY;
  const at = effectiveAt(asOf);
  const inputs = await gatherMonitoringInputs(ctx.db, {
    asOf,
    policy,
    providers: ctx.providers,
    jobNames,
    self: MONITOR_JOB,
  });
  const evaluation = evaluateRules(inputs, policy);
  for (const run of evaluation.runs) {
    if (!run.ok) ctx.log.error({ rule: run.type, error: run.error }, 'monitoring rule failed');
  }

  return ctx.db.$transaction(async (tx) => {
    const keys = evaluation.candidates.map((c) => c.dedupeKey);
    const rows = await tx.alert.findMany({
      where: { OR: [{ status: { not: 'RESOLVED' } }, { dedupeKey: { in: keys } }] },
      select: {
        id: true,
        type: true,
        dedupeKey: true,
        status: true,
        severity: true,
        resolvedBy: true,
        resolvedAt: true,
      },
    });
    const existing: ExistingAlert[] = rows.map((r) => ({
      ...r,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
    }));
    const plan = planAlertActions({ evaluation, existing, policy, now: at.toISOString() });

    const openedIds = new Map<string, string>();
    for (const candidate of plan.open) {
      const alert = await openAlert(tx, candidate, at);
      if (alert) openedIds.set(candidate.dedupeKey, alert.id);
    }
    for (const { id, candidate, escalated } of plan.refresh) {
      await tx.alert.update({
        where: { id },
        data: {
          lastSeenAt: at,
          severity: candidate.severity,
          title: candidate.title,
          detail: candidate.detail as Prisma.InputJsonValue,
        },
      });
      if (escalated) openedIds.set(candidate.dedupeKey, id);
    }
    for (const { id, type } of plan.resolve) {
      await tx.alert.update({
        where: { id },
        data: {
          status: 'RESOLVED',
          disposition: 'CONDITION_CLEARED',
          resolvedBy: MONITOR_ACTOR,
          resolvedAt: at,
        },
      });
      await recordAudit(tx, {
        actor: JOB_ACTOR,
        eventType: 'ALERT_RESOLVED',
        subjectType: 'alert',
        subjectId: id,
        payload: { type, disposition: 'CONDITION_CLEARED', auto: true },
        at,
      });
    }

    let breakerTripped = false;
    if (plan.trip) {
      breakerTripped = await tripBreaker(tx, {
        rule: plan.trip.type,
        reason: plan.trip.title,
        alertId: openedIds.get(plan.trip.dedupeKey) ?? null,
        actor: JOB_ACTOR,
        at,
      });
      if (breakerTripped) {
        ctx.log.error({ rule: plan.trip.type }, 'circuit breaker tripped: approvals are referred');
      }
    }

    const result: MonitorResult = {
      rules: evaluation.runs.length,
      ruleErrors: evaluation.runs.filter((r) => !r.ok).length,
      candidates: evaluation.candidates.length,
      opened: openedIds.size - plan.refresh.filter((r) => r.escalated).length,
      refreshed: plan.refresh.length,
      escalated: plan.refresh.filter((r) => r.escalated).length,
      autoResolved: plan.resolve.length,
      breakerTripped,
    };
    // One entry per rule, so the summary can show what each found on its last run. -1 is a
    // rule that threw.
    for (const run of evaluation.runs) result[`rule:${run.type}`] = run.ok ? run.candidates : -1;
    return result;
  });
}

const actorOf = (identity: AdminIdentity): AuditActor => ({
  type: identity.role,
  id: identity.actor,
});

export async function acknowledgeAlert(
  db: Db,
  args: { alertId: string; identity: AdminIdentity; notes?: string },
) {
  return db.$transaction(async (tx) => {
    const alert = await tx.alert.findUnique({ where: { id: args.alertId } });
    if (!alert) throw notFound('Alert');
    if (alert.status !== 'OPEN') {
      throw unprocessable(
        'ALERT_NOT_OPEN',
        `This alert is ${alert.status.toLowerCase()}, not open`,
      );
    }
    const at = new Date();
    const updated = await tx.alert.update({
      where: { id: alert.id },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedBy: args.identity.actor,
        acknowledgedAt: at,
        notes: appendNote(alert.notes, args.notes, args.identity.actor, at),
      },
    });
    await recordAudit(tx, {
      actor: actorOf(args.identity),
      eventType: 'ALERT_ACKNOWLEDGED',
      subjectType: 'alert',
      subjectId: alert.id,
      payload: { type: alert.type, notes: args.notes ?? null },
      at,
    });
    return updated;
  });
}

export async function resolveAlert(
  db: Db,
  args: {
    alertId: string;
    identity: AdminIdentity;
    disposition: Exclude<AlertDisposition, 'CONDITION_CLEARED'>;
    notes: string;
  },
) {
  return db.$transaction(async (tx) => {
    const alert = await tx.alert.findUnique({ where: { id: args.alertId } });
    if (!alert) throw notFound('Alert');
    if (alert.status === 'RESOLVED') {
      throw unprocessable('ALERT_RESOLVED', 'This alert is already resolved');
    }
    const at = new Date();
    const updated = await tx.alert.update({
      where: { id: alert.id },
      data: {
        status: 'RESOLVED',
        disposition: args.disposition,
        resolvedBy: args.identity.actor,
        resolvedAt: at,
        notes: appendNote(alert.notes, args.notes, args.identity.actor, at),
      },
    });
    await recordAudit(tx, {
      actor: actorOf(args.identity),
      eventType: 'ALERT_RESOLVED',
      subjectType: 'alert',
      subjectId: alert.id,
      payload: { type: alert.type, disposition: args.disposition, notes: args.notes },
      at,
    });
    return updated;
  });
}

/** Notes accumulate: each is stamped with who wrote it and when. */
function appendNote(existing: string | null, note: string | undefined, who: string, at: Date) {
  if (!note) return existing;
  const line = `[${at.toISOString()} ${who}] ${note}`;
  return existing ? `${existing}\n${line}` : line;
}

const SEVERITY_ORDER: AlertSeverity[] = ['CRITICAL', 'HIGH', 'WARNING', 'INFO'];

export async function listAlerts(db: Db, query: ListAlertsQuery) {
  const where: Prisma.AlertWhereInput = {
    ...(query.status === 'ALL'
      ? {}
      : query.status === 'ACTIVE'
        ? { status: { not: 'RESOLVED' } }
        : { status: query.status }),
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.category ? { category: query.category } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.subjectType ? { subjectType: query.subjectType } : {}),
    ...(query.subjectId ? { subjectId: query.subjectId } : {}),
  };
  // Newest first, paged by id. The console sorts by severity itself when it wants to.
  const rows = await db.alert.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(toAlert),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  };
}

/** Resolve an alert's subject to names and ids an operator can follow. */
async function subjectContext(
  db: Db,
  alert: Pick<Alert, 'subjectType' | 'subjectId' | 'detail'>,
): Promise<AlertSubjectContext> {
  const base: AlertSubjectContext = {
    subjectType: alert.subjectType,
    subjectId: alert.subjectId,
    label: `${alert.subjectType} ${alert.subjectId}`,
    businessId: null,
    businessName: null,
    rentPlanId: null,
    leaseId: null,
    applicationId: null,
  };
  const withBusiness = async (businessId: string | null) => {
    if (!businessId) return;
    const business = await db.business.findUnique({
      where: { id: businessId },
      select: { id: true, legalName: true },
    });
    if (business) {
      base.businessId = business.id;
      base.businessName = business.legalName;
    }
  };
  const detail = (alert.detail ?? {}) as Record<string, unknown>;
  switch (alert.subjectType) {
    case 'rent_plan': {
      const plan = await db.rentPlan.findUnique({ where: { id: alert.subjectId } });
      if (plan) {
        base.rentPlanId = plan.id;
        base.leaseId = plan.leaseId;
        base.applicationId = plan.applicationId;
        await withBusiness(plan.businessId);
        base.label = `Rent plan for ${base.businessName ?? plan.businessId}`;
      }
      break;
    }
    case 'lease': {
      const lease = await db.lease.findUnique({
        where: { id: alert.subjectId },
        include: { rentPlans: { orderBy: { createdAt: 'desc' }, take: 1 } },
      });
      if (lease) {
        base.leaseId = lease.id;
        base.rentPlanId = lease.rentPlans[0]?.id ?? null;
        await withBusiness(lease.businessId);
        base.label = `Lease with ${lease.landlordName} for ${base.businessName ?? lease.businessId}`;
      }
      break;
    }
    case 'application': {
      const application = await db.underwritingApplication.findUnique({
        where: { id: alert.subjectId },
      });
      if (application) {
        base.applicationId = application.id;
        await withBusiness(application.businessId);
        base.label = `Application from ${base.businessName ?? application.businessId}`;
      }
      break;
    }
    case 'business':
      await withBusiness(alert.subjectId);
      if (base.businessName) base.label = base.businessName;
      break;
    case 'screening': {
      const screening = await db.screeningResult.findUnique({ where: { id: alert.subjectId } });
      if (screening) {
        await withBusiness(screening.businessId);
        if (screening.partyType === 'LANDLORD' && !screening.leaseChangeId) {
          base.leaseId = screening.partyRef;
        }
        base.label = `Screening of ${screening.nameScreened} (${screening.partyType.toLowerCase()}) for ${base.businessName ?? screening.businessId}`;
      }
      break;
    }
    case 'user': {
      const user = await db.user.findUnique({
        where: { id: alert.subjectId },
        select: { email: true, fullName: true },
      });
      if (user) base.label = `User ${user.fullName} (${user.email})`;
      break;
    }
    default:
      if (typeof detail.businessId === 'string') await withBusiness(detail.businessId);
  }
  if (!base.businessId && typeof detail.businessId === 'string') {
    await withBusiness(detail.businessId);
  }
  return base;
}

export async function alertDetail(db: Db, alertId: string): Promise<AlertDetail> {
  const alert = await db.alert.findUnique({ where: { id: alertId } });
  if (!alert) throw notFound('Alert');
  const rule = ruleByType(alert.type);
  const [subject, related, events] = await Promise.all([
    subjectContext(db, alert),
    db.alert.findMany({
      where: {
        subjectType: alert.subjectType,
        subjectId: alert.subjectId,
        id: { not: alert.id },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
    db.auditEvent.findMany({
      where: {
        OR: [
          { subjectType: 'alert', subjectId: alert.id },
          { subjectType: alert.subjectType, subjectId: alert.subjectId },
        ],
      },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 50,
    }),
  ]);
  return {
    alert: toAlert(alert),
    subject,
    rule: rule
      ? {
          type: rule.type,
          description: rule.description,
          autoResolves: rule.autoResolves,
          tripsCircuitBreaker: rule.tripsCircuitBreaker,
        }
      : null,
    relatedAlerts: related.map(toAlert),
    auditEvents: events.map(toAuditEventView),
  };
}

const toJobRun = (run: JobRun | null) =>
  run
    ? {
        id: run.id,
        asOf: run.asOf,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        ok: run.ok,
        error: run.error,
        summary: (run.summary ?? null) as Record<string, unknown> | null,
      }
    : null;

export async function monitoringSummary(
  db: Db,
  asOf: IsoDate,
  jobNames: readonly string[],
): Promise<MonitoringSummary> {
  const [grouped, unacknowledged, breaker, pendingLeaseChanges, hits, inReview] = await Promise.all(
    [
      db.alert.groupBy({
        by: ['type', 'category', 'severity'],
        where: { status: { not: 'RESOLVED' } },
        _count: { _all: true },
      }),
      db.alert.count({ where: { status: 'OPEN' } }),
      breakerStatus(db),
      db.leaseChange.count({ where: { status: 'PENDING' } }),
      db.screeningResult.count({
        where: {
          supersededAt: null,
          clearedAt: null,
          result: { in: ['POSSIBLE_MATCH', 'MATCH'] },
        },
      }),
      db.underwritingApplication.count({ where: { status: 'IN_REVIEW' } }),
    ],
  );
  const openBySeverity = { INFO: 0, WARNING: 0, HIGH: 0, CRITICAL: 0 };
  const openByCategory = { FRAUD: 0, PAYMENTS: 0, PORTFOLIO: 0, BOOKS: 0, COMPLIANCE: 0 };
  const openByRule = new Map<string, number>();
  for (const g of grouped) {
    openBySeverity[g.severity] += g._count._all;
    openByCategory[g.category as AlertCategory] += g._count._all;
    openByRule.set(g.type, (openByRule.get(g.type) ?? 0) + g._count._all);
  }

  const jobs = [];
  for (const name of jobNames) {
    const lastRun = await db.jobRun.findFirst({
      where: { name },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
    const lastOk = await db.jobRun.findFirst({
      where: { name, ok: true },
      orderBy: { asOf: 'desc' },
      select: { asOf: true },
    });
    jobs.push({ name, lastRun: toJobRun(lastRun), lastSuccessAsOf: lastOk?.asOf ?? null });
  }
  const lastMonitor = await db.jobRun.findFirst({
    where: { name: MONITOR_JOB, ok: true },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  });
  const lastSummary = (lastMonitor?.summary ?? null) as Record<string, unknown> | null;

  return {
    asOf,
    openBySeverity,
    openByCategory,
    openByType: grouped
      .map((g) => ({ type: g.type, severity: g.severity, count: g._count._all }))
      .sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
          a.type.localeCompare(b.type),
      ),
    unacknowledged,
    circuitBreaker: breaker,
    lastMonitorRun: toJobRun(lastMonitor),
    jobs,
    rules: RULES.map((rule) => {
      const count = lastSummary?.[`rule:${rule.type}`];
      return {
        type: rule.type,
        category: rule.category,
        description: rule.description,
        autoResolves: rule.autoResolves,
        tripsCircuitBreaker: rule.tripsCircuitBreaker,
        openAlerts: openByRule.get(rule.type) ?? 0,
        lastRunCandidates: typeof count === 'number' ? Math.max(0, count) : null,
        lastRunOk: typeof count === 'number' ? count >= 0 : null,
      };
    }),
    pendingLeaseChanges,
    openScreeningHits: hits,
    applicationsInReview: inReview,
  };
}

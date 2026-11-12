import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  addDays,
  type AuditLogPage,
  type AuditLogQuery,
  type BusinessIdentityView,
  type CashFlowSummary,
  type DecisionReason,
  type DelinquencyStatus,
  type EvaluationGate,
  type IsoDate,
  type OperatorApplicationDetail,
  type OperatorApplicationSummary,
  type OperatorBusinessDetail,
  type OperatorBusinessList,
  type OperatorBusinessListQuery,
  type OperatorDecision,
  type OperatorDecisionSummary,
  type OperatorEvaluation,
  type OperatorPolicy,
  type OperatorPortfolio,
  type OperatorRentPlan,
  type PolicyParameter,
} from '@cashflow/shared';

import { CONTROLS_POLICY } from '../controls/policy.ts';
import { todayIso } from '../dates.ts';
import type { Db } from '../db.ts';
import { notFound } from '../errors.ts';
import type {
  ApplicationReview,
  BeneficialOwner,
  Business,
  Prisma,
  UnderwritingApplication,
  UnderwritingDecision,
} from '../generated/prisma/client.ts';
import { exposureFacts, planFacts } from '../monitoring/data.ts';
import { RULES } from '../monitoring/engine.ts';
import { MONITORING_POLICY } from '../monitoring/policy.ts';
import { firstPaymentDefaultCohorts } from '../monitoring/rules/portfolio.ts';
import { bps } from '../monitoring/rules/payments.ts';
import { toAlert, toAuditEventView } from '../monitoring/service.ts';
import type { Providers } from '../providers/index.ts';
import { leaseChangeViews, screeningViews } from '../routes/admin.ts';
import {
  toInstallment,
  toPassThroughPeriod,
  toPayout,
  toRentPlan,
  toRepayment,
  toReview,
} from '../serializers.ts';
import {
  ACTIVE_SERVICING_POLICY,
  classifyReturnCode,
  DELINQUENCY_BUCKETS,
  OPEN_BUCKETS,
  RETURN_CODES,
  returnCodeReason,
} from '../servicing/policy.ts';
import type { DecisionSnapshot } from '../underwriting/engine.ts';
import { coverageRatio, freeCashCents } from '../underwriting/features.ts';
import { INTEGRITY_RULES } from '../underwriting/integrity.ts';
import { CURRENT_POLICY, POLICIES } from '../underwriting/policy.ts';
import { scoreCashFlow } from '../underwriting/scorecard.ts';
import { AUDIT_EVENTS, AUDIT_SUBJECT_TYPES } from './audit.ts';
import { CURRENT_DECISION } from './decisions.ts';
import { planStandings } from './delinquency.ts';
import { graduationOffers, openGraduationOffer } from './pass-through-views.ts';
import { paymentHistoryView } from './payment-history.ts';
import { OPEN_HIT, openHitsForBusiness } from './identity.ts';
import { gatherPoolState } from './portfolio-state.ts';
import { delinquencySummary } from './provisioning.ts';
import { decisionClock, engineRecommendation } from './reviews.ts';

/**
 * Read models for the operations console.
 *
 * Everything here is operator only. These views carry what the customer serializers in
 * `serializers.ts` deliberately leave out: the engine's terms on a referral, integrity
 * flags, the fee build-up, screening detail, and the policy's numbers. They have their own
 * serializers for that reason, and no customer route imports this module.
 */

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

// ---------- Businesses ----------

export function identityView(b: Business & { owners: BeneficialOwner[] }): BusinessIdentityView {
  return {
    businessId: b.id,
    legalName: b.legalName,
    taxIdLast4: b.taxIdLast4,
    verificationStatus: b.verificationStatus,
    verificationCheckedAt: isoOrNull(b.verificationCheckedAt),
    verificationProvider: b.verificationProvider,
    verificationRef: b.verificationRef,
    verificationReasons: b.verificationReasons,
    owners: b.owners.map((o) => ({
      id: o.id,
      fullName: o.fullName,
      title: o.title,
      ownershipBps: o.ownershipBps,
      verificationStatus: o.verificationStatus,
      verificationRef: o.verificationRef,
    })),
  };
}

function worstBucket(statuses: readonly DelinquencyStatus[]): DelinquencyStatus | null {
  let worst: DelinquencyStatus | null = null;
  for (const s of statuses) {
    if (worst === null || DELINQUENCY_BUCKETS.indexOf(s) > DELINQUENCY_BUCKETS.indexOf(worst)) {
      worst = s;
    }
  }
  return worst;
}

/** Businesses by name, paged by id, with enough on each row to pick the one to open. */
export async function listBusinesses(
  db: Db,
  query: OperatorBusinessListQuery,
): Promise<OperatorBusinessList> {
  const q = query.q && query.q.length > 0 ? query.q : null;
  const where: Prisma.BusinessWhereInput = {
    ...(q
      ? {
          OR: [
            { legalName: { contains: q, mode: 'insensitive' } },
            { dba: { contains: q, mode: 'insensitive' } },
            { owner: { email: { contains: q, mode: 'insensitive' } } },
            { id: q },
          ],
        }
      : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.verification ? { verificationStatus: query.verification } : {}),
  };
  const rows = await db.business.findMany({
    where,
    orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: {
      owner: { select: { email: true } },
      rentPlans: { select: { status: true, delinquencyStatus: true, advanceFrozenAt: true } },
      applications: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } },
      screenings: { where: { ...OPEN_HIT, leaseChangeId: null }, select: { id: true } },
    },
  });
  const page = rows.slice(0, query.limit);
  return {
    items: page.map((b) => {
      const open = b.rentPlans.filter((p) => p.status !== 'CLOSED');
      return {
        id: b.id,
        legalName: b.legalName,
        dba: b.dba,
        industry: b.industry,
        status: b.status,
        verificationStatus: b.verificationStatus,
        city: b.city,
        state: b.state,
        ownerEmail: b.owner.email,
        createdAt: iso(b.createdAt),
        openPlans: open.length,
        frozenPlans: open.filter((p) => p.advanceFrozenAt !== null).length,
        worstDelinquency: worstBucket(b.rentPlans.map((p) => p.delinquencyStatus)),
        latestApplicationStatus: b.applications[0]?.status ?? null,
        openScreeningHits: b.screenings.length,
      };
    }),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
  };
}

function decisionSummary(
  d: UnderwritingDecision & { review?: ApplicationReview | null },
): OperatorDecisionSummary {
  return {
    id: d.id,
    kind: d.kind,
    outcome: d.outcome,
    approvedMonthlyLimitCents: d.approvedMonthlyLimitCents,
    feeBps: d.feeBps,
    score: d.score,
    grade: (d.grade as OperatorDecisionSummary['grade']) ?? null,
    policyVersion: d.policyVersion,
    isOverride: d.isOverride,
    reviewer: d.review?.reviewer ?? null,
    reviewPeriod: d.reviewPeriod,
    decidedAt: iso(d.decidedAt),
    supersededAt: isoOrNull(d.supersededAt),
  };
}

type DecisionWithReview = UnderwritingDecision & { review: ApplicationReview | null };

const isCurrent = (d: UnderwritingDecision) =>
  d.supersededAt === null && !(CURRENT_DECISION.kind.notIn as readonly string[]).includes(d.kind);

function applicationSummary(
  a: UnderwritingApplication & {
    decisions: DecisionWithReview[];
    _count: { reviews: number };
  },
): OperatorApplicationSummary {
  const current = a.decisions.find(isCurrent) ?? null;
  return {
    id: a.id,
    businessId: a.businessId,
    status: a.status,
    requestedMonthlyRentCents: a.requestedMonthlyRentCents,
    statedMonthlyRevenueCents: a.statedMonthlyRevenueCents,
    timeInBusinessMonths: a.timeInBusinessMonths,
    submittedAt: isoOrNull(a.submittedAt),
    createdAt: iso(a.createdAt),
    currentDecision: current ? decisionSummary(current) : null,
    decisions: a.decisions.length,
    reviews: a._count.reviews,
  };
}

/** Ids of everything a business owns that an alert or an audit event can be about. */
async function businessSubjects(db: Db, businessId: string) {
  const [applications, plans, leases, screenings] = await Promise.all([
    db.underwritingApplication.findMany({ where: { businessId }, select: { id: true } }),
    db.rentPlan.findMany({ where: { businessId }, select: { id: true } }),
    db.lease.findMany({ where: { businessId }, select: { id: true } }),
    db.screeningResult.findMany({ where: { businessId }, select: { id: true } }),
  ]);
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  return [
    { subjectType: 'business', subjectId: { in: [businessId] } },
    { subjectType: 'application', subjectId: { in: ids(applications) } },
    { subjectType: 'rent_plan', subjectId: { in: ids(plans) } },
    { subjectType: 'lease', subjectId: { in: ids(leases) } },
    { subjectType: 'screening', subjectId: { in: ids(screenings) } },
  ];
}

export async function businessDetail(db: Db, businessId: string): Promise<OperatorBusinessDetail> {
  const b = await db.business.findUnique({
    where: { id: businessId },
    include: {
      owner: { select: { id: true, email: true, fullName: true } },
      owners: { orderBy: { createdAt: 'asc' } },
      bankLinks: { orderBy: { createdAt: 'asc' } },
      leases: { orderBy: { createdAt: 'asc' } },
      applications: {
        orderBy: { createdAt: 'desc' },
        include: {
          decisions: { orderBy: { decidedAt: 'desc' }, include: { review: true } },
          _count: { select: { reviews: true } },
        },
      },
    },
  });
  if (!b) throw notFound('Business');
  const subjects = await businessSubjects(db, b.id);
  const [pendingLeaseChanges, screenings, alerts, offers, openOffer] = await Promise.all([
    leaseChangeViews(db, { businessId: b.id, status: 'PENDING' }),
    screeningViews(db, { businessId: b.id, supersededAt: null }),
    db.alert.findMany({
      where: { OR: [...subjects, { detail: { path: ['businessId'], equals: b.id } }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    }),
    graduationOffers(db, b.id),
    openGraduationOffer(db, b.id),
  ]);
  const paymentHistory = await paymentHistoryView(db, b.id, todayIso(), openOffer);
  return {
    business: {
      id: b.id,
      legalName: b.legalName,
      dba: b.dba,
      industry: b.industry,
      status: b.status,
      address: {
        line1: b.addressLine1,
        line2: b.addressLine2 ?? undefined,
        city: b.city,
        state: b.state,
        postalCode: b.postalCode,
      },
      foundedOn: b.foundedOn,
      statedMonthlyRevenueCents: b.statedMonthlyRevenueCents,
      createdAt: iso(b.createdAt),
      updatedAt: iso(b.updatedAt),
      owner: { userId: b.owner.id, email: b.owner.email, fullName: b.owner.fullName },
    },
    identity: identityView(b),
    bankLinks: b.bankLinks.map((l) => ({
      id: l.id,
      provider: l.provider,
      institutionName: l.institutionName,
      accountMask: l.accountMask,
      status: l.status,
      createdAt: iso(l.createdAt),
    })),
    // The payout token is never selected into the view.
    leases: b.leases.map((l) => ({
      id: l.id,
      status: l.status,
      landlordName: l.landlordName,
      landlordEmail: l.landlordEmail,
      propertyAddress: {
        line1: l.propertyLine1,
        line2: l.propertyLine2 ?? undefined,
        city: l.propertyCity,
        state: l.propertyState,
        postalCode: l.propertyPostalCode,
      },
      monthlyRentCents: l.monthlyRentCents,
      dueDayOfMonth: l.dueDayOfMonth,
      startsOn: l.startsOn,
      endsOn: l.endsOn,
      accountHolderName: l.landlordAccountHolderName,
      routingNumber: l.landlordRoutingNumber,
      accountNumberLast4: l.landlordAccountNumberLast4,
    })),
    applications: b.applications.map(applicationSummary),
    pendingLeaseChanges,
    screenings,
    alerts: alerts.map(toAlert),
    paymentHistory,
    graduationOffers: offers,
  };
}

/** Every plan of a business with its payouts, installments, and debits. Newest plan first. */
export async function businessRentPlans(
  db: Db,
  businessId: string,
  asOf: IsoDate,
): Promise<OperatorRentPlan[]> {
  const exists = await db.business.findUnique({ where: { id: businessId }, select: { id: true } });
  if (!exists) throw notFound('Business');
  const plans = await db.rentPlan.findMany({
    where: { businessId },
    orderBy: { createdAt: 'desc' },
    include: {
      lease: { select: { landlordName: true } },
      payouts: { orderBy: { scheduledFor: 'desc' } },
      passThroughPeriods: { orderBy: { dueDate: 'desc' } },
      installments: {
        orderBy: [{ dueDate: 'desc' }, { sequence: 'desc' }],
        include: { repayments: { orderBy: { createdAt: 'asc' } } },
      },
    },
  });
  const standings = await planStandings(db, plans, asOf);
  return plans.map((p) => ({
    ...toRentPlan(p, standings.get(p.id)),
    landlordName: p.lease.landlordName,
    advanceFrozenAt: isoOrNull(p.advanceFrozenAt),
    advanceFrozenReason: p.advanceFrozenReason,
    pendingRentCents: p.pendingRentCents,
    payouts: p.payouts.map((payout) => ({
      ...toPayout(payout),
      resendCount: payout.resendCount,
      canResend: payout.status === 'FAILED' && payout.returnCode !== null && p.status !== 'CLOSED',
    })),
    installments: p.installments.map((i) => ({
      ...toInstallment(i),
      lastAttemptOn: i.lastAttemptOn,
      repayments: i.repayments.map((r) => ({
        ...toRepayment(r),
        manual: r.manual,
        recovery: r.recovery,
        returnReason: r.returnCode ? returnCodeReason(r.returnCode) : null,
        returnClass: r.returnCode ? classifyReturnCode(r.returnCode) : null,
      })),
    })),
    passThroughPeriods: p.passThroughPeriods.map((period) =>
      toPassThroughPeriod(period, p.lease.landlordName),
    ),
  }));
}

// ---------- Applications ----------

function snapshotOf(d: UnderwritingDecision): Partial<DecisionSnapshot> {
  return (d.snapshot as unknown as Partial<DecisionSnapshot> | null) ?? {};
}

/**
 * The scorecard factors behind a stored score. The engine does not store the points, but
 * the scorecard is a pure function of the stored cash flow and the policy version, so they
 * are rebuilt. From policy version 2 the score was computed on coverage of rent alone,
 * while the stored ratio is at the fee quoted, so that one input is put back first.
 */
function factorsFor(d: UnderwritingDecision, requestedCents: number) {
  const cashFlow = d.cashFlow as unknown as CashFlowSummary | null;
  const policy = POLICIES[d.policyVersion];
  if (!cashFlow || !policy || d.score === null) return { factors: null, factorsMatchScore: false };
  try {
    const scored: CashFlowSummary =
      policy.scoredCoverageFeeBps === 0
        ? {
            ...cashFlow,
            rentCoverageRatio: coverageRatio(freeCashCents(cashFlow), requestedCents, 0),
          }
        : cashFlow;
    const history = snapshotOf(d).paymentHistory?.summary ?? null;
    const card = scoreCashFlow(scored, policy, null, history);
    return { factors: card.factors, factorsMatchScore: card.score === d.score };
  } catch {
    // A cash flow summary from before a field existed. No factors beats wrong ones.
    return { factors: null, factorsMatchScore: false };
  }
}

function operatorDecision(d: DecisionWithReview, requestedCents: number): OperatorDecision {
  const snapshot = snapshotOf(d);
  return {
    ...decisionSummary(d),
    reasons: (d.reasons as unknown as DecisionReason[]) ?? [],
    cashFlow: (d.cashFlow as unknown as CashFlowSummary | null) ?? null,
    recommendedInstallmentsPerMonth: d.recommendedInstallmentsPerMonth,
    recommendation: engineRecommendation(d),
    referTriggers: snapshot.referTriggers ?? [],
    integrityFlags: (snapshot.integrityFlags ?? []).map((f) => ({
      code: f.code,
      severity: f.severity,
      action: f.action,
      detail: f.detail,
      metrics: f.metrics ?? {},
    })),
    ...factorsFor(d, requestedCents),
    pricing: snapshot.pricing ?? null,
    exposure: snapshot.exposure
      ? {
          limitCents: snapshot.exposure.limitCents,
          binding: snapshot.exposure.binding,
          caps: snapshot.exposure.caps as Record<string, number>,
        }
      : null,
    funding: snapshot.funding
      ? {
          ok: snapshot.funding.ok,
          blockers: snapshot.funding.blockers,
          utilizationBps: snapshot.funding.utilizationBps,
          industryShareBps: snapshot.funding.industryShareBps,
        }
      : null,
  };
}

export async function applicationDetail(
  db: Db,
  applicationId: string,
  asOf: IsoDate,
): Promise<OperatorApplicationDetail> {
  const a = await db.underwritingApplication.findUnique({
    where: { id: applicationId },
    include: {
      business: { include: { owners: { orderBy: { createdAt: 'asc' } } } },
      decisions: {
        orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
        include: { review: true },
      },
      reviews: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!a) throw notFound('Application');
  const current = a.decisions.find(isCurrent) ?? null;
  const [hits, events] = await Promise.all([
    openHitsForBusiness(db, a.businessId),
    db.auditEvent.findMany({
      where: { subjectType: 'application', subjectId: a.id },
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: 100,
    }),
  ]);
  const openScreeningHits =
    hits.length > 0 ? await screeningViews(db, { id: { in: hits.map((h) => h.id) } }) : [];
  return {
    application: {
      id: a.id,
      businessId: a.businessId,
      businessName: a.business.legalName,
      industry: a.business.industry,
      status: a.status,
      requestedMonthlyRentCents: a.requestedMonthlyRentCents,
      statedMonthlyRevenueCents: a.statedMonthlyRevenueCents,
      timeInBusinessMonths: a.timeInBusinessMonths,
      submittedAt: isoOrNull(a.submittedAt),
      createdAt: iso(a.createdAt),
      updatedAt: iso(a.updatedAt),
    },
    ...decisionClock(a.submittedAt, asOf),
    current: current ? operatorDecision(current, a.requestedMonthlyRentCents) : null,
    history: a.decisions.map(decisionSummary),
    reviews: a.reviews.map(toReview),
    identity: identityView(a.business),
    openScreeningHits,
    auditEvents: events.map(toAuditEventView),
  };
}

// ---------- Audit log ----------

/** Audit events across every subject, newest first, filtered and paged by id. */
export async function auditLog(db: Db, query: AuditLogQuery): Promise<AuditLogPage> {
  const day = (d: IsoDate) => new Date(`${d}T00:00:00.000Z`);
  const where: Prisma.AuditEventWhereInput = {
    ...(query.subjectType ? { subjectType: query.subjectType } : {}),
    ...(query.subjectId ? { subjectId: query.subjectId } : {}),
    ...(query.eventType ? { eventType: query.eventType } : {}),
    ...(query.actorType ? { actorType: query.actorType } : {}),
    ...(query.actor ? { actorId: { contains: query.actor, mode: 'insensitive' } } : {}),
    ...(query.from || query.to
      ? {
          at: {
            ...(query.from ? { gte: day(query.from) } : {}),
            ...(query.to ? { lt: day(addDays(query.to, 1)) } : {}),
          },
        }
      : {}),
    ...(query.businessId ? { OR: await businessSubjects(db, query.businessId) } : {}),
  };
  const rows = await db.auditEvent.findMany({
    where,
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, query.limit);
  return {
    items: page.map(toAuditEventView),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    eventTypes: [...AUDIT_EVENTS],
    subjectTypes: [...AUDIT_SUBJECT_TYPES],
  };
}

// ---------- Portfolio ----------

/**
 * The live book: delinquency and the loss accounts, the pool, concentration against the
 * caps, and first payment defaults by origination month. Every figure comes from the same
 * functions monitoring and underwriting use, so this view cannot disagree with an alert.
 */
export async function portfolioView(
  db: Db,
  providers: Providers,
  asOf: IsoDate,
): Promise<OperatorPortfolio> {
  const p = MONITORING_POLICY.portfolio;
  const [delinquency, pool, exposure, plans, counts] = await Promise.all([
    delinquencySummary(db, asOf),
    gatherPoolState(db, providers),
    exposureFacts(db, providers),
    planFacts(db),
    db.rentPlan.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const capitalCents = exposure.capitalCents;
  const share = (cents: number) => (capitalCents > 0 ? bps(cents, capitalCents) : null);
  const row = (key: string, label: string, committedCents: number, capBps: number) => {
    const shareBps = share(committedCents);
    return { key, label, committedCents, shareBps, capBps, overCap: (shareBps ?? 0) > capBps };
  };
  const byCommitted = <T extends { committedCents: number }>(a: T, b: T) =>
    b.committedCents - a.committedCents;
  const count = (status: string) => counts.find((c) => c.status === status)?._count._all ?? 0;
  const cohorts = firstPaymentDefaultCohorts(plans, asOf, p.firstPaymentDefaultDays);
  return {
    asOf,
    delinquency,
    pool: {
      provider: providers.capital.name,
      cashCents: pool.cashCents,
      receivableCents: pool.receivableCents,
      capitalCents,
      committedCents: exposure.committedCents,
      utilizationBps: share(exposure.committedCents),
      maxUtilizationBps: p.maxPoolUtilizationBps,
    },
    plans: { active: count('ACTIVE'), paused: count('PAUSED'), closed: count('CLOSED') },
    concentration: {
      industries: [...exposure.byIndustry]
        .sort(byCommitted)
        .map((i) => row(i.industry, i.industry, i.committedCents, p.maxIndustryShareBps)),
      businesses: [...exposure.byBusiness]
        .sort(byCommitted)
        .slice(0, 10)
        .map((b) => row(b.businessId, b.businessName, b.committedCents, p.maxSingleNameShareBps)),
    },
    firstPaymentDefault: {
      defaultDays: p.firstPaymentDefaultDays,
      minPlans: p.minPlans,
      warnBps: p.firstPaymentDefaultWarnBps,
      criticalBps: p.firstPaymentDefaultCriticalBps,
      cohorts: [...cohorts.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([month, c]) => ({
          month,
          plans: c.plans,
          defaults: c.defaults.length,
          rateBps: bps(c.defaults.length, c.plans),
          belowMinSample: c.plans < p.minPlans,
        })),
    },
  };
}

// ---------- Policy ----------

const param = (
  key: string,
  label: string,
  value: PolicyParameter['value'],
  unit: PolicyParameter['unit'],
  note?: string,
): PolicyParameter => ({ key, label, value, unit, ...(note ? { note } : {}) });

/**
 * The numbers a reviewer needs to read a decision, an alert, or a plan's standing. Staff
 * only: this is exactly what the customer API does not say.
 */
export function policyView(): OperatorPolicy {
  const c = CURRENT_POLICY;
  const s = ACTIVE_SERVICING_POLICY;
  const m = MONITORING_POLICY;
  const x = c.exposure;
  const e = c.escalation;
  const pr = c.expectedLossPricing;
  return {
    creditPolicyVersion: c.version,
    servicingPolicy: s.name,
    sections: [
      {
        id: 'credit',
        title: 'Credit cutoffs',
        description: 'An application that fails any of these is declined or asked for more.',
        parameters: [
          param('minScore', 'Score cutoff', c.minScore, 'score', 'Below this the engine declines.'),
          param('minMonthsOfHistory', 'Bank history needed', c.minMonthsOfHistory, 'months'),
          param('minTimeInBusinessMonths', 'Time in business', c.minTimeInBusinessMonths, 'months'),
          param(
            'minVerifiedRevenueCents',
            'Verified monthly revenue floor',
            c.minVerifiedRevenueCents,
            'cents',
          ),
          param(
            'maxRentToRevenueBps',
            'Rent as a share of revenue, at most',
            c.maxRentToRevenueBps,
            'bps',
          ),
          param(
            'minCoverageRatio',
            'Free cash over rent plus fee, at least',
            c.minCoverageRatio / 100,
            'ratio',
          ),
          param('maxNsf90', 'Returned items in 90 days, at most', c.maxNsf90, 'count'),
          param(
            'maxNegativeBalanceDays90',
            'Days overdrawn in 90, at most',
            c.maxNegativeBalanceDays90,
            'days',
          ),
          param(
            'maxRevenueDeclineBps',
            'Steepest revenue decline accepted',
            c.maxRevenueDeclineBps,
            'bps',
          ),
          param(
            'maxStatedRevenueVarianceBps',
            'Stated over verified revenue before asking',
            c.maxStatedRevenueVarianceBps,
            'bps',
          ),
          param(
            'minCounterOfferBps',
            'Smallest counter offer, as a share of the request',
            c.minCounterOfferBps,
            'bps',
          ),
          param('limitIncrementCents', 'Limits round down to', c.limitIncrementCents, 'cents'),
        ],
      },
      {
        id: 'escalation',
        title: 'Referral to a reviewer',
        description:
          'What sends an application to the review queue instead of an automatic answer. Integrity flags with the REFER action and a tripped circuit breaker refer as well.',
        parameters: e
          ? [
              param(
                'referBand',
                'Refer scores from the cutoff up to',
                c.minScore + e.scoreBandAboveCutoff - 1,
                'score',
                `Scores ${c.minScore} to ${c.minScore + e.scoreBandAboveCutoff - 1} pass the cutoff but are referred.`,
              ),
              param('referAmountCents', 'Refer limits above', e.referAmountCents, 'cents'),
              param(
                'referCounterOfferBelowBps',
                'Refer first plan counter offers below',
                e.referCounterOfferBelowBps,
                'bps',
                'Share of the request. 0 never refers on a counter offer.',
              ),
              param(
                'watchScore',
                'Periodic review freezes below',
                c.reunderwriting.watchScore,
                'score',
              ),
            ]
          : [],
      },
      {
        id: 'exposure',
        title: 'Exposure caps',
        description:
          'Caps on one business, one industry, and the pool. Shares are of pool capital.',
        parameters: x
          ? [
              param(
                'maxBusinessExposureCents',
                'One business, all plans',
                x.maxBusinessExposureCents,
                'cents',
              ),
              param(
                'maxObservedRentMultipleBps',
                'Limit over rent seen in the account, at most',
                x.maxObservedRentMultipleBps,
                'bps',
              ),
              param(
                'maxSingleNameShareBps',
                'One business, share of capital',
                x.maxSingleNameShareBps,
                'bps',
              ),
              param(
                'maxIndustryShareBps',
                'One industry, share of capital',
                x.maxIndustryShareBps,
                'bps',
              ),
              param(
                'maxPoolUtilizationBps',
                'Committed rent over capital, ceiling',
                x.maxPoolUtilizationBps,
                'bps',
              ),
            ]
          : [],
      },
      {
        id: 'pricing',
        title: 'Expected loss pricing',
        description:
          'The fee is the largest of the grade floor, the minimum fee, and expected loss plus funding, servicing, and margin.',
        parameters: pr
          ? [
              param(
                'lossGivenDefaultBps',
                'Loss on a plan that goes bad, share of a month of rent',
                pr.lossGivenDefaultBps,
                'bps',
              ),
              param(
                'expectedPeriods',
                'Funded periods expected per plan',
                pr.expectedPeriods,
                'count',
              ),
              param('costOfFundsAprBps', 'Cost of funds, a year', pr.costOfFundsAprBps, 'bps'),
              param(
                'servicingCostCents',
                'Servicing cost per plan per month',
                pr.servicingCostCents,
                'cents',
              ),
              param('targetMarginBps', 'Target margin', pr.targetMarginBps, 'bps'),
              param('minFeeCents', 'Smallest fee per period', pr.minFeeCents, 'cents'),
              param(
                'maxFeeBps',
                'Largest fee per period',
                pr.maxFeeBps,
                'bps',
                'A required fee above this is a decline.',
              ),
              param('feeIncrementBps', 'Fees round up to', pr.feeIncrementBps, 'bps'),
            ]
          : [],
      },
      {
        id: 'servicing',
        title: 'Servicing',
        description: 'What happens after the landlord is paid.',
        parameters: [
          param('lateGraceDays', 'Grace before an installment is late', s.lateGraceDays, 'days'),
          param('defaultAfterDays', 'Default after', s.defaultAfterDays, 'days'),
          param('chargeOffAfterDays', 'Charge off after', s.chargeOffAfterDays, 'days'),
          param(
            'retryMaxAttempts',
            'Automatic debit attempts per installment',
            s.retry.maxAttempts,
            'count',
          ),
          param('retryIntervalDays', 'Days between attempts', s.retry.intervalDays, 'days'),
          param(
            'balancePreCheck',
            'Balance read before each debit',
            s.retry.balancePreCheck,
            'flag',
          ),
          param(
            'holdPayoutPastDueDays',
            'Hold the next payout when past due more than',
            s.holdPayoutPastDueDays,
            'days',
          ),
          param(
            'payoutReleaseWindowDays',
            'A held payout can still be paid for',
            s.payoutReleaseWindowDays,
            'days',
            'After that it is cancelled and the business pays the landlord itself.',
          ),
          param(
            'recoveryRateBps',
            'Recovery assumed on a written off balance',
            s.recoveryRateBps,
            'bps',
          ),
        ],
      },
      {
        id: 'controls',
        title: 'Operating controls',
        parameters: [
          param(
            'leaseChangeCoolingOffDays',
            'Landlord or payout change waits',
            CONTROLS_POLICY.leaseChangeCoolingOffDays,
            'days',
          ),
          param(
            'rescreenIntervalDays',
            'Parties are screened again every',
            CONTROLS_POLICY.rescreenIntervalDays,
            'days',
          ),
          param(
            'decisionNoticeDays',
            'An applicant must have an answer within',
            CONTROLS_POLICY.decisionNoticeDays,
            'days',
          ),
          param(
            'retentionMonths',
            'Applications and decisions are kept at least',
            CONTROLS_POLICY.retentionMonths,
            'months',
          ),
          param(
            'reopenSuppressionDays',
            'A resolved alert does not reopen for',
            m.reopenSuppressionDays,
            'days',
          ),
        ],
      },
      {
        id: 'monitoring-fraud',
        title: 'Monitoring: fraud',
        parameters: [
          param(
            'payoutProximityDays',
            'Landlord change this close before a payout',
            m.fraud.payoutProximityDays,
            'days',
          ),
          param(
            'sharedLandlordWarnUsers',
            'Users paying one landlord account, warning',
            m.fraud.sharedLandlordWarnUsers,
            'count',
          ),
          param(
            'sharedLandlordHighUsers',
            'Users paying one landlord account, high',
            m.fraud.sharedLandlordHighUsers,
            'count',
          ),
          param(
            'velocityWindowDays',
            'Application velocity window',
            m.fraud.velocityWindowDays,
            'days',
          ),
          param(
            'velocityWarnApplications',
            'Applications by one user in the window, warning',
            m.fraud.velocityWarnApplications,
            'count',
          ),
          param(
            'velocityHighApplications',
            'Applications by one user in the window, high',
            m.fraud.velocityHighApplications,
            'count',
          ),
          param(
            'reapplyWarnApplications',
            'New applications after a decline, warning',
            m.fraud.reapplyWarnApplications,
            'count',
            `Within ${m.fraud.reapplyWindowDays} days of the decline.`,
          ),
        ],
      },
      {
        id: 'monitoring-payments',
        title: 'Monitoring: payments',
        description: `Return rates are measured over the trailing ${m.payments.returnWindowDays} days. A rate at ${m.payments.warnAtShareBps / 100}% of its threshold is a warning.`,
        parameters: [
          param(
            'unauthorized',
            'Unauthorized return rate',
            m.payments.unauthorized.thresholdBps,
            'bps',
            `At least ${m.payments.unauthorized.minSample} debits and ${m.payments.unauthorized.minEvents} returns.`,
          ),
          param(
            'administrative',
            'Administrative return rate',
            m.payments.administrative.thresholdBps,
            'bps',
            `At least ${m.payments.administrative.minSample} debits and ${m.payments.administrative.minEvents} returns.`,
          ),
          param(
            'overall',
            'Overall return rate',
            m.payments.overall.thresholdBps,
            'bps',
            `At least ${m.payments.overall.minSample} debits and ${m.payments.overall.minEvents} returns.`,
          ),
          param(
            'repeatedFailureCount',
            'Failed debits on one account',
            m.payments.repeatedFailureCount,
            'count',
            `Inside ${m.payments.repeatedFailureWindowDays} days.`,
          ),
        ],
      },
      {
        id: 'monitoring-portfolio',
        title: 'Monitoring: portfolio',
        description: `Rates are read only on ${m.portfolio.minPlans} plans or more. Critical levels trip the circuit breaker.`,
        parameters: [
          param(
            'firstPaymentDefaultWarnBps',
            'First payment default rate, warning',
            m.portfolio.firstPaymentDefaultWarnBps,
            'bps',
          ),
          param(
            'firstPaymentDefaultCriticalBps',
            'First payment default rate, critical',
            m.portfolio.firstPaymentDefaultCriticalBps,
            'bps',
          ),
          param(
            'delinquentShareWarnBps',
            'Principal delinquent or in default, warning',
            m.portfolio.delinquentShareWarnBps,
            'bps',
          ),
          param(
            'delinquentShareCriticalBps',
            'Principal delinquent or in default, critical',
            m.portfolio.delinquentShareCriticalBps,
            'bps',
          ),
          param(
            'rollWarnBps',
            'Current balance rolling delinquent in a month, warning',
            m.portfolio.rollWarnBps,
            'bps',
          ),
          param(
            'rollCriticalBps',
            'Current balance rolling delinquent in a month, critical',
            m.portfolio.rollCriticalBps,
            'bps',
          ),
          param(
            'concentrationInfoShareBps',
            'Share of a cap at which an alert opens',
            m.portfolio.concentrationInfoShareBps,
            'bps',
          ),
          param(
            'utilizationCriticalBps',
            'Pool utilization, critical',
            m.portfolio.utilizationCriticalBps,
            'bps',
          ),
          param(
            'lossRatioWarnBps',
            'Realized over expected loss, warning',
            m.portfolio.lossRatioWarnBps,
            'bps',
          ),
          param(
            'lossRatioCriticalBps',
            'Realized over expected loss, critical',
            m.portfolio.lossRatioCriticalBps,
            'bps',
          ),
        ],
      },
      {
        id: 'monitoring-compliance',
        title: 'Monitoring: operations and compliance',
        parameters: [
          param(
            'decisionWarnDays',
            'Application undecided, warning',
            m.compliance.decisionWarnDays,
            'days',
          ),
          param(
            'decisionCriticalDays',
            'Application undecided, critical',
            m.compliance.decisionCriticalDays,
            'days',
          ),
          param(
            'screeningGraceDays',
            'Screening may age past the rescreen interval by',
            m.compliance.screeningGraceDays,
            'days',
          ),
          param('maxJobGapDays', 'A job may fall behind by', m.operations.maxJobGapDays, 'days'),
          param(
            'receivableToleranceCents',
            'Receivable difference ignored below',
            m.operations.receivableToleranceCents,
            'cents',
          ),
        ],
      },
    ],
    gradeTable: c.gradeFloors.map(([grade, minScore]) => ({
      grade,
      minScore,
      feeFloorBps: c.pricing[grade].feeBps,
      maxRentShareBps: c.pricing[grade].maxRentShareBps,
    })),
    ladder: (x?.ladder ?? []).map((rung) => ({ ...rung })),
    pdBands: (pr?.pdTable.bands ?? []).map((b) => ({
      minScore: b.minScore,
      maxScore: b.maxScore,
      pdBps: b.pdBps,
      plans: b.plans,
    })),
    scorecardWeights: Object.entries(c.weights).map(([factor, maxPoints]) => ({
      factor,
      maxPoints,
    })),
    integrityRules: Object.entries(INTEGRITY_RULES).map(([code, rule]) => ({ code, ...rule })),
    provisionRates: OPEN_BUCKETS.map((bucket) => ({
      bucket,
      rateBps: s.provisionRatesBps[bucket],
    })),
    returnCodes: Object.entries(RETURN_CODES)
      .map(([code, v]) => ({ code, class: v.class, reason: v.reason }))
      .sort((a, b) => a.code.localeCompare(b.code)),
    monitoringRules: RULES.map((r) => ({
      type: r.type,
      category: r.category,
      description: r.description,
      autoResolves: r.autoResolves,
      tripsCircuitBreaker: r.tripsCircuitBreaker,
    })),
  };
}

// ---------- Evaluation gates ----------

/** The checked in baseline of the portfolio evaluation, written by `eval:portfolio`. */
export const EVALUATION_BASELINE_PATH = fileURLToPath(
  new URL('../../evals/baseline.json', import.meta.url),
);

/**
 * What each gate tests, by id. The baseline file stores the numbers only; the wording is
 * the wording `evaluateGates` in `src/evals/gates.ts` reports.
 */
const GATE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  net_loss_base: 'Net loss at or under 75 bps of rent volume (base)',
  net_margin_base: 'Net margin above zero (base)',
  net_margin_mild_stress: 'Net margin above zero (mild stress)',
  bad_rate_monotonic:
    'Bad rate does not fall from grade A to D (cells of 30 or more plans, 100 bps tolerance)',
  auc: 'AUC of score against the bad flag at or above 0.70, all scored honest applicants (base)',
  fraud_approval: 'Under 5% of fraud archetype applicants approved, after review (base)',
  pool_funding: 'Pool always able to fund a payout at the planned growth rate (base)',
  approval_floor: 'Usable approval rate at or above 30% of applicants (base)',
  refer_rate: 'At most 5% of applicants referred to a reviewer (base)',
  veracity_honest_adverse:
    'At most 3% of honest applicants knocked out or referred by a data veracity finding (base)',
};

interface BaselineFile {
  run?: { n?: number; seeds?: string[]; horizonMonths?: number; poolSizeCents?: number };
  configurations?: Record<
    string,
    {
      policyVersion?: string;
      servicingPolicy?: string;
      gated?: boolean;
      gates?: Array<Omit<EvaluationGate, 'description'> & { description?: string }>;
    }
  >;
}

/**
 * Gate results of the last default evaluation run, read from the checked in baseline: the
 * gated configuration (the current credit policy under the active servicing policy). These
 * are simulation results. Nothing here is measured on the live book.
 */
export function evaluationView(path: string = EVALUATION_BASELINE_PATH): OperatorEvaluation {
  const source = 'apps/api/evals/baseline.json';
  const unavailable: OperatorEvaluation = {
    available: false,
    source,
    policyVersion: null,
    servicingPolicy: null,
    matchesCurrentPolicy: false,
    run: null,
    gates: [],
    allPass: false,
  };
  let file: BaselineFile;
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as BaselineFile;
  } catch {
    return unavailable;
  }
  const gated = Object.values(file.configurations ?? {}).find((c) => c.gated && c.gates);
  if (!gated?.gates) return unavailable;
  const gates = gated.gates.map((g) => ({
    ...g,
    description: g.description ?? GATE_DESCRIPTIONS[g.id] ?? g.id,
  }));
  return {
    available: true,
    source,
    policyVersion: gated.policyVersion ?? null,
    servicingPolicy: gated.servicingPolicy ?? null,
    matchesCurrentPolicy:
      gated.policyVersion === CURRENT_POLICY.version &&
      gated.servicingPolicy === ACTIVE_SERVICING_POLICY.name,
    run: file.run
      ? {
          applicantsPerSeed: file.run.n ?? 0,
          seeds: file.run.seeds ?? [],
          horizonMonths: file.run.horizonMonths ?? 0,
          poolSizeCents: file.run.poolSizeCents ?? 0,
        }
      : null,
    gates,
    allPass: gates.length > 0 && gates.every((g) => g.pass),
  };
}

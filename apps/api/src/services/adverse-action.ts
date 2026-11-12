import {
  addDays,
  principalReason,
  selectPrincipalReasons,
  type AdverseActionNoticeKind,
  type AdverseActionNoticeView,
  type DecisionReason,
  type IsoDate,
  type PrincipalReason,
} from '@cashflow/shared';

import { isAdverseAction, NOTICE_TITLES, renderNotice } from '../adverse-action/render.ts';
import {
  dueNotices,
  isCounterOffer,
  type ApplicationNoticeFacts,
  type DueNotice,
} from '../adverse-action/schedule.ts';
import { NOTICE_POLICY } from '../adverse-action/policy.ts';
import { clockNow, effectiveAt, todayIso } from '../dates.ts';
import type { Db, Tx } from '../db.ts';
import { forbidden, notFound, unprocessable } from '../errors.ts';
import type {
  AdverseActionNotice,
  Prisma,
  UnderwritingApplication,
  UnderwritingDecision,
} from '../generated/prisma/client.ts';
import { recordAudit, type AuditActor } from './audit.ts';
import { CURRENT_DECISION, currentDecision } from './decisions.ts';

/**
 * Adverse action notices: created, stored exactly as delivered, and never changed.
 *
 *   - A decline, by the engine or a reviewer, gets its notice in the same transaction as the
 *     decision (`createDeclineNoticeTx`).
 *   - A counter offer gets one when the owner declines it (`declineCounterOffer`), or when it
 *     expires without a plan opened on it (the notices job).
 *   - An application left waiting on information gets a notice of incompleteness, then, if it
 *     stays incomplete past the date given, a notice that it was closed (the notices job).
 *
 * The job also stores a notice for any decline that somehow has none, dated the day it runs
 * and marked late if past its deadline, and monitoring alerts on both.
 */

const day = (d: Date): IsoDate => d.toISOString().slice(0, 10);

/** The principal reasons stored on a decision, or worked out from its reasons if none were. */
export function decisionPrincipalReasons(
  decision: Pick<
    UnderwritingDecision,
    'outcome' | 'approvedMonthlyLimitCents' | 'reasons' | 'principalReasons' | 'snapshot'
  >,
  requestedMonthlyRentCents: number,
): PrincipalReason[] {
  const stored = decision.principalReasons as PrincipalReason[] | null;
  if (Array.isArray(stored) && stored.length > 0) return stored;
  const snapshot = decision.snapshot as { factors?: unknown } | null;
  return selectPrincipalReasons({
    outcome: decision.outcome,
    counterOffer:
      decision.outcome === 'APPROVED' &&
      decision.approvedMonthlyLimitCents !== null &&
      decision.approvedMonthlyLimitCents < requestedMonthlyRentCents,
    reasons: (decision.reasons as unknown as DecisionReason[]) ?? [],
    factors: Array.isArray(snapshot?.factors)
      ? (snapshot.factors as Parameters<typeof selectPrincipalReasons>[0]['factors'])
      : null,
  });
}

interface CreateNoticeArgs {
  application: Pick<UnderwritingApplication, 'id' | 'businessId' | 'requestedMonthlyRentCents'>;
  businessName: string;
  decisionId: string;
  kind: AdverseActionNoticeKind;
  principalReasons: PrincipalReason[];
  actionOn: IsoDate;
  deadlineOn: IsoDate;
  respondBy?: IsoDate | null;
  offer?: { limitCents: number; offeredOn: IsoDate; declinedByApplicant: boolean } | null;
  incomplete?: { askedOn: IsoDate; respondBy: IsoDate } | null;
  deliveredAt: Date;
  generatedBy: string;
  actor: AuditActor;
}

/** Render, store and deliver (in the app) one notice, with its audit event. */
export async function createNoticeTx(tx: Tx, a: CreateNoticeArgs): Promise<AdverseActionNotice> {
  const deliveredOn = day(a.deliveredAt);
  const rendered = renderNotice({
    kind: a.kind,
    businessName: a.businessName,
    applicationId: a.application.id,
    requestedMonthlyRentCents: a.application.requestedMonthlyRentCents,
    noticeOn: deliveredOn,
    principalReasons: a.principalReasons,
    offer: a.offer ?? null,
    incomplete: a.incomplete ?? null,
  });
  const notice = await tx.adverseActionNotice.create({
    data: {
      applicationId: a.application.id,
      decisionId: a.decisionId,
      businessId: a.application.businessId,
      kind: a.kind,
      principalReasons: a.principalReasons as unknown as Prisma.InputJsonValue,
      reasonCodes: a.principalReasons.map((r) => r.code),
      text: rendered.text,
      statementVersion: rendered.statementVersion,
      actionOn: a.actionOn,
      deadlineOn: a.deadlineOn,
      respondBy: a.respondBy ?? null,
      channel: 'IN_APP',
      deliveredAt: a.deliveredAt,
      generatedBy: a.generatedBy,
    },
  });
  const late = deliveredOn > a.deadlineOn;
  await recordAudit(tx, {
    actor: a.actor,
    eventType: 'ADVERSE_ACTION_NOTICE_SENT',
    subjectType: 'application',
    subjectId: a.application.id,
    payload: {
      noticeId: notice.id,
      decisionId: a.decisionId,
      kind: a.kind,
      reasonCodes: notice.reasonCodes,
      deadlineOn: a.deadlineOn,
      channel: 'IN_APP',
      late,
    },
    ...(late ? { severity: 'warning' as const } : {}),
    at: a.deliveredAt,
  });
  return notice;
}

/**
 * The notice for a decline, written in the transaction that writes the decline. The
 * deadline counts from the completed application (1002.9(a)(1)(i)).
 */
export async function createDeclineNoticeTx(
  tx: Tx,
  args: {
    application: Pick<
      UnderwritingApplication,
      'id' | 'businessId' | 'requestedMonthlyRentCents' | 'submittedAt'
    >;
    decision: Pick<UnderwritingDecision, 'id' | 'decidedAt'>;
    principalReasons: PrincipalReason[];
    generatedBy: string;
    actor: AuditActor;
  },
): Promise<AdverseActionNotice> {
  const business = await tx.business.findUniqueOrThrow({
    where: { id: args.application.businessId },
    select: { legalName: true },
  });
  const decidedOn = day(args.decision.decidedAt);
  const received = args.application.submittedAt ? day(args.application.submittedAt) : decidedOn;
  return createNoticeTx(tx, {
    application: args.application,
    businessName: business.legalName,
    decisionId: args.decision.id,
    kind: 'DECLINE',
    principalReasons: args.principalReasons,
    actionOn: decidedOn,
    deadlineOn: addDays(received, NOTICE_POLICY.noticeDays),
    deliveredAt: args.decision.decidedAt,
    generatedBy: args.generatedBy,
    actor: args.actor,
  });
}

// ---------- Facts, for the job and for monitoring ----------

/** What the notice schedule needs about each application that could owe one. */
export async function applicationNoticeFacts(
  db: Tx,
  where: Prisma.UnderwritingApplicationWhereInput = {},
): Promise<ApplicationNoticeFacts[]> {
  const rows = await db.underwritingApplication.findMany({
    where: { status: { in: ['DECLINED', 'APPROVED', 'NEEDS_INFO'] }, ...where },
    select: {
      id: true,
      businessId: true,
      status: true,
      submittedAt: true,
      requestedMonthlyRentCents: true,
      business: { select: { legalName: true } },
      decisions: {
        where: CURRENT_DECISION,
        orderBy: { decidedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          kind: true,
          outcome: true,
          decidedAt: true,
          approvedMonthlyLimitCents: true,
        },
      },
      rentPlans: { where: { kind: 'FINANCED' }, select: { id: true }, take: 1 },
    },
    orderBy: { createdAt: 'asc' },
  });
  const notices = await db.adverseActionNotice.findMany({
    where: { applicationId: { in: rows.map((r) => r.id) } },
    select: {
      applicationId: true,
      decisionId: true,
      kind: true,
      deliveredAt: true,
      deadlineOn: true,
      respondBy: true,
    },
  });
  const byApp = new Map<string, ApplicationNoticeFacts['notices']>();
  for (const n of notices) {
    const list = byApp.get(n.applicationId) ?? [];
    list.push({
      decisionId: n.decisionId,
      kind: n.kind,
      deliveredOn: day(n.deliveredAt),
      deadlineOn: n.deadlineOn,
      respondBy: n.respondBy,
    });
    byApp.set(n.applicationId, list);
  }
  return rows.map((r) => {
    const d = r.decisions[0] ?? null;
    return {
      applicationId: r.id,
      businessId: r.businessId,
      businessName: r.business.legalName,
      status: r.status,
      submittedOn: r.submittedAt ? day(r.submittedAt) : null,
      requestedMonthlyRentCents: r.requestedMonthlyRentCents,
      decision: d
        ? {
            id: d.id,
            kind: d.kind,
            outcome: d.outcome,
            decidedOn: day(d.decidedAt),
            approvedMonthlyLimitCents: d.approvedMonthlyLimitCents,
          }
        : null,
      hasFinancedPlan: r.rentPlans.length > 0,
      notices: byApp.get(r.id) ?? [],
    };
  });
}

/** Every notice due as of `asOf`, stored or not, across the book. */
export async function dueNoticesAsOf(db: Tx, asOf: IsoDate): Promise<DueNotice[]> {
  return (await applicationNoticeFacts(db)).flatMap((f) => dueNotices(f, asOf));
}

// ---------- The notices job ----------

export interface NoticeSweepSummary {
  [key: string]: number;
  due: number;
  created: number;
  late: number;
  decline: number;
  counterOffer: number;
  incomplete: number;
  incompleteDeclined: number;
}

/**
 * Store every notice that is due and missing. Idempotent: one notice per decision and kind,
 * enforced by a unique index, and a notice already stored is never touched.
 */
export async function sweepAdverseActionNotices(
  db: Db,
  asOf: IsoDate,
  options: { businessId?: string } = {},
): Promise<NoticeSweepSummary> {
  const facts = await applicationNoticeFacts(
    db,
    options.businessId ? { businessId: options.businessId } : {},
  );
  const summary: NoticeSweepSummary = {
    due: 0,
    created: 0,
    late: 0,
    decline: 0,
    counterOffer: 0,
    incomplete: 0,
    incompleteDeclined: 0,
  };
  const at = effectiveAt(asOf);
  for (const f of facts) {
    for (const due of dueNotices(f, asOf)) {
      summary.due += 1;
      if (due.stored) continue;
      await db.$transaction(async (tx) => {
        await createDueNoticeTx(tx, f, due, at);
      });
      summary.created += 1;
      if (asOf > due.deadlineOn) summary.late += 1;
      if (due.kind === 'DECLINE') summary.decline += 1;
      else if (due.kind === 'COUNTER_OFFER_NOT_ACCEPTED') summary.counterOffer += 1;
      else if (due.kind === 'INCOMPLETE') summary.incomplete += 1;
      else summary.incompleteDeclined += 1;
    }
  }
  return summary;
}

async function createDueNoticeTx(
  tx: Tx,
  f: ApplicationNoticeFacts,
  due: DueNotice,
  at: Date,
): Promise<AdverseActionNotice> {
  const decision = await tx.underwritingDecision.findUniqueOrThrow({
    where: { id: due.decisionId },
  });
  const application = {
    id: f.applicationId,
    businessId: f.businessId,
    requestedMonthlyRentCents: f.requestedMonthlyRentCents,
  };
  const reasons = decisionPrincipalReasons(decision, f.requestedMonthlyRentCents);
  const base = {
    application,
    businessName: f.businessName,
    decisionId: due.decisionId,
    kind: due.kind,
    actionOn: due.actionOn,
    deadlineOn: due.deadlineOn,
    deliveredAt: at,
    generatedBy: 'job',
    actor: { type: 'job' as const, id: 'adverse-action-notices' },
  };
  switch (due.kind) {
    case 'DECLINE':
      return createNoticeTx(tx, { ...base, principalReasons: reasons });
    case 'COUNTER_OFFER_NOT_ACCEPTED':
      return createNoticeTx(tx, {
        ...base,
        principalReasons: reasons,
        offer: {
          limitCents: decision.approvedMonthlyLimitCents ?? 0,
          offeredOn: day(decision.decidedAt),
          declinedByApplicant: false,
        },
      });
    case 'INCOMPLETE':
      return createNoticeTx(tx, {
        ...base,
        principalReasons: reasons,
        respondBy: due.respondBy,
        incomplete: { askedOn: day(at), respondBy: due.respondBy! },
      });
    case 'INCOMPLETE_DECLINED': {
      const asked = f.notices.find(
        (n) => n.decisionId === due.decisionId && n.kind === 'INCOMPLETE',
      )!;
      return createNoticeTx(tx, {
        ...base,
        principalReasons: [principalReason('APPLICATION_INCOMPLETE'), ...reasons].slice(0, 4),
        incomplete: { askedOn: asked.deliveredOn, respondBy: asked.respondBy! },
      });
    }
  }
}

// ---------- The owner's side ----------

/** The owner declines a counter offer. Stores the notice now; the offer is not withdrawn. */
export async function declineCounterOffer(db: Db, applicationId: string, userId: string) {
  return db.$transaction(async (tx) => {
    const application = await tx.underwritingApplication.findUnique({
      where: { id: applicationId },
      include: {
        business: { select: { ownerUserId: true, legalName: true } },
        rentPlans: { where: { kind: 'FINANCED' }, select: { id: true }, take: 1 },
      },
    });
    if (!application) throw notFound('Application');
    if (application.business.ownerUserId !== userId) throw forbidden();
    const decision = await currentDecision(tx, applicationId);
    const facts = {
      requestedMonthlyRentCents: application.requestedMonthlyRentCents,
      decision: decision
        ? {
            id: decision.id,
            kind: decision.kind,
            outcome: decision.outcome,
            decidedOn: day(decision.decidedAt),
            approvedMonthlyLimitCents: decision.approvedMonthlyLimitCents,
          }
        : null,
    } as ApplicationNoticeFacts;
    if (!decision || application.status !== 'APPROVED' || !isCounterOffer(facts)) {
      throw unprocessable(
        'NOT_A_COUNTER_OFFER',
        'This application has no counter offer to decline',
      );
    }
    if (application.rentPlans.length > 0) {
      throw unprocessable('OFFER_IN_USE', 'A plan is already running on this offer');
    }
    const existing = await tx.adverseActionNotice.findUnique({
      where: { decisionId_kind: { decisionId: decision.id, kind: 'COUNTER_OFFER_NOT_ACCEPTED' } },
    });
    if (existing) return existing;
    const now = clockNow();
    const actor = { type: 'user' as const, id: userId };
    await recordAudit(tx, {
      actor,
      eventType: 'COUNTER_OFFER_DECLINED',
      subjectType: 'application',
      subjectId: applicationId,
      payload: { decisionId: decision.id, limitCents: decision.approvedMonthlyLimitCents },
      at: now,
    });
    return createNoticeTx(tx, {
      application,
      businessName: application.business.legalName,
      decisionId: decision.id,
      kind: 'COUNTER_OFFER_NOT_ACCEPTED',
      principalReasons: decisionPrincipalReasons(decision, application.requestedMonthlyRentCents),
      actionOn: todayIso(now),
      deadlineOn: addDays(day(decision.decidedAt), NOTICE_POLICY.counterOfferNoticeDays),
      offer: {
        limitCents: decision.approvedMonthlyLimitCents ?? 0,
        offeredOn: day(decision.decidedAt),
        declinedByApplicant: true,
      },
      deliveredAt: now,
      generatedBy: 'applicant',
      actor,
    });
  });
}

export function toNoticeView(n: AdverseActionNotice): AdverseActionNoticeView {
  return {
    id: n.id,
    applicationId: n.applicationId,
    decisionId: n.decisionId,
    kind: n.kind,
    isAdverseAction: isAdverseAction(n.kind),
    title: NOTICE_TITLES[n.kind],
    principalReasons: n.principalReasons as unknown as PrincipalReason[],
    text: n.text,
    statementVersion: n.statementVersion,
    actionOn: n.actionOn,
    deadlineOn: n.deadlineOn,
    respondBy: n.respondBy,
    deliveredAt: n.deliveredAt.toISOString(),
    channel: n.channel,
    late: day(n.deliveredAt) > n.deadlineOn,
  };
}

export function noticesForApplication(db: Tx, applicationId: string) {
  return db.adverseActionNotice.findMany({
    where: { applicationId },
    orderBy: [{ deliveredAt: 'asc' }, { createdAt: 'asc' }],
  });
}

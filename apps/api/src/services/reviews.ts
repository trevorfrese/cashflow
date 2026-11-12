import {
  addDays,
  catalogEntry,
  daysBetween,
  principalReasonsFromCodes,
  selectPrincipalReasons,
  type PrincipalReason,
  type AdminIdentity,
  type DecisionOutcome,
  type DecisionReason,
  type IsoDate,
  type RecordReviewRequest,
  type ReviewQueueItem,
} from '@cashflow/shared';

import { CONTROLS_POLICY } from '../controls/policy.ts';

import { clockNow, todayIso } from '../dates.ts';
import type { Db } from '../db.ts';
import { notFound, unprocessable } from '../errors.ts';
import type { Prisma, UnderwritingDecision } from '../generated/prisma/client.ts';
import type { DecisionSnapshot } from '../underwriting/engine.ts';
import { CURRENT_POLICY } from '../underwriting/policy.ts';
import { createDeclineNoticeTx } from './adverse-action.ts';
import { recordAudit } from './audit.ts';
import { openHitsForBusiness } from './identity.ts';
import { applyApprovedRentIncreases } from './lease-changes.ts';
import {
  currentDecision,
  INCLUDE_CURRENT_DECISION,
  supersedeCurrentDecision,
} from './decisions.ts';

/**
 * Manual review.
 *
 * The engine refers an application when something needs a person: an integrity flag, a
 * score just over the cutoff, an amount over the threshold. A reviewer can also reconsider
 * an application the engine declined. Either way the review is recorded as its own row and
 * produces a new current decision. Nothing is edited: the engine's decision stays in the
 * history, superseded.
 *
 * An override is any review whose outcome or terms differ from what the engine recommended.
 * Overrides need at least one reason code and are logged as their own audit event, so the
 * override rate can be watched.
 */

const OUTCOME: Record<RecordReviewRequest['decision'], DecisionOutcome> = {
  APPROVE: 'APPROVED',
  DECLINE: 'DECLINED',
  REQUEST_INFO: 'NEEDS_INFO',
};

/** Statuses a reviewer may act on: referred applications, and declines up for reconsideration. */
const REVIEWABLE = new Set(['IN_REVIEW', 'DECLINED']);

/** Codes that head a reason list and are replaced when a review sets a new outcome. */
const HEADLINE_CODES = new Set([
  'IN_REVIEW',
  'APPROVED',
  'LIMIT_BELOW_REQUEST',
  'FUNDING_QUEUE',
  'APPROVED_AFTER_REVIEW',
  'DECLINED_AFTER_REVIEW',
  'INFO_REQUESTED',
]);

function snapshotOf(decision: UnderwritingDecision): DecisionSnapshot | null {
  return (decision.snapshot as unknown as DecisionSnapshot | null) ?? null;
}

/** What the engine would have done on its own, read from the decision under review. */
export function engineRecommendation(decision: UnderwritingDecision): {
  outcome: DecisionOutcome;
  approvedMonthlyLimitCents: number | null;
  feeBps: number | null;
} {
  const snapshot = snapshotOf(decision);
  if (snapshot?.recommendation) return snapshot.recommendation;
  return {
    outcome: decision.outcome,
    approvedMonthlyLimitCents: decision.approvedMonthlyLimitCents,
    feeBps: decision.feeBps,
  };
}

export interface RecordReviewArgs extends RecordReviewRequest {
  applicationId: string;
  /** Who is reviewing, from the authenticated request. Never from the body. */
  identity: AdminIdentity;
}

export async function recordReview(db: Db, args: RecordReviewArgs) {
  return db.$transaction(async (tx) => {
    const application = await tx.underwritingApplication.findUnique({
      where: { id: args.applicationId },
    });
    if (!application) throw notFound('Application');
    if (!REVIEWABLE.has(application.status)) {
      throw unprocessable(
        'NOT_REVIEWABLE',
        `Only applications in review or declined can be reviewed. This one is ${application.status.toLowerCase().replace('_', ' ')}`,
      );
    }
    const reviewed = await currentDecision(tx, application.id);
    if (!reviewed) throw unprocessable('NOT_REVIEWABLE', 'Application has no decision to review');

    const recommended = engineRecommendation(reviewed);
    const outcome = OUTCOME[args.decision];
    const reviewer = args.identity.actor;
    const actor = { type: args.identity.role, id: reviewer };

    // Identity and screening gate an approval, whoever makes it. An open hit has to be
    // cleared in the screening queue first, where the clearance is recorded on its own. A
    // business that is not verified can be approved only by a reviewer who states that they
    // verified it, which is then written to the business.
    let identityVerifiedByReviewer = false;
    if (args.decision === 'APPROVE') {
      const hits = await openHitsForBusiness(tx, application.businessId);
      if (hits.length > 0) {
        throw unprocessable(
          'SCREENING_HIT_OPEN',
          'This business has an open screening hit. Clear it in the screening queue before approving',
          { screeningIds: hits.map((h) => h.id) },
        );
      }
      const business = await tx.business.findUniqueOrThrow({
        where: { id: application.businessId },
      });
      if (business.verificationStatus !== 'VERIFIED') {
        if (!args.reasonCodes.includes('IDENTITY_VERIFIED')) {
          throw unprocessable(
            'IDENTITY_NOT_VERIFIED',
            `This business is ${business.verificationStatus.toLowerCase()} with the identity provider. Approving it needs the IDENTITY_VERIFIED reason code, which records that you verified it another way`,
            { verificationReasons: business.verificationReasons },
          );
        }
        identityVerifiedByReviewer = true;
        await tx.business.update({
          where: { id: business.id },
          data: {
            verificationStatus: 'VERIFIED',
            verificationCheckedAt: clockNow(),
            verificationReasons: ['MANUAL_REVIEW'],
          },
        });
        await recordAudit(tx, {
          actor,
          eventType: 'IDENTITY_CHECKED',
          subjectType: 'business',
          subjectId: business.id,
          payload: {
            status: 'VERIFIED',
            previousStatus: business.verificationStatus,
            previousReasons: business.verificationReasons,
            reasons: ['MANUAL_REVIEW'],
            applicationId: application.id,
          },
        });
      }
    }
    let limitCents: number | null = null;
    let feeBps: number | null = null;

    if (args.decision === 'APPROVE') {
      limitCents = args.approvedMonthlyLimitCents ?? recommended.approvedMonthlyLimitCents;
      feeBps = args.feeBps ?? recommended.feeBps;
      if (limitCents === null || feeBps === null) {
        throw unprocessable(
          'TERMS_REQUIRED',
          'The engine did not recommend terms for this application. Approving it needs a limit and a fee',
        );
      }
      if (limitCents <= 0 || limitCents > application.requestedMonthlyRentCents) {
        throw unprocessable(
          'LIMIT_OUT_OF_RANGE',
          'The approved limit must be above zero and no more than the rent requested',
          { requestedMonthlyRentCents: application.requestedMonthlyRentCents },
        );
      }
      const maxFeeBps = CURRENT_POLICY.expectedLossPricing?.maxFeeBps ?? 10_000;
      if (feeBps <= 0 || feeBps > maxFeeBps) {
        throw unprocessable(
          'FEE_OUT_OF_RANGE',
          'The fee must be above zero and within the maximum',
          {
            maxFeeBps,
          },
        );
      }
    } else if (args.approvedMonthlyLimitCents !== undefined || args.feeBps !== undefined) {
      throw unprocessable('TERMS_NOT_ALLOWED', 'A limit and fee can only be set on an approval');
    }
    if (args.decision === 'REQUEST_INFO' && !args.applicantMessage) {
      throw unprocessable(
        'APPLICANT_MESSAGE_REQUIRED',
        'Requesting information needs a message telling the applicant what to provide',
      );
    }

    const isOverride =
      outcome !== recommended.outcome ||
      (outcome === 'APPROVED' &&
        (limitCents !== recommended.approvedMonthlyLimitCents || feeBps !== recommended.feeBps));
    if (isOverride && args.reasonCodes.length === 0) {
      throw unprocessable(
        'REASON_CODES_REQUIRED',
        'This review differs from the engine recommendation, so it needs at least one reason code',
        { recommended },
      );
    }

    // What the applicant is told comes from the reason catalog, never free text alone: a
    // decline needs at least one reason a reviewer may decline for (these become the
    // principal reasons on the adverse action notice), and a request for information at
    // least one thing to ask for.
    const pickAction =
      args.decision === 'DECLINE'
        ? ('DECLINE' as const)
        : args.decision === 'REQUEST_INFO'
          ? ('REQUEST_INFO' as const)
          : null;
    const picks = args.principalReasonCodes ?? [];
    if (pickAction === null && picks.length > 0) {
      throw unprocessable(
        'PRINCIPAL_REASONS_NOT_ALLOWED',
        'Applicant reasons are picked on a decline or a request for information',
      );
    }
    if (pickAction !== null) {
      if (picks.length === 0) {
        throw unprocessable(
          'PRINCIPAL_REASONS_REQUIRED',
          args.decision === 'DECLINE'
            ? 'A decline needs at least one reason from the catalog: it is what the adverse action notice tells the applicant'
            : 'A request for information needs at least one item from the catalog to ask for',
        );
      }
      const wrong = picks.filter(
        (c) =>
          !(catalogEntry(c)?.reviewerActions as readonly string[] | undefined)?.includes(
            pickAction,
          ),
      );
      if (wrong.length > 0) {
        throw unprocessable(
          'PRINCIPAL_REASON_NOT_ALLOWED',
          `These reasons cannot be given for this review: ${wrong.join(', ')}`,
          { codes: wrong },
        );
      }
    }

    const review = await tx.applicationReview.create({
      data: {
        applicationId: application.id,
        reviewer,
        decision: args.decision,
        reasonCodes: args.reasonCodes,
        notes: args.notes ?? null,
        approvedMonthlyLimitCents: limitCents,
        feeBps,
        isOverride,
        reviewedDecisionId: reviewed.id,
      },
    });

    const usd = (cents: number) =>
      (cents / 100).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      });
    const headline: DecisionReason =
      outcome === 'APPROVED'
        ? {
            code: 'APPROVED_AFTER_REVIEW',
            message: `Approved after review for up to ${usd(limitCents!)} of monthly rent at a ${(feeBps! / 100).toFixed(2).replace(/\.?0+$/, '')}% fee.`,
            impact: 'POSITIVE',
          }
        : outcome === 'DECLINED'
          ? {
              code: 'DECLINED_AFTER_REVIEW',
              message: 'After a review by our team we could not approve this application.',
              impact: 'NEGATIVE',
            }
          : { code: 'INFO_REQUESTED', message: args.applicantMessage!, impact: 'INFO' };
    const carried = ((reviewed.reasons as unknown as DecisionReason[]) ?? []).filter(
      (r) => !HEADLINE_CODES.has(r.code),
    );
    const reviewedSnapshot = snapshotOf(reviewed);
    const principalReasons: PrincipalReason[] =
      pickAction !== null
        ? principalReasonsFromCodes(picks, carried)
        : selectPrincipalReasons({
            outcome,
            counterOffer: limitCents !== null && limitCents < application.requestedMonthlyRentCents,
            reasons: carried,
            factors: reviewedSnapshot?.factors ?? null,
          });

    const now = clockNow();
    await supersedeCurrentDecision(tx, application.id, now);
    const decision = await tx.underwritingDecision.create({
      data: {
        applicationId: application.id,
        kind: 'REVIEW',
        outcome,
        approvedMonthlyLimitCents: limitCents,
        feeBps,
        score: reviewed.score,
        grade: reviewed.grade,
        recommendedInstallmentsPerMonth: reviewed.recommendedInstallmentsPerMonth,
        reasons: [headline, ...carried] as unknown as Prisma.InputJsonValue,
        ...(principalReasons.length > 0
          ? { principalReasons: principalReasons as unknown as Prisma.InputJsonValue }
          : {}),
        cashFlow: (reviewed.cashFlow ?? null) as Prisma.InputJsonValue,
        policyVersion: reviewed.policyVersion,
        snapshot: {
          ...((reviewed.snapshot as Record<string, unknown> | null) ?? {}),
          review: {
            reviewId: review.id,
            reviewer,
            reviewerRole: args.identity.role,
            identityVerifiedByReviewer,
            decision: args.decision,
            reasonCodes: args.reasonCodes,
            principalReasonCodes: picks,
            isOverride,
            reviewedDecisionId: reviewed.id,
          },
        } as Prisma.InputJsonValue,
        reviewId: review.id,
        isOverride,
        provider: reviewed.provider,
        decidedAt: now,
      },
    });
    const updated = await tx.underwritingApplication.update({
      where: { id: application.id },
      data: { status: outcome === 'REFER' ? 'IN_REVIEW' : outcome },
    });
    if (outcome === 'APPROVED') {
      await tx.business.update({
        where: { id: application.businessId },
        data: { status: 'ACTIVE' },
      });
    }

    await recordAudit(tx, {
      actor,
      eventType: 'REVIEW_RECORDED',
      subjectType: 'application',
      subjectId: application.id,
      payload: {
        reviewId: review.id,
        decision: args.decision,
        reasonCodes: args.reasonCodes,
        principalReasonCodes: picks,
        isOverride,
        reviewedDecisionId: reviewed.id,
      },
    });
    await recordAudit(tx, {
      actor,
      eventType: 'DECISION_MADE',
      subjectType: 'application',
      subjectId: application.id,
      payload: {
        decisionId: decision.id,
        previousDecisionId: reviewed.id,
        kind: 'REVIEW',
        outcome,
        policyVersion: reviewed.policyVersion,
      },
    });
    if (isOverride) {
      await recordAudit(tx, {
        actor,
        eventType: 'DECISION_OVERRIDDEN',
        subjectType: 'application',
        subjectId: application.id,
        payload: {
          reviewId: review.id,
          decisionId: decision.id,
          recommended,
          recorded: { outcome, approvedMonthlyLimitCents: limitCents, feeBps },
          reasonCodes: args.reasonCodes,
        },
      });
    }
    if (outcome === 'DECLINED') {
      // The notice states the reviewer's reasons, and goes out with the decision.
      await createDeclineNoticeTx(tx, {
        application: updated,
        decision,
        principalReasons,
        generatedBy: `reviewer:${reviewer}`,
        actor,
      });
    }
    if (outcome === 'APPROVED') {
      await recordAudit(tx, {
        actor,
        eventType: 'LIMIT_FEE_SET',
        subjectType: 'application',
        subjectId: application.id,
        payload: {
          decisionId: decision.id,
          approvedMonthlyLimitCents: limitCents,
          feeBps,
          source: 'review',
        },
      });
      await applyApprovedRentIncreases(tx, {
        businessId: application.businessId,
        applicationId: application.id,
        decisionId: decision.id,
        approvedMonthlyLimitCents: limitCents!,
        feeBps: feeBps!,
        actor,
        asOf: todayIso(),
      });
    }
    return { review, application: { ...updated, decision } };
  });
}

/**
 * How long an application has waited and when its answer is due: the notice deadline in the
 * controls policy, counted from submission.
 */
export function decisionClock(
  submittedAt: Date | null,
  today: IsoDate,
): { ageDays: number | null; decisionDueOn: IsoDate | null } {
  if (!submittedAt) return { ageDays: null, decisionDueOn: null };
  const submittedOn = submittedAt.toISOString().slice(0, 10);
  return {
    ageDays: Math.max(0, daysBetween(submittedOn, today)),
    decisionDueOn: addDays(submittedOn, CONTROLS_POLICY.decisionNoticeDays),
  };
}

/** Applications waiting for a reviewer, oldest first, with what the engine found. */
export async function listReviewQueue(db: Db): Promise<ReviewQueueItem[]> {
  const rows = await db.underwritingApplication.findMany({
    where: { status: 'IN_REVIEW' },
    include: { business: true, ...INCLUDE_CURRENT_DECISION },
    orderBy: { submittedAt: 'asc' },
  });
  const today = todayIso();
  return rows.flatMap((row) => {
    const decision = row.decisions[0];
    if (!decision) return [];
    const snapshot = snapshotOf(decision);
    const recommended = engineRecommendation(decision);
    return [
      {
        applicationId: row.id,
        businessId: row.businessId,
        businessName: row.business.legalName,
        status: row.status,
        requestedMonthlyRentCents: row.requestedMonthlyRentCents,
        submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
        ...decisionClock(row.submittedAt, today),
        policyVersion: decision.policyVersion,
        score: decision.score,
        grade: (decision.grade as ReviewQueueItem['grade']) ?? null,
        recommendedOutcome: recommended.outcome,
        recommendedMonthlyLimitCents: recommended.approvedMonthlyLimitCents,
        recommendedFeeBps: recommended.feeBps,
        referTriggers: snapshot?.referTriggers ?? [],
        integrityFlags: (snapshot?.integrityFlags ?? []).map((f) => ({
          code: f.code,
          severity: f.severity,
          action: f.action,
          detail: f.detail,
        })),
        reasons: (decision.reasons as unknown as DecisionReason[]) ?? [],
      },
    ];
  });
}

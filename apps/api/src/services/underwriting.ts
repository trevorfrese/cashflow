import type { IsoDate } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';

import { effectiveAt, todayIso } from '../dates.ts';
import type { Db } from '../db.ts';
import type { BankLink, CommerceLink, Prisma } from '../generated/prisma/client.ts';
import type { Providers } from '../providers/index.ts';
import type { EngineInput } from '../underwriting/engine.ts';
import { recordAudit } from './audit.ts';
import { approvalsPaused } from './circuit-breaker.ts';
import { supersedeCurrentDecision } from './decisions.ts';
import { gatherIdentityFacts, runBusinessIdentity } from './identity.ts';
import { applyApprovedRentIncreases } from './lease-changes.ts';
import { gatherExposureContext, gatherIntegrityContext } from './portfolio-state.ts';

/**
 * How much bank history underwriting asks the bank provider for. A little over a year, so
 * the last four weeks can be compared with the same weeks a year earlier.
 */
export const UNDERWRITING_LOOKBACK_DAYS = 400;

export interface UnderwriteParams {
  db: Db;
  providers: Providers;
  applicationId: string;
  /** The bank link to underwrite against, or null to decide without bank data. */
  bankLink: BankLink | null;
  /** A connected point of sale, or null to rely on bank deposits alone. */
  commerceLink?: CommerceLink | null;
  asOf?: IsoDate;
}

/**
 * Pull bank data for the link (and platform sales when a commerce link is given), look up
 * what the integrity and exposure rules need from the database, run the underwriting
 * provider, and persist the decision together with the application status change and the
 * audit events. Approval also activates the business. A REFER puts the application in review.
 *
 * Identity and screening run first, on every submission: the business and its owners go
 * through the identity provider again, and the stored result (with any open screening hit on
 * the business, an owner, or a landlord) is handed to the engine as an integrity input. A
 * business that is not VERIFIED, or a possible match, is referred; a failed verification is
 * declined; a match is held in review. The circuit breaker is read the same way.
 *
 * Decisions are append-only: a resubmission adds a new decision and marks the previous one
 * as superseded.
 */
export async function underwriteApplication({
  db,
  providers,
  applicationId,
  bankLink,
  commerceLink = null,
  asOf = todayIso(),
}: UnderwriteParams) {
  const application = await db.underwritingApplication.findUniqueOrThrow({
    where: { id: applicationId },
    include: { business: true },
  });

  let bankData: EngineInput['bankData'] = null;
  if (bankLink) {
    bankData = await gatherBankData(providers, bankLink, asOf);
    if (bankData.currentBalanceCents !== bankLink.availableBalanceCents) {
      await db.bankLink.update({
        where: { id: bankLink.id },
        data: { availableBalanceCents: bankData.currentBalanceCents },
      });
    }
  }

  let commerceData: EngineInput['commerceData'] = null;
  if (commerceLink) {
    commerceData = {
      platform: commerceLink.platform,
      connectedSince: commerceLink.connectedSince,
      dailySales: await providers.commerce.getDailySales(commerceLink.providerItemId, {
        from: addDays(asOf, -(UNDERWRITING_LOOKBACK_DAYS - 1)),
        to: asOf,
      }),
    };
  }

  const now = effectiveAt(asOf);
  await runBusinessIdentity({ db, providers }, application.businessId, { at: now });

  // A plan waiting on this decision for a rent increase is left out of the exposure totals:
  // the question is whether we would carry that lease at the new rent.
  const pendingRentPlan = await db.rentPlan.findFirst({
    where: {
      businessId: application.businessId,
      status: { not: 'CLOSED' },
      pendingRentCents: { not: null },
    },
    orderBy: { pendingRentSince: 'asc' },
    select: { id: true },
  });
  const [integrityBase, identity, exposureContext, paused] = await Promise.all([
    gatherIntegrityContext(db, application.business, { bankLink }),
    gatherIdentityFacts(db, application.businessId),
    gatherExposureContext(db, providers, {
      businessId: application.businessId,
      industry: application.business.industry,
      ...(pendingRentPlan ? { excludePlanId: pendingRentPlan.id } : {}),
    }),
    approvalsPaused(db),
  ]);
  const integrityContext = {
    ...integrityBase,
    identity,
    // We already pay this landlord, so the old rent in the account is not a ceiling.
    ...(pendingRentPlan ? { leaseVerified: true } : {}),
  };

  const result = await providers.underwriting.decide({
    statedMonthlyRevenueCents: application.statedMonthlyRevenueCents,
    timeInBusinessMonths: application.timeInBusinessMonths,
    requestedMonthlyRentCents: application.requestedMonthlyRentCents,
    bankData,
    commerceData,
    integrityContext,
    exposureContext,
    controls: { approvalsPaused: paused },
  });

  return db.$transaction(async (tx) => {
    // Append-only: the previous decision is kept and marked as replaced.
    const previousDecisionId = await supersedeCurrentDecision(tx, applicationId, now);
    const decision = await tx.underwritingDecision.create({
      data: {
        applicationId,
        kind: 'ENGINE',
        outcome: result.outcome,
        approvedMonthlyLimitCents: result.approvedMonthlyLimitCents,
        feeBps: result.feeBps,
        score: result.score,
        grade: result.grade,
        recommendedInstallmentsPerMonth: result.recommendedInstallmentsPerMonth,
        reasons: result.reasons as unknown as Prisma.InputJsonValue,
        cashFlow: (result.cashFlow ?? null) as unknown as Prisma.InputJsonValue,
        policyVersion: result.policyVersion,
        snapshot: result.snapshot as unknown as Prisma.InputJsonValue,
        provider: providers.underwriting.name,
        decidedAt: now,
      },
    });
    const row = await tx.underwritingApplication.update({
      where: { id: applicationId },
      data: {
        bankLinkId: bankLink?.id ?? null,
        commerceLinkId: commerceLink?.id ?? null,
        status: result.outcome === 'REFER' ? 'IN_REVIEW' : result.outcome,
        submittedAt: now,
      },
    });
    if (result.outcome === 'APPROVED') {
      await tx.business.update({
        where: { id: application.businessId },
        data: { status: 'ACTIVE' },
      });
    }

    await recordAudit(tx, {
      actor: { type: 'system', id: providers.underwriting.name },
      eventType: 'DECISION_MADE',
      subjectType: 'application',
      subjectId: applicationId,
      payload: {
        decisionId: decision.id,
        previousDecisionId,
        kind: 'ENGINE',
        outcome: result.outcome,
        policyVersion: result.policyVersion,
        score: result.score,
        grade: result.grade,
        integrityFlags: result.snapshot.integrityFlags.map((f) => f.code),
      },
      at: now,
    });
    if (result.outcome === 'REFER') {
      await recordAudit(tx, {
        actor: { type: 'system', id: providers.underwriting.name },
        eventType: 'APPLICATION_REFERRED',
        subjectType: 'application',
        subjectId: applicationId,
        payload: { decisionId: decision.id, triggers: result.snapshot.referTriggers },
        at: now,
      });
    }
    if (result.outcome === 'APPROVED') {
      await recordAudit(tx, {
        actor: { type: 'system', id: providers.underwriting.name },
        eventType: 'LIMIT_FEE_SET',
        subjectType: 'application',
        subjectId: applicationId,
        payload: {
          decisionId: decision.id,
          approvedMonthlyLimitCents: result.approvedMonthlyLimitCents,
          feeBps: result.feeBps,
          source: 'engine',
        },
        at: now,
      });
      await applyApprovedRentIncreases(tx, {
        businessId: application.businessId,
        applicationId,
        decisionId: decision.id,
        approvedMonthlyLimitCents: result.approvedMonthlyLimitCents ?? 0,
        feeBps: result.feeBps ?? 0,
        actor: { type: 'system', id: providers.underwriting.name },
        asOf,
      });
    }
    return { ...row, decision };
  });
}

export async function gatherBankData(providers: Providers, bankLink: BankLink, asOf: IsoDate) {
  const [transactions, currentBalanceCents] = await Promise.all([
    providers.bankLink.getTransactions(bankLink.providerItemId, {
      from: addDays(asOf, -(UNDERWRITING_LOOKBACK_DAYS - 1)),
      to: asOf,
    }),
    providers.bankLink.refreshBalance(bankLink.providerItemId),
  ]);
  return { transactions, currentBalanceCents, asOf };
}

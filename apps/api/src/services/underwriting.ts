import type { IsoDate } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';

import { todayIso } from '../dates.ts';
import type { Db } from '../db.ts';
import type { BankLink, CommerceLink, Prisma } from '../generated/prisma/client.ts';
import type { Providers } from '../providers/index.ts';
import type { EngineInput } from '../underwriting/engine.ts';
import { recordAudit } from './audit.ts';
import { supersedeCurrentDecision } from './decisions.ts';
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

  const [integrityContext, exposureContext] = await Promise.all([
    gatherIntegrityContext(db, application.business, { bankLink }),
    gatherExposureContext(db, providers, {
      businessId: application.businessId,
      industry: application.business.industry,
    }),
  ]);

  const result = await providers.underwriting.decide({
    statedMonthlyRevenueCents: application.statedMonthlyRevenueCents,
    timeInBusinessMonths: application.timeInBusinessMonths,
    requestedMonthlyRentCents: application.requestedMonthlyRentCents,
    bankData,
    commerceData,
    integrityContext,
    exposureContext,
  });

  return db.$transaction(async (tx) => {
    // Append-only: the previous decision is kept and marked as replaced.
    const now = new Date();
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
    });
    if (result.outcome === 'REFER') {
      await recordAudit(tx, {
        actor: { type: 'system', id: providers.underwriting.name },
        eventType: 'APPLICATION_REFERRED',
        subjectType: 'application',
        subjectId: applicationId,
        payload: { decisionId: decision.id, triggers: result.snapshot.referTriggers },
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

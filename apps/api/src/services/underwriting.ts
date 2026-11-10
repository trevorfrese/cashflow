import type { IsoDate } from '@cashflow/shared';
import { addDays } from '@cashflow/shared';

import { todayIso } from '../dates.ts';
import type { Db } from '../db.ts';
import type { BankLink, CommerceLink, Prisma } from '../generated/prisma/client.ts';
import type { Providers } from '../providers/index.ts';
import type { EngineInput } from '../underwriting/engine.ts';

/** How much bank history underwriting asks the bank provider for. */
export const UNDERWRITING_LOOKBACK_DAYS = 365;

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
 * Pull bank data for the link (and platform sales when a commerce link is given), run the
 * underwriting provider, and persist the decision
 * together with the application status change. Approval also activates the business.
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

  const result = await providers.underwriting.decide({
    statedMonthlyRevenueCents: application.statedMonthlyRevenueCents,
    timeInBusinessMonths: application.timeInBusinessMonths,
    requestedMonthlyRentCents: application.requestedMonthlyRentCents,
    bankData,
    commerceData,
  });

  return db.$transaction(async (tx) => {
    await tx.underwritingDecision.deleteMany({ where: { applicationId } });
    const row = await tx.underwritingApplication.update({
      where: { id: applicationId },
      data: {
        bankLinkId: bankLink?.id ?? null,
        commerceLinkId: commerceLink?.id ?? null,
        status: result.outcome,
        submittedAt: new Date(),
        decision: {
          create: {
            outcome: result.outcome,
            approvedMonthlyLimitCents: result.approvedMonthlyLimitCents,
            feeBps: result.feeBps,
            score: result.score,
            grade: result.grade,
            recommendedInstallmentsPerMonth: result.recommendedInstallmentsPerMonth,
            reasons: result.reasons as unknown as Prisma.InputJsonValue,
            cashFlow: (result.cashFlow ?? null) as unknown as Prisma.InputJsonValue,
            provider: providers.underwriting.name,
          },
        },
      },
      include: { decision: true },
    });
    if (result.outcome === 'APPROVED') {
      await tx.business.update({
        where: { id: application.businessId },
        data: { status: 'ACTIVE' },
      });
    }
    return row;
  });
}

async function gatherBankData(providers: Providers, bankLink: BankLink, asOf: IsoDate) {
  const [transactions, currentBalanceCents] = await Promise.all([
    providers.bankLink.getTransactions(bankLink.providerItemId, {
      from: addDays(asOf, -(UNDERWRITING_LOOKBACK_DAYS - 1)),
      to: asOf,
    }),
    providers.bankLink.refreshBalance(bankLink.providerItemId),
  ]);
  return { transactions, currentBalanceCents, asOf };
}

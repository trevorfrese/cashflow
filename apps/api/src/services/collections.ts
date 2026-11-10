import { effectiveAt } from '../dates.ts';
import { addDays, type IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { ACCOUNTS, receivableCode } from '../ledger/accounts.ts';
import { accountBalance, postTransaction } from '../ledger/service.ts';

export type CollectionOutcome = 'paid' | 'failed' | 'late' | 'skipped';

/** Days after the due date before a failed installment is marked LATE. */
export const LATE_GRACE_DAYS = 3;

/**
 * Collects one installment from the business's linked bank account. Posts principal against
 * the receivable and the fee to revenue, with cash going up by the total. Retries create a
 * new Repayment attempt each time; a PAID installment is skipped.
 */
export async function collectInstallment(
  ctx: AppContext,
  installmentId: string,
  asOf: IsoDate,
  options: { allowEarly?: boolean } = {},
): Promise<CollectionOutcome> {
  const { db, providers } = ctx;
  return db.$transaction(async (tx) => {
    const installment = await tx.installment.findUnique({
      where: { id: installmentId },
      include: {
        payout: true,
        rentPlan: {
          include: {
            business: {
              include: {
                bankLinks: { where: { status: 'LINKED' }, orderBy: { createdAt: 'desc' }, take: 1 },
              },
            },
          },
        },
        repayments: true,
      },
    });
    if (!installment) return 'skipped';
    if (installment.status === 'PAID' || installment.status === 'COLLECTING') return 'skipped';
    if (!options.allowEarly && installment.dueDate > asOf) return 'skipped';
    // Never collect from a business before its landlord has been paid.
    if (installment.payout.status !== 'PAID') return 'skipped';

    const attempt = installment.repayments.length + 1;
    const isLate = addDays(installment.dueDate, LATE_GRACE_DAYS) < asOf;

    const fail = async (reason: string, providerRef: string | null): Promise<CollectionOutcome> => {
      await tx.repayment.create({
        data: {
          installmentId: installment.id,
          amountCents: installment.totalCents,
          provider: providers.payments.name,
          providerRef,
          status: 'FAILED',
          failureReason: reason,
        },
      });
      await tx.installment.update({
        where: { id: installment.id },
        data: { status: isLate ? 'LATE' : 'FAILED' },
      });
      ctx.log.warn(
        { installmentId: installment.id, reason, attempt },
        'installment collection failed',
      );
      return isLate ? 'late' : 'failed';
    };

    const bankLink = installment.rentPlan.business.bankLinks[0];
    if (!bankLink) return fail('No linked bank account to collect from', null);

    const result = await providers.payments.charge({
      amountCents: installment.totalCents,
      sourceToken: bankLink.providerAccountToken,
      idempotencyKey: `installment:${installment.id}:attempt:${attempt}`,
      description: `Rent installment ${installment.sequence} for ${installment.periodMonth}`,
    });
    if (!result.ok) return fail(result.failureReason, result.providerRef);

    await tx.repayment.create({
      data: {
        installmentId: installment.id,
        amountCents: installment.totalCents,
        provider: providers.payments.name,
        providerRef: result.providerRef,
        status: 'SUCCEEDED',
        createdAt: effectiveAt(asOf),
      },
    });

    const entries = [
      {
        accountCode: ACCOUNTS.CASH,
        direction: 'DEBIT' as const,
        amountCents: installment.totalCents,
      },
      {
        accountCode: receivableCode(installment.rentPlan.businessId),
        direction: 'CREDIT' as const,
        amountCents: installment.principalCents,
      },
    ];
    if (installment.feeCents > 0) {
      entries.push({
        accountCode: ACCOUNTS.FEE_REVENUE,
        direction: 'CREDIT' as const,
        amountCents: installment.feeCents,
      });
    }
    await postTransaction(tx, {
      description: `Installment ${installment.sequence} collected for ${installment.periodMonth}`,
      referenceType: 'installment',
      referenceId: installment.id,
      idempotencyKey: `installment:${installment.id}`,
      entries,
    });

    await tx.installment.update({
      where: { id: installment.id },
      data: { status: 'PAID', paidAt: effectiveAt(asOf) },
    });
    ctx.log.info(
      { installmentId: installment.id, amountCents: installment.totalCents },
      'installment collected',
    );
    return 'paid';
  });
}

/**
 * Moves collected operating cash back into the capital pool so it can fund the next payouts.
 * Running it twice in a row is harmless: the second run finds nothing to sweep.
 */
export async function sweepCashToPool(ctx: AppContext, asOf: IsoDate): Promise<number> {
  return ctx.db.$transaction(async (tx) => {
    const cash = await accountBalance(tx, ACCOUNTS.CASH);
    if (cash <= 0) return 0;
    await postTransaction(tx, {
      description: `Sweep collected cash to capital pool as of ${asOf}`,
      referenceType: 'cash_sweep',
      entries: [
        { accountCode: ACCOUNTS.CAPITAL_POOL, direction: 'DEBIT', amountCents: cash },
        { accountCode: ACCOUNTS.CASH, direction: 'CREDIT', amountCents: cash },
      ],
    });
    return cash;
  });
}

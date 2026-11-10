import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { ACCOUNTS, receivableCode } from '../ledger/accounts.ts';
import { postTransaction } from '../ledger/service.ts';
import { InsufficientCapitalError } from '../providers/capital/index.ts';

export type PayoutOutcome = 'paid' | 'failed' | 'skipped';

/**
 * Pays the landlord for one period. Reserves capital, calls the payments provider, and posts
 * the ledger entry (receivable up, capital pool down) in the same transaction as the status
 * change. Safe to retry: a PAID payout is skipped, and the provider call is idempotent by key.
 */
export async function processPayout(
  ctx: AppContext,
  payoutId: string,
  asOf: IsoDate,
): Promise<PayoutOutcome> {
  const { db, providers } = ctx;
  return db.$transaction(async (tx) => {
    const payout = await tx.landlordPayout.findUnique({
      where: { id: payoutId },
      include: { rentPlan: { include: { lease: true, business: true } } },
    });
    if (!payout) return 'skipped';
    if (payout.status === 'PAID' || payout.status === 'PROCESSING') return 'skipped';
    if (payout.scheduledFor > asOf) return 'skipped';
    if (payout.rentPlan.status !== 'ACTIVE') return 'skipped';

    const fail = async (reason: string): Promise<PayoutOutcome> => {
      await tx.landlordPayout.update({
        where: { id: payout.id },
        data: { status: 'FAILED', failureReason: reason },
      });
      ctx.log.warn({ payoutId: payout.id, reason }, 'landlord payout failed');
      return 'failed';
    };

    try {
      await providers.capital.reserve(tx, payout.amountCents, `payout:${payout.id}`);
    } catch (err) {
      if (err instanceof InsufficientCapitalError) return fail(err.message);
      throw err;
    }

    const result = await providers.payments.payout({
      amountCents: payout.amountCents,
      destinationToken: payout.rentPlan.lease.landlordPayoutToken,
      idempotencyKey: `payout:${payout.id}`,
      description: `Rent ${payout.periodMonth} for ${payout.rentPlan.business.legalName} to ${payout.rentPlan.lease.landlordName}`,
    });
    if (!result.ok) return fail(result.failureReason);

    await postTransaction(tx, {
      description: `Landlord payout ${payout.periodMonth}: ${payout.rentPlan.business.legalName}`,
      referenceType: 'landlord_payout',
      referenceId: payout.id,
      idempotencyKey: `payout:${payout.id}`,
      entries: [
        {
          accountCode: receivableCode(payout.rentPlan.businessId),
          direction: 'DEBIT',
          amountCents: payout.amountCents,
        },
        {
          accountCode: ACCOUNTS.CAPITAL_POOL,
          direction: 'CREDIT',
          amountCents: payout.amountCents,
        },
      ],
    });

    await tx.landlordPayout.update({
      where: { id: payout.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        providerRef: result.providerRef,
        failureReason: null,
      },
    });
    ctx.log.info({ payoutId: payout.id, amountCents: payout.amountCents }, 'landlord payout paid');
    return 'paid';
  });
}

import { addDays, daysBetween, type IsoDate, type PayoutHoldReason } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import type { Tx } from '../db.ts';
import type { LandlordPayout, RentPlan } from '../generated/prisma/client.ts';
import { ACCOUNTS, receivableCode } from '../ledger/accounts.ts';
import { postTransaction } from '../ledger/service.ts';
import { InsufficientCapitalError } from '../providers/capital/index.ts';
import { ACTIVE_SERVICING_POLICY, payoutAction, shouldHoldPayout } from '../servicing/policy.ts';
import { recordAudit, type AuditActor } from './audit.ts';
import { oldestUnpaidDueDate } from './delinquency.ts';

export type PayoutOutcome = 'paid' | 'failed' | 'held' | 'cancelled' | 'skipped';

const ACTOR: AuditActor = { type: 'job', id: 'process-payouts' };

/** Last date on which a payout scheduled for `scheduledFor` can still be paid, if there is one. */
export function releaseBy(scheduledFor: IsoDate): IsoDate | null {
  const window = ACTIVE_SERVICING_POLICY.payoutReleaseWindowDays;
  return window === null ? null : addDays(scheduledFor, window);
}

/**
 * Why a payout must not go out today, or null when nothing holds it. Checked in this order,
 * so the reason shown is the one the owner can do least about.
 */
export async function payoutHoldReason(
  tx: Tx,
  payout: Pick<LandlordPayout, 'id'>,
  plan: Pick<RentPlan, 'status' | 'advanceFrozenAt' | 'businessId'>,
  asOf: IsoDate,
): Promise<PayoutHoldReason | null> {
  if (plan.status === 'CLOSED') return 'PLAN_CLOSED';
  if (plan.advanceFrozenAt !== null) return 'ADVANCE_FROZEN';
  if (plan.status === 'PAUSED') return 'PLAN_PAUSED';
  const oldest = await oldestUnpaidDueDate(tx, plan.businessId, payout.id);
  if (shouldHoldPayout(ACTIVE_SERVICING_POLICY, oldest, asOf)) return 'PAST_DUE';
  return null;
}

/**
 * Cancel a payout that will never be paid and void its installments: nothing was fronted,
 * so nothing is owed. No ledger posting, because no money moved.
 */
export async function cancelPayout(
  tx: Tx,
  payout: Pick<LandlordPayout, 'id' | 'rentPlanId' | 'periodMonth' | 'amountCents' | 'heldReason'>,
  reason: PayoutHoldReason,
  asOf: IsoDate,
  actor: AuditActor,
): Promise<void> {
  const at = effectiveAt(asOf);
  await tx.landlordPayout.update({
    where: { id: payout.id },
    data: { status: 'CANCELLED', cancelledAt: at, heldReason: reason },
  });
  await tx.installment.updateMany({
    where: { payoutId: payout.id, status: { not: 'PAID' } },
    data: { status: 'VOIDED' },
  });
  await recordAudit(tx, {
    actor,
    eventType: 'PAYOUT_CANCELLED',
    subjectType: 'rent_plan',
    subjectId: payout.rentPlanId,
    payload: {
      payoutId: payout.id,
      periodMonth: payout.periodMonth,
      amountCents: payout.amountCents,
      reason,
      asOf,
    },
    severity: 'warning',
    at,
  });
}

/**
 * Decides what happens to one landlord payout today and does it.
 *
 * The servicing policy holds a payout while the business is past due on rent already
 * fronted. A frozen plan (periodic review, unauthorized return, returned payout) and a plan
 * the owner paused hold it too. A held payout is HELD, with the reason, where the owner can
 * see it. If the hold clears within the policy's release window the payout is paid, late by
 * however long it was held, and its installments move out by the same number of days. If it
 * does not, the payout is CANCELLED and its installments are voided: by then the business
 * has had to pay the landlord for that month itself.
 *
 * Paying reserves capital, calls the payments provider, and posts the ledger entry
 * (receivable up, capital pool down) in the same transaction as the status change. A payout
 * that fails for lack of capital or at the provider is FAILED and retried on the next run,
 * inside the same window. Safe to run again: a PAID or CANCELLED payout is skipped, and the
 * provider call is idempotent by key.
 */
export async function processPayout(
  ctx: AppContext,
  payoutId: string,
  asOf: IsoDate,
): Promise<PayoutOutcome> {
  const { db, providers } = ctx;
  const policy = ACTIVE_SERVICING_POLICY;
  const at = effectiveAt(asOf);
  return db.$transaction(async (tx) => {
    const payout = await tx.landlordPayout.findUnique({
      where: { id: payoutId },
      include: { rentPlan: { include: { lease: true, business: true } }, installments: true },
    });
    if (!payout) return 'skipped';
    if (payout.status === 'PAID' || payout.status === 'CANCELLED') return 'skipped';
    // Sent, and sent back by the landlord's bank. Not retried: see `reversePayout`.
    if (payout.returnCode !== null) return 'skipped';
    const plan = payout.rentPlan;

    const holdReason = await payoutHoldReason(tx, payout, plan, asOf);
    // A closed plan fronts nothing more, whatever the date.
    if (holdReason === 'PLAN_CLOSED') {
      await cancelPayout(tx, payout, holdReason, asOf, ACTOR);
      return 'cancelled';
    }
    const action = payoutAction(policy, payout.scheduledFor, holdReason !== null, asOf);
    if (action === 'wait') return 'skipped';

    if (action === 'cancel') {
      const reason =
        holdReason ?? (payout.heldReason as PayoutHoldReason | null) ?? 'NOT_PAID_IN_TIME';
      await cancelPayout(tx, payout, reason, asOf, ACTOR);
      ctx.log.warn({ payoutId: payout.id, reason }, 'landlord payout cancelled');
      return 'cancelled';
    }

    if (action === 'hold') {
      if (payout.status !== 'HELD' || payout.heldReason !== holdReason) {
        await tx.landlordPayout.update({
          where: { id: payout.id },
          data: {
            status: 'HELD',
            heldReason: holdReason,
            heldAt: payout.heldAt ?? at,
            failureReason: null,
          },
        });
        await recordAudit(tx, {
          actor: ACTOR,
          eventType: 'PAYOUT_HELD',
          subjectType: 'rent_plan',
          subjectId: plan.id,
          payload: {
            payoutId: payout.id,
            periodMonth: payout.periodMonth,
            amountCents: payout.amountCents,
            reason: holdReason,
            frozenReason: plan.advanceFrozenReason,
            releaseBy: releaseBy(payout.scheduledFor),
            asOf,
          },
          severity: 'warning',
          at,
        });
        ctx.log.warn({ payoutId: payout.id, reason: holdReason }, 'landlord payout held');
      }
      return 'held';
    }

    const fail = async (reason: string, returnCode?: string): Promise<PayoutOutcome> => {
      await tx.landlordPayout.update({
        where: { id: payout.id },
        // The hold reason is kept on a payout that was released and then failed, so that a
        // later cancellation can still say why it was late.
        data: { status: 'FAILED', failureReason: returnCode ? `${returnCode}: ${reason}` : reason },
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
      destinationToken: plan.lease.landlordPayoutToken,
      idempotencyKey: `payout:${payout.id}`,
      description: `Rent ${payout.periodMonth} for ${plan.business.legalName} to ${plan.lease.landlordName}`,
      effectiveDate: asOf,
    });
    if (!result.ok) return fail(result.failureReason, result.returnCode);

    await postTransaction(tx, {
      description: `Landlord payout ${payout.periodMonth}: ${plan.business.legalName}`,
      effectiveDate: asOf,
      referenceType: 'landlord_payout',
      referenceId: payout.id,
      idempotencyKey: `payout:${payout.id}`,
      entries: [
        {
          accountCode: receivableCode(plan.businessId),
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

    // Paid late (released from a hold, or funded a few days after a shortfall): the
    // installments keep their spacing and start from the day the landlord was paid, so the
    // business is never past due on rent that had not yet been fronted.
    const delayDays = daysBetween(payout.scheduledFor, asOf);
    if (delayDays > 0) {
      for (const installment of payout.installments) {
        await tx.installment.update({
          where: { id: installment.id },
          data: { dueDate: addDays(installment.dueDate, delayDays) },
        });
      }
    }

    const wasHeld = payout.heldAt !== null;
    await tx.landlordPayout.update({
      where: { id: payout.id },
      data: {
        status: 'PAID',
        paidAt: at,
        providerRef: result.providerRef,
        failureReason: null,
        heldReason: null,
      },
    });
    if (wasHeld) {
      await recordAudit(tx, {
        actor: ACTOR,
        eventType: 'PAYOUT_RELEASED',
        subjectType: 'rent_plan',
        subjectId: plan.id,
        payload: {
          payoutId: payout.id,
          periodMonth: payout.periodMonth,
          amountCents: payout.amountCents,
          heldReason: payout.heldReason,
          delayDays,
          asOf,
        },
        at,
      });
    }
    ctx.log.info({ payoutId: payout.id, amountCents: payout.amountCents }, 'landlord payout paid');
    return 'paid';
  });
}

import { addDays, daysBetween, type IsoDate, type PayoutHoldReason } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import type { Tx } from '../db.ts';
import type { LandlordPayout, RentPlan } from '../generated/prisma/client.ts';
import { ACCOUNTS, receivableCode } from '../ledger/accounts.ts';
import { postTransaction } from '../ledger/service.ts';
import { notFound, unprocessable } from '../errors.ts';
import { InsufficientCapitalError } from '../providers/capital/index.ts';
import { ACTIVE_SERVICING_POLICY, payoutAction, shouldHoldPayout } from '../servicing/policy.ts';
import { recordAudit, type AuditActor } from './audit.ts';
import { oldestUnpaidDueDate } from './delinquency.ts';
import {
  claimDisbursement,
  confirmDisbursement,
  isUniqueViolation,
  releaseDisbursement,
} from './disbursements.ts';
import { openHitsForPlan } from './identity.ts';

export type PayoutOutcome = 'paid' | 'failed' | 'held' | 'cancelled' | 'skipped';

const ACTOR: AuditActor = { type: 'job', id: 'process-payouts' };

/**
 * Idempotency key of the ledger posting and the provider call for a payout as it stands.
 * The first send is `payout:<id>`. A payout that came back and was sent again by a reviewer
 * has a key per send, so the second send is a second posting and a second return of it
 * reverses the right one.
 */
export function payoutKey(payout: Pick<LandlordPayout, 'id' | 'resendCount'>): string {
  return payout.resendCount === 0
    ? `payout:${payout.id}`
    : `payout:${payout.id}:resend:${payout.resendCount}`;
}

/**
 * What the owner is told about a hold. Plain, and no more than they need: every freeze,
 * whatever caused it, reads as an account under review.
 */
export const HOLD_MESSAGES: Record<PayoutHoldReason, string> = {
  PAST_DUE:
    'An earlier installment is past due. This rent payment goes out once it has been paid, if that is within a few days.',
  ADVANCE_FROZEN:
    'Your account is under review, so this rent payment is on hold. Contact support and we will help.',
  PLAN_PAUSED: 'You paused rent splitting. Resume the plan to send this payment.',
  PLAN_CLOSED: 'This plan is closed, so this rent payment was not sent.',
  NOT_PAID_IN_TIME: 'We could not send this rent payment in time. Contact support.',
  LEASE_CHANGE_PENDING:
    "Your landlord's details were changed recently. For your security, rent payments wait until the change takes effect.",
  RENT_INCREASE_PENDING:
    'Your rent went up past the amount you are approved for. Apply for the new amount to resume rent payments.',
  PERIOD_ALREADY_PAID:
    'Your landlord was already paid for this month, so this payment was not sent again.',
};

/**
 * Lock a payout row for the rest of the transaction. Two runs of the payout job, or a
 * release and a run, that reach the same payout at once are serialized here: the second
 * reads the payout as the first left it.
 */
export async function lockPayout(tx: Tx, payoutId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "LandlordPayout" WHERE "id" = ${payoutId} FOR UPDATE`;
}

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
  plan: Pick<
    RentPlan,
    'status' | 'advanceFrozenAt' | 'businessId' | 'leaseId' | 'pendingRentCents'
  >,
  asOf: IsoDate,
): Promise<PayoutHoldReason | null> {
  if (plan.status === 'CLOSED') return 'PLAN_CLOSED';
  if (plan.advanceFrozenAt !== null) return 'ADVANCE_FROZEN';
  // A change to who the lease pays is inside its cooling-off period: nothing goes to the
  // old account or the new one until it has applied, been cancelled, or been rejected.
  const pendingChange = await tx.leaseChange.findFirst({
    where: { leaseId: plan.leaseId, status: 'PENDING' },
    select: { id: true },
  });
  if (pendingChange) return 'LEASE_CHANGE_PENDING';
  // The rent went up past the approval. A whole month's rent is fronted or nothing is.
  if (plan.pendingRentCents !== null) return 'RENT_INCREASE_PENDING';
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
  const policy = ACTIVE_SERVICING_POLICY;
  const at = effectiveAt(asOf);
  try {
    return await processPayoutTx(ctx, payoutId, asOf, policy, at);
  } catch (err) {
    // Another transaction claimed this lease and month first (see `disbursements.ts`).
    // Nothing was sent by this one: its transaction rolled back before the provider call.
    if (isUniqueViolation(err)) {
      ctx.log.warn({ payoutId }, 'landlord payout skipped: the month was claimed concurrently');
      return 'skipped';
    }
    throw err;
  }
}

async function processPayoutTx(
  ctx: AppContext,
  payoutId: string,
  asOf: IsoDate,
  policy: typeof ACTIVE_SERVICING_POLICY,
  at: Date,
): Promise<PayoutOutcome> {
  const { db, providers } = ctx;
  return db.$transaction(async (tx) => {
    await lockPayout(tx, payoutId);
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

    // One landlord payment per lease and month, whichever plan makes it. Claimed before the
    // provider is called, so a month already paid is never sent again.
    const claim = await claimDisbursement(tx, {
      leaseId: plan.leaseId,
      periodMonth: payout.periodMonth,
      rentPlanId: plan.id,
      kind: 'FINANCED',
      sourceId: payout.id,
      idempotencyKey: payoutKey(payout),
      amountCents: payout.amountCents,
      effectiveDate: asOf,
    });
    if (!claim.ok) {
      await cancelPayout(tx, payout, 'PERIOD_ALREADY_PAID', asOf, ACTOR);
      await recordAudit(tx, {
        actor: ACTOR,
        eventType: 'DUPLICATE_PAYOUT_PREVENTED',
        subjectType: 'rent_plan',
        subjectId: plan.id,
        payload: {
          payoutId: payout.id,
          leaseId: plan.leaseId,
          periodMonth: payout.periodMonth,
          amountCents: payout.amountCents,
          alreadyPaidBy: claim.existing,
          asOf,
        },
        severity: 'high',
        at,
      });
      ctx.log.error(
        { payoutId: payout.id, existing: claim.existing },
        'landlord payout refused: this month was already paid',
      );
      return 'cancelled';
    }

    const result = await providers.payments.payout({
      amountCents: payout.amountCents,
      destinationToken: plan.lease.landlordPayoutToken,
      idempotencyKey: payoutKey(payout),
      description: `Rent ${payout.periodMonth} for ${plan.business.legalName} to ${plan.lease.landlordName}`,
      effectiveDate: asOf,
    });
    if (!result.ok) {
      await releaseDisbursement(tx, claim.id);
      return fail(result.failureReason, result.returnCode);
    }
    await confirmDisbursement(tx, claim.id, result.providerRef);

    await postTransaction(tx, {
      description: `Landlord payout ${payout.periodMonth}: ${plan.business.legalName}`,
      effectiveDate: asOf,
      referenceType: 'landlord_payout',
      referenceId: payout.id,
      idempotencyKey: payoutKey(payout),
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

/**
 * Send a landlord payout again after it came back.
 *
 * A returned payout is FAILED with the bank's code and is never retried by the job: the same
 * account would send it back again. Once the landlord's details have been corrected through
 * lease change control (a change that applied after the return, with nothing still pending)
 * a reviewer can send it again. In one database transaction: capital is reserved, the
 * provider is called with a new idempotency key, the receivable is posted again, the
 * installments that were voided by the return are owed again, moved out by the delay, and
 * the payout is PAID. Installments collected before the return stay paid; the credit the
 * return left on the receivable is used up by the new posting.
 *
 * The freeze the return put on the plan is not lifted here. That is a separate reviewer
 * action (`releaseAdvanceFreeze`), so the next month does not start on its own.
 */
export async function resendReturnedPayout(
  ctx: AppContext,
  args: {
    payoutId: string;
    identity: { role: 'reviewer' | 'admin'; actor: string };
    reason: string;
    asOf: IsoDate;
  },
): Promise<LandlordPayout> {
  const { db, providers } = ctx;
  const at = effectiveAt(args.asOf);
  const actor: AuditActor = { type: args.identity.role, id: args.identity.actor };
  return db.$transaction(async (tx) => {
    const payout = await tx.landlordPayout.findUnique({
      where: { id: args.payoutId },
      include: { rentPlan: { include: { lease: true, business: true } }, installments: true },
    });
    if (!payout) throw notFound('Payout');
    if (payout.status !== 'FAILED' || payout.returnCode === null) {
      throw unprocessable(
        'PAYOUT_NOT_RETURNED',
        'Only a payout that was sent and came back from the bank can be sent again',
      );
    }
    const plan = payout.rentPlan;
    if (plan.status === 'CLOSED') throw unprocessable('PLAN_CLOSED', 'This plan is closed');
    const pending = await tx.leaseChange.findFirst({
      where: { leaseId: plan.leaseId, status: 'PENDING' },
    });
    if (pending) {
      throw unprocessable(
        'LEASE_CHANGE_PENDING',
        'A change to the landlord details is still inside its cooling-off period',
        { leaseChangeId: pending.id, effectiveOn: pending.effectiveOn },
      );
    }
    const returned = await tx.auditEvent.findFirst({
      where: {
        eventType: 'PAYOUT_RETURNED',
        subjectType: 'rent_plan',
        subjectId: plan.id,
        payload: { path: ['payoutId'], equals: payout.id },
      },
      orderBy: { at: 'desc' },
    });
    const corrected = await tx.leaseChange.findFirst({
      where: {
        leaseId: plan.leaseId,
        status: 'APPLIED',
        fields: { has: 'landlordPayout' },
        ...(returned ? { appliedAt: { gte: returned.at } } : {}),
      },
      orderBy: { appliedAt: 'desc' },
    });
    if (!corrected) {
      throw unprocessable(
        'LANDLORD_DETAILS_NOT_CORRECTED',
        'The landlord payout details have not changed since this payout came back. The owner has to correct them, and the change has to clear its cooling-off period, first',
      );
    }
    const hits = await openHitsForPlan(tx, plan);
    if (hits.length > 0) {
      throw unprocessable('SCREENING_HIT_OPEN', 'A screening hit on this plan is still open');
    }
    const oldest = await oldestUnpaidDueDate(tx, plan.businessId, payout.id);
    if (shouldHoldPayout(ACTIVE_SERVICING_POLICY, oldest, args.asOf)) {
      throw unprocessable('PAST_DUE', 'The business is past due on rent already fronted');
    }

    const next = { id: payout.id, resendCount: payout.resendCount + 1 };
    const key = payoutKey(next);
    try {
      await providers.capital.reserve(tx, payout.amountCents, key);
    } catch (err) {
      if (err instanceof InsufficientCapitalError) {
        throw unprocessable('FUNDING_UNAVAILABLE', err.message);
      }
      throw err;
    }
    const claim = await claimDisbursement(tx, {
      leaseId: plan.leaseId,
      periodMonth: payout.periodMonth,
      rentPlanId: plan.id,
      kind: 'FINANCED',
      sourceId: payout.id,
      idempotencyKey: key,
      amountCents: payout.amountCents,
      effectiveDate: args.asOf,
    });
    if (!claim.ok) {
      throw unprocessable(
        'PERIOD_ALREADY_PAID',
        'The landlord has already been paid for this month',
        { existing: claim.existing },
      );
    }
    const result = await providers.payments.payout({
      amountCents: payout.amountCents,
      destinationToken: plan.lease.landlordPayoutToken,
      idempotencyKey: key,
      description: `Rent ${payout.periodMonth} for ${plan.business.legalName} to ${plan.lease.landlordName} (sent again)`,
      effectiveDate: args.asOf,
    });
    if (!result.ok) {
      throw unprocessable('PAYOUT_FAILED', result.failureReason, {
        returnCode: result.returnCode ?? null,
      });
    }
    await confirmDisbursement(tx, claim.id, result.providerRef);
    await postTransaction(tx, {
      description: `Landlord payout ${payout.periodMonth} sent again: ${plan.business.legalName}`,
      effectiveDate: args.asOf,
      referenceType: 'landlord_payout',
      referenceId: payout.id,
      idempotencyKey: key,
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
    // Owed again, on the original spacing, and none of them due before today.
    const voided = payout.installments.filter((i) => i.status === 'VOIDED');
    const firstDue = voided.reduce<IsoDate | null>(
      (min, i) => (min === null || i.dueDate < min ? i.dueDate : min),
      null,
    );
    const shift = firstDue === null ? 0 : Math.max(0, daysBetween(firstDue, args.asOf));
    for (const installment of voided) {
      await tx.installment.update({
        where: { id: installment.id },
        data: {
          status: 'SCHEDULED',
          dueDate: addDays(installment.dueDate, shift),
          attemptCount: 0,
          lastAttemptOn: null,
          attemptBankLinkId: null,
        },
      });
    }
    const updated = await tx.landlordPayout.update({
      where: { id: payout.id },
      data: {
        status: 'PAID',
        paidAt: at,
        providerRef: result.providerRef,
        failureReason: null,
        returnCode: null,
        resendCount: next.resendCount,
      },
    });
    await recordAudit(tx, {
      actor,
      eventType: 'PAYOUT_RESENT',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        payoutId: payout.id,
        periodMonth: payout.periodMonth,
        amountCents: payout.amountCents,
        previousReturnCode: payout.returnCode,
        leaseChangeId: corrected.id,
        resendCount: next.resendCount,
        installmentsRestored: voided.length,
        reason: args.reason,
        asOf: args.asOf,
      },
      severity: 'warning',
      at,
    });
    ctx.log.info({ payoutId: payout.id }, 'returned landlord payout sent again');
    return updated;
  });
}

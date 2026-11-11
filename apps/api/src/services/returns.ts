import { addDays, type IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import type { Tx } from '../db.ts';
import { reverseTransaction } from '../ledger/service.ts';
import type { PaymentReturn } from '../providers/payments/index.ts';
import {
  ACTIVE_SERVICING_POLICY,
  classifyReturnCode,
  isLate,
  returnCodeReason,
  type ReturnClass,
} from '../servicing/policy.ts';
import { recordAudit, type AuditActor } from './audit.ts';
import { refreshDelinquency, UNPAID } from './delinquency.ts';

/**
 * Payment returns.
 *
 * A bank debit is booked when it is made and can come back later: two banking days for
 * insufficient funds, up to sixty calendar days for an unauthorized debit. There are no
 * webhooks, so the `reconcile-payments` job polls the payments provider for returns and
 * undoes each one here, in one database transaction per return: the repayment is marked
 * RETURNED, the installment is unpaid again, and a reversing ledger transaction is posted.
 * Ledger rows are append-only, so the original posting stays and its mirror image is added.
 */

/**
 * How far back each poll looks. An unauthorized return can arrive sixty days after
 * settlement; the extra days cover a job that did not run for a while. Polling the same
 * window twice is harmless: a return that was already handled is skipped.
 */
export const RETURN_LOOKBACK_DAYS = 75;

export type ReturnOutcome = 'reversed' | 'already_handled' | 'unknown';

interface ReturnTarget {
  planId: string;
  businessId: string;
  bankLinkId: string | null;
}

/**
 * What a return code means for the plan, beyond undoing the payment. Also applied when the
 * rail rejects a debit on the spot with a code.
 *
 *   RETRYABLE     nothing more: the attempt has been counted and the retry schedule decides.
 *   HARD          the bank link is disabled, so no further automatic debit is made until the
 *                 business links an account again.
 *   UNAUTHORIZED  the same, and the plan is frozen from further advances, and a high
 *                 severity event is written for monitoring to alert on.
 */
export async function applyReturnConsequences(
  tx: Tx,
  target: ReturnTarget,
  returnCode: string,
  asOf: IsoDate,
  actor: AuditActor,
  context: Record<string, unknown>,
): Promise<ReturnClass> {
  const returnClass = classifyReturnCode(returnCode);
  if (returnClass === 'RETRYABLE') return returnClass;
  const at = effectiveAt(asOf);

  if (target.bankLinkId) {
    const link = await tx.bankLink.findUnique({ where: { id: target.bankLinkId } });
    if (link && link.status === 'LINKED') {
      await tx.bankLink.update({ where: { id: link.id }, data: { status: 'ERROR' } });
      await recordAudit(tx, {
        actor,
        eventType: 'BANK_LINK_DISABLED',
        subjectType: 'rent_plan',
        subjectId: target.planId,
        payload: { bankLinkId: link.id, businessId: target.businessId, returnCode, returnClass },
        severity: 'warning',
        at,
      });
    }
  }

  if (returnClass === 'UNAUTHORIZED') {
    const plan = await tx.rentPlan.findUniqueOrThrow({ where: { id: target.planId } });
    if (plan.advanceFrozenAt === null) {
      await tx.rentPlan.update({
        where: { id: plan.id },
        data: { advanceFrozenAt: at, advanceFrozenReason: 'UNAUTHORIZED_RETURN' },
      });
      await recordAudit(tx, {
        actor,
        eventType: 'PLAN_ADVANCE_FROZEN',
        subjectType: 'rent_plan',
        subjectId: plan.id,
        payload: { reason: 'UNAUTHORIZED_RETURN', returnCode },
        at,
      });
    }
    await recordAudit(tx, {
      actor,
      eventType: 'UNAUTHORIZED_RETURN',
      subjectType: 'rent_plan',
      subjectId: target.planId,
      payload: {
        businessId: target.businessId,
        bankLinkId: target.bankLinkId,
        returnCode,
        reason: returnCodeReason(returnCode),
        ...context,
      },
      severity: 'high',
      at,
    });
  }
  return returnClass;
}

const ACTOR: AuditActor = { type: 'job', id: 'reconcile-payments' };

/** Undo a collected installment that the business's bank sent back. */
async function reverseRepayment(
  ctx: AppContext,
  ret: PaymentReturn,
  asOf: IsoDate,
): Promise<ReturnOutcome> {
  return ctx.db.$transaction(async (tx) => {
    const repayment = await tx.repayment.findFirst({
      where: { providerRef: ret.providerRef, provider: ctx.providers.payments.name },
      include: { installment: { include: { rentPlan: true } } },
    });
    if (!repayment) return 'unknown';
    if (repayment.status !== 'SUCCEEDED') return 'already_handled';
    const { installment } = repayment;
    const plan = installment.rentPlan;
    const policy = ACTIVE_SERVICING_POLICY;

    await tx.repayment.update({
      where: { id: repayment.id },
      data: {
        status: 'RETURNED',
        returnCode: ret.returnCode,
        returnedAt: effectiveAt(ret.returnedOn),
        failureReason: `Returned by the bank: ${ret.returnCode} ${ret.reason}`,
      },
    });
    await reverseTransaction(tx, `repayment:${repayment.id}`, {
      description: `Return ${ret.returnCode}: installment ${installment.sequence} for ${installment.periodMonth}`,
      effectiveDate: ret.returnedOn,
      referenceType: 'repayment_return',
      referenceId: repayment.id,
      idempotencyKey: `repayment:${repayment.id}:return`,
    });
    // Unpaid again. A recovery that bounced goes back to written off.
    await tx.installment.update({
      where: { id: installment.id },
      data: {
        status: repayment.recovery
          ? 'CHARGED_OFF'
          : isLate(policy, installment.dueDate, asOf)
            ? 'LATE'
            : 'FAILED',
        paidAt: null,
      },
    });
    await recordAudit(tx, {
      actor: ACTOR,
      eventType: 'PAYMENT_RETURNED',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        repaymentId: repayment.id,
        installmentId: installment.id,
        amountCents: repayment.amountCents,
        returnCode: ret.returnCode,
        returnClass: classifyReturnCode(ret.returnCode),
        reason: ret.reason,
        returnedOn: ret.returnedOn,
        recovery: repayment.recovery,
      },
      severity: 'warning',
      at: effectiveAt(asOf),
    });
    await applyReturnConsequences(
      tx,
      { planId: plan.id, businessId: plan.businessId, bankLinkId: repayment.bankLinkId },
      ret.returnCode,
      asOf,
      ACTOR,
      { repaymentId: repayment.id, installmentId: installment.id, returnedOn: ret.returnedOn },
    );
    await refreshDelinquency(tx, plan.id, asOf, ACTOR);
    ctx.log.warn(
      { repaymentId: repayment.id, returnCode: ret.returnCode },
      'collected installment returned',
    );
    return 'reversed';
  });
}

/**
 * Undo a landlord payout that the landlord's bank sent back (a closed or wrong account).
 * The pool gets its money back and the receivable is taken off: the rent was never
 * delivered, so the business does not owe it. Installments not yet collected are voided. Any
 * already collected leave a credit on the receivable account, which the audit event reports
 * so that it can be refunded. The payout is FAILED with the code and is not retried: the
 * same account would send it back again. The plan is frozen until a reviewer has corrected
 * the landlord's details and released it.
 */
async function reversePayout(
  ctx: AppContext,
  ret: PaymentReturn,
  asOf: IsoDate,
): Promise<ReturnOutcome> {
  return ctx.db.$transaction(async (tx) => {
    const payout = await tx.landlordPayout.findFirst({
      where: { providerRef: ret.providerRef },
      include: { rentPlan: true, installments: true },
    });
    if (!payout) return 'unknown';
    if (payout.status !== 'PAID') return 'already_handled';
    const plan = payout.rentPlan;
    const at = effectiveAt(asOf);

    await reverseTransaction(tx, `payout:${payout.id}`, {
      description: `Return ${ret.returnCode}: landlord payout ${payout.periodMonth}`,
      effectiveDate: ret.returnedOn,
      referenceType: 'landlord_payout_return',
      referenceId: payout.id,
      idempotencyKey: `payout:${payout.id}:return`,
    });
    await tx.landlordPayout.update({
      where: { id: payout.id },
      data: {
        status: 'FAILED',
        returnCode: ret.returnCode,
        failureReason: `Returned by the landlord's bank: ${ret.returnCode} ${ret.reason}`,
        paidAt: null,
      },
    });
    await tx.installment.updateMany({
      where: { payoutId: payout.id, status: { in: UNPAID } },
      data: { status: 'VOIDED' },
    });
    const customerCreditCents = payout.installments
      .filter((i) => i.status === 'PAID')
      .reduce((sum, i) => sum + i.principalCents, 0);

    if (plan.advanceFrozenAt === null) {
      await tx.rentPlan.update({
        where: { id: plan.id },
        data: { advanceFrozenAt: at, advanceFrozenReason: 'PAYOUT_RETURNED' },
      });
      await recordAudit(tx, {
        actor: ACTOR,
        eventType: 'PLAN_ADVANCE_FROZEN',
        subjectType: 'rent_plan',
        subjectId: plan.id,
        payload: { reason: 'PAYOUT_RETURNED', returnCode: ret.returnCode, payoutId: payout.id },
        at,
      });
    }
    await recordAudit(tx, {
      actor: ACTOR,
      eventType: 'PAYOUT_RETURNED',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        payoutId: payout.id,
        periodMonth: payout.periodMonth,
        amountCents: payout.amountCents,
        returnCode: ret.returnCode,
        returnClass: classifyReturnCode(ret.returnCode),
        reason: ret.reason,
        returnedOn: ret.returnedOn,
        // Principal already collected for rent that was never delivered. Owed back.
        customerCreditCents,
      },
      severity: 'high',
      at,
    });
    await refreshDelinquency(tx, plan.id, asOf, ACTOR);
    ctx.log.warn({ payoutId: payout.id, returnCode: ret.returnCode }, 'landlord payout returned');
    return 'reversed';
  });
}

/** Poll the payments provider for returns up to `asOf` and undo each one not yet handled. */
export async function reconcileReturns(ctx: AppContext, asOf: IsoDate) {
  const returns = await ctx.providers.payments.listReturns({
    from: addDays(asOf, -RETURN_LOOKBACK_DAYS),
    to: asOf,
  });
  const counts = {
    returnsSeen: returns.length,
    repaymentsReversed: 0,
    payoutsReversed: 0,
    alreadyHandled: 0,
    unknown: 0,
  };
  for (const ret of returns) {
    const outcome =
      ret.kind === 'charge'
        ? await reverseRepayment(ctx, ret, asOf)
        : await reversePayout(ctx, ret, asOf);
    if (outcome === 'reversed') {
      if (ret.kind === 'charge') counts.repaymentsReversed += 1;
      else counts.payoutsReversed += 1;
    } else if (outcome === 'already_handled') counts.alreadyHandled += 1;
    else {
      counts.unknown += 1;
      ctx.log.warn({ providerRef: ret.providerRef, kind: ret.kind }, 'return for unknown payment');
    }
  }
  return counts;
}

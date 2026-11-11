import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import { ACCOUNTS, receivableCode } from '../ledger/accounts.ts';
import { allowanceBalance, postTransaction } from '../ledger/service.ts';
import { recordAudit, type AuditActor } from './audit.ts';
import { UNPAID } from './delinquency.ts';
import { cancelPayout } from './payouts.ts';

const ACTOR: AuditActor = { type: 'job', id: 'age-receivables' };

export interface ChargeOffResult {
  chargedOffCents: number;
  installments: number;
}

/**
 * Write off everything a plan still owes on rent paid to its landlord, and close the plan.
 *
 * The whole unpaid balance goes at once, not installment by installment: once the oldest
 * installment has reached the write off age nobody expects the younger ones to be paid on
 * schedule. In one database transaction:
 *
 *   - DR allowance for credit losses / CR the business's receivable, for the unpaid
 *     principal. If the allowance is short of that, it is topped up first with
 *     DR provision expense / CR allowance, so the allowance never goes below zero.
 *   - Unpaid fees are not posted anywhere. A fee is revenue only when it is collected, so an
 *     uncollected fee was never income and is not a loss.
 *   - The installments become CHARGED_OFF. They are still owed: a later payment is booked
 *     as a recovery by `collectInstallment`.
 *   - Payouts not yet made are cancelled and their installments voided.
 *   - The plan is CLOSED and its bucket is CHARGED_OFF, for good.
 *   - The business is SUSPENDED and its other open plans are frozen, so it gets no further
 *     advances on any lease.
 *
 * Also called for a plan that is already written off when a payment made before the write
 * off is returned afterwards: the installment that reopens is written off too. Idempotent:
 * with nothing unpaid it does nothing.
 */
export async function chargeOffPlan(
  ctx: AppContext,
  planId: string,
  asOf: IsoDate,
): Promise<ChargeOffResult> {
  const at = effectiveAt(asOf);
  return ctx.db.$transaction(async (tx) => {
    const plan = await tx.rentPlan.findUniqueOrThrow({
      where: { id: planId },
      include: { business: true },
    });
    const unpaid = await tx.installment.findMany({
      where: { rentPlanId: planId, status: { in: UNPAID }, payout: { status: 'PAID' } },
      orderBy: { dueDate: 'asc' },
    });
    const alreadyChargedOff = plan.delinquencyStatus === 'CHARGED_OFF';
    if (unpaid.length === 0 && alreadyChargedOff) return { chargedOffCents: 0, installments: 0 };

    const principalCents = unpaid.reduce((sum, i) => sum + i.principalCents, 0);
    const unpaidFeeCents = unpaid.reduce((sum, i) => sum + i.feeCents, 0);
    // One key per plan per day: a second write off on the same plan (see above) is a new
    // posting, and a second run on the same day is not.
    const key = `charge_off:${planId}:${asOf}`;
    if (principalCents > 0) {
      const allowance = await allowanceBalance(tx);
      if (allowance < principalCents) {
        await postTransaction(tx, {
          description: `Provision for charge-off: ${plan.business.legalName}`,
          effectiveDate: asOf,
          referenceType: 'provision',
          referenceId: planId,
          idempotencyKey: `${key}:provision`,
          entries: [
            {
              accountCode: ACCOUNTS.PROVISION_EXPENSE,
              direction: 'DEBIT',
              amountCents: principalCents - allowance,
            },
            {
              accountCode: ACCOUNTS.ALLOWANCE,
              direction: 'CREDIT',
              amountCents: principalCents - allowance,
            },
          ],
        });
      }
      await postTransaction(tx, {
        description: `Charge-off: ${plan.business.legalName}`,
        effectiveDate: asOf,
        referenceType: 'charge_off',
        referenceId: planId,
        idempotencyKey: key,
        entries: [
          { accountCode: ACCOUNTS.ALLOWANCE, direction: 'DEBIT', amountCents: principalCents },
          {
            accountCode: receivableCode(plan.businessId),
            direction: 'CREDIT',
            amountCents: principalCents,
          },
        ],
      });
    }
    await tx.installment.updateMany({
      where: { id: { in: unpaid.map((i) => i.id) } },
      data: { status: 'CHARGED_OFF', chargedOffAt: at },
    });

    const pending = await tx.landlordPayout.findMany({
      where: {
        rentPlanId: planId,
        status: { in: ['SCHEDULED', 'HELD', 'FAILED'] },
        returnCode: null,
      },
    });
    for (const payout of pending) await cancelPayout(tx, payout, 'PLAN_CLOSED', asOf, ACTOR);

    await tx.rentPlan.update({
      where: { id: planId },
      data: {
        status: 'CLOSED',
        delinquencyStatus: 'CHARGED_OFF',
        closedAt: plan.closedAt ?? at,
        closedReason: plan.closedReason ?? 'CHARGED_OFF',
      },
    });
    await recordAudit(tx, {
      actor: ACTOR,
      eventType: 'PLAN_CHARGED_OFF',
      subjectType: 'rent_plan',
      subjectId: planId,
      payload: {
        businessId: plan.businessId,
        principalCents,
        unpaidFeeCents,
        installments: unpaid.length,
        oldestDueDate: unpaid[0]?.dueDate ?? null,
        cancelledPayouts: pending.length,
        asOf,
      },
      severity: 'high',
      at,
    });
    if (!alreadyChargedOff) {
      await recordAudit(tx, {
        actor: ACTOR,
        eventType: 'DELINQUENCY_CHANGED',
        subjectType: 'rent_plan',
        subjectId: planId,
        payload: { from: plan.delinquencyStatus, to: 'CHARGED_OFF', asOf },
        severity: 'high',
        at,
      });
    }
    if (plan.status !== 'CLOSED') {
      await recordAudit(tx, {
        actor: ACTOR,
        eventType: 'PLAN_STATUS_CHANGED',
        subjectType: 'rent_plan',
        subjectId: planId,
        payload: { from: plan.status, to: 'CLOSED', reason: 'CHARGED_OFF' },
        at,
      });
    }

    if (plan.business.status !== 'SUSPENDED') {
      await tx.business.update({ where: { id: plan.businessId }, data: { status: 'SUSPENDED' } });
      await recordAudit(tx, {
        actor: ACTOR,
        eventType: 'BUSINESS_STATUS_CHANGED',
        subjectType: 'business',
        subjectId: plan.businessId,
        payload: { from: plan.business.status, to: 'SUSPENDED', reason: 'CHARGED_OFF', planId },
        severity: 'warning',
        at,
      });
    }
    const siblings = await tx.rentPlan.findMany({
      where: {
        businessId: plan.businessId,
        id: { not: planId },
        status: { not: 'CLOSED' },
        advanceFrozenAt: null,
      },
      select: { id: true },
    });
    for (const sibling of siblings) {
      await tx.rentPlan.update({
        where: { id: sibling.id },
        data: { advanceFrozenAt: at, advanceFrozenReason: 'BUSINESS_CHARGED_OFF' },
      });
      await recordAudit(tx, {
        actor: ACTOR,
        eventType: 'PLAN_ADVANCE_FROZEN',
        subjectType: 'rent_plan',
        subjectId: sibling.id,
        payload: { reason: 'BUSINESS_CHARGED_OFF', chargedOffPlanId: planId },
        at,
      });
    }

    ctx.log.warn({ planId, principalCents, installments: unpaid.length }, 'rent plan charged off');
    return { chargedOffCents: principalCents, installments: unpaid.length };
  });
}

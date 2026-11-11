import type { IsoDate } from '@cashflow/shared';

import type { AppContext } from '../context.ts';
import { effectiveAt } from '../dates.ts';
import { ACCOUNTS, receivableCode } from '../ledger/accounts.ts';
import { accountBalance, postTransaction } from '../ledger/service.ts';
import type { EntryInput } from '../ledger/validate.ts';
import {
  ACTIVE_SERVICING_POLICY,
  attemptsExhausted,
  balanceCoversDebit,
  isLate,
  shouldAttemptCollection,
} from '../servicing/policy.ts';
import { recordAudit, type AuditActor } from './audit.ts';
import { refreshDelinquency } from './delinquency.ts';
import { applyReturnConsequences } from './returns.ts';

export type CollectionOutcome =
  /** Collected. */
  | 'paid'
  /** The debit was presented and failed. Inside the grace period. */
  | 'failed'
  /** The debit was presented and failed, and the installment is past grace. */
  | 'late'
  /** A debit was due but was put off: the balance cannot cover it, or there is no bank link. */
  | 'deferred'
  /** Nothing to do today: paid, voided, not due, landlord unpaid, or no attempt scheduled. */
  | 'skipped';

export interface CollectOptions {
  /**
   * The owner asked for this payment (`POST /v1/repayments`). A manual payment may be early,
   * ignores the retry schedule and cap and the balance check, and may pay an installment
   * that was written off, which is booked as a recovery.
   */
  manual?: boolean;
}

/**
 * Collects one installment from the business's linked bank account.
 *
 * The servicing policy decides whether an automatic debit is made today: the first on the
 * due date, then retries on the policy's schedule up to its cap. Before a scheduled debit
 * the balance is read from the bank link; when it cannot cover the installment the debit is
 * put off to the next run and does not count as an attempt. After the cap nothing is debited
 * automatically and the installment waits for a manual payment.
 *
 * A collected installment posts cash up, the receivable down by the principal, and the fee
 * to revenue. A payment on a written off installment is a recovery: cash up, recovery income
 * for the principal, the fee to revenue. Every attempt is a Repayment row dated on `asOf`.
 * The status change, the ledger posting, and the plan's delinquency bucket commit together.
 *
 * Paused and closed plans are collected like any other: pausing stops new rent periods, not
 * repayment of rent already paid to the landlord.
 */
export async function collectInstallment(
  ctx: AppContext,
  installmentId: string,
  asOf: IsoDate,
  options: CollectOptions = {},
): Promise<CollectionOutcome> {
  const { db, providers } = ctx;
  const policy = ACTIVE_SERVICING_POLICY;
  const manual = options.manual === true;
  const actor: AuditActor = manual
    ? { type: 'system', id: 'manual-payment' }
    : { type: 'job', id: 'collect-installments' };
  const at = effectiveAt(asOf);

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
      },
    });
    if (!installment) return 'skipped';
    if (installment.status === 'PAID' || installment.status === 'VOIDED') return 'skipped';
    // Never collect from a business before its landlord has been paid.
    if (installment.payout.status !== 'PAID') return 'skipped';
    const chargedOff = installment.status === 'CHARGED_OFF';
    const plan = installment.rentPlan;
    const bankLink = plan.business.bankLinks[0] ?? null;
    // Attempts are counted per bank account. A newly linked account starts from zero.
    const attempts =
      bankLink && installment.attemptBankLinkId === bankLink.id ? installment.attemptCount : 0;

    if (!manual) {
      // A written off balance is never debited automatically.
      if (chargedOff) return 'skipped';
      const due = shouldAttemptCollection(
        policy,
        { dueDate: installment.dueDate, attempts, lastAttemptDate: installment.lastAttemptOn },
        asOf,
      );
      if (!due) return 'skipped';
    }

    /** Put a scheduled debit off without using an attempt, and say why. */
    const defer = async (reason: string): Promise<CollectionOutcome> => {
      if (installment.collectionSkipReason !== reason) {
        await recordAudit(tx, {
          actor,
          eventType: 'COLLECTION_SKIPPED',
          subjectType: 'rent_plan',
          subjectId: plan.id,
          payload: { installmentId: installment.id, reason, asOf },
          at,
        });
      }
      await tx.installment.update({
        where: { id: installment.id },
        data: { collectionSkipReason: reason, collectionSkippedOn: asOf },
      });
      return 'deferred';
    };

    const late = isLate(policy, installment.dueDate, asOf);
    const fail = async (
      reason: string,
      providerRef: string | null,
      returnCode: string | null,
    ): Promise<CollectionOutcome> => {
      await tx.repayment.create({
        data: {
          installmentId: installment.id,
          amountCents: installment.totalCents,
          provider: providers.payments.name,
          providerRef,
          status: 'FAILED',
          failureReason: reason,
          bankLinkId: bankLink?.id ?? null,
          returnCode,
          manual,
          recovery: chargedOff,
          createdAt: at,
        },
      });
      const attemptCount = bankLink ? attempts + 1 : attempts;
      await tx.installment.update({
        where: { id: installment.id },
        data: {
          status: chargedOff ? 'CHARGED_OFF' : late ? 'LATE' : 'FAILED',
          ...(bankLink
            ? {
                attemptCount,
                lastAttemptOn: asOf,
                attemptBankLinkId: bankLink.id,
                collectionSkipReason: null,
                collectionSkippedOn: null,
              }
            : {}),
        },
      });
      if (
        bankLink &&
        attemptsExhausted(policy, attemptCount) &&
        !attemptsExhausted(policy, attempts)
      ) {
        await recordAudit(tx, {
          actor,
          eventType: 'COLLECTION_ATTEMPTS_EXHAUSTED',
          subjectType: 'rent_plan',
          subjectId: plan.id,
          payload: { installmentId: installment.id, attempts: attemptCount, asOf },
          severity: 'warning',
          at,
        });
      }
      if (returnCode) {
        await applyReturnConsequences(
          tx,
          { planId: plan.id, businessId: plan.businessId, bankLinkId: bankLink?.id ?? null },
          returnCode,
          asOf,
          actor,
          { installmentId: installment.id },
        );
      }
      await refreshDelinquency(tx, plan.id, asOf, actor);
      ctx.log.warn(
        { installmentId: installment.id, reason, attempt: attemptCount },
        'installment collection failed',
      );
      return late ? 'late' : 'failed';
    };

    if (!bankLink) {
      // Nothing to present the debit to. A manual payment fails and says so; the job waits
      // for the business to link an account, without using up attempts.
      const reason = 'No linked bank account to collect from';
      return manual ? fail(reason, null, null) : defer('NO_BANK_LINK');
    }

    if (!manual && policy.retry.balancePreCheck) {
      let balance: number | null = null;
      try {
        balance = await providers.bankLink.refreshBalance(bankLink.providerItemId);
      } catch (err) {
        // No reading is not a reason to hold a debit back.
        ctx.log.warn({ bankLinkId: bankLink.id, err }, 'balance check failed');
      }
      if (balance !== null) {
        await tx.bankLink.update({
          where: { id: bankLink.id },
          data: { availableBalanceCents: balance },
        });
      }
      if (!balanceCoversDebit(policy, balance, installment.totalCents)) {
        return defer('INSUFFICIENT_BALANCE');
      }
    }

    const priorAttempts = await tx.repayment.count({ where: { installmentId: installment.id } });
    const result = await providers.payments.charge({
      amountCents: installment.totalCents,
      sourceToken: bankLink.providerAccountToken,
      idempotencyKey: `installment:${installment.id}:attempt:${priorAttempts + 1}`,
      description: `Rent installment ${installment.sequence} for ${installment.periodMonth}`,
      effectiveDate: asOf,
    });
    if (!result.ok) {
      return fail(result.failureReason, result.providerRef, result.returnCode ?? null);
    }

    const repayment = await tx.repayment.create({
      data: {
        installmentId: installment.id,
        amountCents: installment.totalCents,
        provider: providers.payments.name,
        providerRef: result.providerRef,
        status: 'SUCCEEDED',
        bankLinkId: bankLink.id,
        manual,
        recovery: chargedOff,
        createdAt: at,
      },
    });

    // Principal: against the receivable, or to recovery income when the receivable was
    // already written off. The fee is revenue only now that it has been collected.
    const entries: EntryInput[] = [
      { accountCode: ACCOUNTS.CASH, direction: 'DEBIT', amountCents: installment.totalCents },
      {
        accountCode: chargedOff ? ACCOUNTS.RECOVERY_INCOME : receivableCode(plan.businessId),
        direction: 'CREDIT',
        amountCents: installment.principalCents,
      },
    ];
    if (installment.feeCents > 0) {
      entries.push({
        accountCode: ACCOUNTS.FEE_REVENUE,
        direction: 'CREDIT',
        amountCents: installment.feeCents,
      });
    }
    // Keyed by the repayment, not the installment: an installment whose payment is returned
    // is collected again, and that is a second posting.
    await postTransaction(tx, {
      description: chargedOff
        ? `Recovery: installment ${installment.sequence} for ${installment.periodMonth}`
        : `Installment ${installment.sequence} collected for ${installment.periodMonth}`,
      effectiveDate: asOf,
      referenceType: chargedOff ? 'recovery' : 'installment',
      referenceId: installment.id,
      idempotencyKey: `repayment:${repayment.id}`,
      entries,
    });

    await tx.installment.update({
      where: { id: installment.id },
      data: {
        status: 'PAID',
        paidAt: at,
        attemptCount: attempts + 1,
        lastAttemptOn: asOf,
        attemptBankLinkId: bankLink.id,
        collectionSkipReason: null,
        collectionSkippedOn: null,
      },
    });
    if (chargedOff) {
      await recordAudit(tx, {
        actor,
        eventType: 'RECOVERY_RECEIVED',
        subjectType: 'rent_plan',
        subjectId: plan.id,
        payload: {
          installmentId: installment.id,
          repaymentId: repayment.id,
          principalCents: installment.principalCents,
          feeCents: installment.feeCents,
        },
        at,
      });
    }
    await refreshDelinquency(tx, plan.id, asOf, actor);
    ctx.log.info(
      { installmentId: installment.id, amountCents: installment.totalCents, recovery: chargedOff },
      'installment collected',
    );
    return 'paid';
  });
}

/**
 * Settles operating cash with the capital pool. Collected cash moves into the pool so it can
 * fund the next payouts. When returned debits have taken operating cash below zero, the pool
 * covers the shortfall, so the account ends every run at zero either way. Running it twice
 * in a row is harmless: the second run finds nothing to move. Returns the cents moved into
 * the pool, negative when the pool paid out.
 */
export async function sweepCashToPool(ctx: AppContext, asOf: IsoDate): Promise<number> {
  return ctx.db.$transaction(async (tx) => {
    const cash = await accountBalance(tx, ACCOUNTS.CASH);
    if (cash === 0) return 0;
    const amountCents = Math.abs(cash);
    await postTransaction(tx, {
      description:
        cash > 0
          ? `Sweep collected cash to capital pool as of ${asOf}`
          : `Cover returned payments from capital pool as of ${asOf}`,
      effectiveDate: asOf,
      referenceType: 'cash_sweep',
      entries:
        cash > 0
          ? [
              { accountCode: ACCOUNTS.CAPITAL_POOL, direction: 'DEBIT', amountCents },
              { accountCode: ACCOUNTS.CASH, direction: 'CREDIT', amountCents },
            ]
          : [
              { accountCode: ACCOUNTS.CASH, direction: 'DEBIT', amountCents },
              { accountCode: ACCOUNTS.CAPITAL_POOL, direction: 'CREDIT', amountCents },
            ],
    });
    return cash;
  });
}

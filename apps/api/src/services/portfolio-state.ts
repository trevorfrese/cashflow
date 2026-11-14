import { addDays, type IsoDate } from '@cashflow/shared';

import type { Tx } from '../db.ts';
import type { BankLink, Business, Lease } from '../generated/prisma/client.ts';
import { ACCOUNTS } from '../ledger/accounts.ts';
import { accountBalance, receivablesBalance } from '../ledger/service.ts';
import type { Providers } from '../providers/index.ts';
import { ACTIVE_SERVICING_POLICY } from '../servicing/policy.ts';
import type { ExposureContext, PoolState } from '../underwriting/exposure.ts';
import { landlordIsApplicant, type IntegrityContext } from '../underwriting/integrity.ts';

/**
 * Database lookups for the pure underwriting rules.
 *
 * The exposure rules need to know what a business already has with us, what its industry
 * holds, and what the pool looks like. The integrity checks need to know whether a landlord
 * account is really the applicant's, and whether the same bank account, landlord account, or
 * business identity shows up under another user. This module gathers those facts; the rules
 * themselves stay in `underwriting/exposure.ts` and `underwriting/integrity.ts`.
 */

/**
 * A financed plan counts toward exposure while it can still draw a landlord payout. A
 * pass-through plan never does: CashFlow advances nothing on it.
 */
const COMMITTED_STATUSES = ['ACTIVE', 'PAUSED'] as const;

/**
 * Pool cash from the capital provider and the ledger, receivables from the ledger.
 *
 * Receivables are gross: the sum of the per business receivable accounts, before the
 * allowance for credit losses. The exposure rules measure how much of the pool is out, and
 * a reserve is an estimate of loss, not money that has come back, so it is not netted off.
 * A written off balance is different: the charge-off posting takes it out of the receivable
 * account, so it stops counting as capital here the day it is written off. A closed plan is
 * not committed, so a written off plan drops out of committed rent the same day. The
 * portfolio simulator keeps the same three numbers the same way.
 */
export async function gatherPoolState(tx: Tx, providers: Providers): Promise<PoolState> {
  const [available, operatingCash, receivableCents, committed] = await Promise.all([
    providers.capital.availableCents(tx),
    accountBalance(tx, ACCOUNTS.CASH),
    receivablesBalance(tx),
    tx.rentPlan.aggregate({
      where: { kind: 'FINANCED', status: { in: [...COMMITTED_STATUSES] } },
      _sum: { monthlyRentCents: true },
    }),
  ]);
  return {
    // Collected cash not yet swept is pool money too.
    cashCents: available + operatingCash,
    // A returned payout whose installments were already collected leaves a credit on one
    // business's account. It nets against the others; the total never reads below zero.
    receivableCents: Math.max(0, receivableCents),
    committedCents: committed._sum.monthlyRentCents ?? 0,
  };
}

/**
 * Rent periods a business has repaid in full with every installment inside the grace
 * period. This is what moves it up the limit ladder.
 *
 * A period counts only if no payment on it ever came back. An installment whose debit was
 * returned and then collected again inside grace is paid, but it is not a clean period: the
 * first payment bounced. And a payment that is returned after it was counted stops counting
 * at once, because this is computed from the rows on every read.
 */
export async function countOnTimePeriods(tx: Tx, businessId: string): Promise<number> {
  const payouts = await tx.landlordPayout.findMany({
    // A receivable left by a returned pass-through month is never an on time period.
    where: { status: 'PAID', rentPlan: { businessId }, passThroughPeriodId: null },
    select: {
      installments: {
        select: {
          status: true,
          dueDate: true,
          paidAt: true,
          chargedOffAt: true,
          repayments: { where: { status: 'RETURNED' }, select: { id: true }, take: 1 },
        },
      },
    },
  });
  const grace = ACTIVE_SERVICING_POLICY.lateGraceDays;
  return payouts.filter(
    (p) =>
      p.installments.length > 0 &&
      p.installments.every(
        (i) =>
          i.status === 'PAID' &&
          i.paidAt !== null &&
          i.chargedOffAt === null &&
          i.repayments.length === 0 &&
          (i.paidAt.toISOString().slice(0, 10) as IsoDate) <= addDays(i.dueDate, grace),
      ),
  ).length;
}

export interface ExposureLookup {
  businessId: string;
  industry: Business['industry'];
  /** Leave this plan out of the business and industry totals (used when re-underwriting it). */
  excludePlanId?: string;
}

export async function gatherExposureContext(
  tx: Tx,
  providers: Providers,
  lookup: ExposureLookup,
): Promise<ExposureContext> {
  const notThisPlan = lookup.excludePlanId ? { id: { not: lookup.excludePlanId } } : {};
  const [business, industry, onTimePeriods, pool] = await Promise.all([
    tx.rentPlan.aggregate({
      where: {
        businessId: lookup.businessId,
        kind: 'FINANCED',
        status: { in: [...COMMITTED_STATUSES] },
        ...notThisPlan,
      },
      _sum: { monthlyRentCents: true },
    }),
    tx.rentPlan.aggregate({
      where: {
        kind: 'FINANCED',
        status: { in: [...COMMITTED_STATUSES] },
        business: { industry: lookup.industry },
        ...notThisPlan,
      },
      _sum: { monthlyRentCents: true },
    }),
    countOnTimePeriods(tx, lookup.businessId),
    gatherPoolState(tx, providers),
  ]);
  const excluded = lookup.excludePlanId
    ? ((
        await tx.rentPlan.findUnique({
          where: { id: lookup.excludePlanId },
          select: { monthlyRentCents: true, status: true },
        })
      )?.monthlyRentCents ?? 0)
    : 0;
  return {
    businessCommittedCents: business._sum.monthlyRentCents ?? 0,
    onTimePeriods,
    industryCommittedCents: industry._sum.monthlyRentCents ?? 0,
    pool: { ...pool, committedCents: Math.max(0, pool.committedCents - excluded) },
  };
}

type BusinessIdentity = Pick<
  Business,
  'id' | 'ownerUserId' | 'legalName' | 'dba' | 'addressLine1' | 'postalCode'
>;

/**
 * Integrity facts that need the database: is a landlord account the applicant's own, and
 * does this bank account, landlord account, or business identity appear under another user.
 * "Another user" matters: one owner with two businesses sharing an account is not a signal.
 */
export async function gatherIntegrityContext(
  tx: Tx,
  business: BusinessIdentity,
  options: { bankLink?: BankLink | null; lease?: Lease | null } = {},
): Promise<IntegrityContext> {
  const otherOwner = { ownerUserId: { not: business.ownerUserId } };
  const [bankLinks, leases] = await Promise.all([
    tx.bankLink.findMany({ where: { businessId: business.id, status: 'LINKED' } }),
    options.lease
      ? Promise.resolve([options.lease])
      : tx.lease.findMany({ where: { businessId: business.id, status: { not: 'ENDED' } } }),
  ]);
  const accountTokens = [
    ...new Set(
      [...(options.bankLink ? [options.bankLink] : []), ...bankLinks].map(
        (l) => l.providerAccountToken,
      ),
    ),
  ];

  const [sameBank, sameIdentity, sameLandlord] = await Promise.all([
    accountTokens.length === 0
      ? Promise.resolve([])
      : tx.bankLink.findMany({
          where: {
            providerAccountToken: { in: accountTokens },
            status: 'LINKED',
            business: otherOwner,
          },
          select: { businessId: true },
          distinct: ['businessId'],
        }),
    tx.business.count({
      where: {
        ...otherOwner,
        legalName: { equals: business.legalName, mode: 'insensitive' },
        addressLine1: { equals: business.addressLine1, mode: 'insensitive' },
        postalCode: business.postalCode,
      },
    }),
    leases.length === 0
      ? Promise.resolve([])
      : tx.lease.findMany({
          where: {
            status: { not: 'ENDED' },
            business: otherOwner,
            OR: leases.map((l) => ({
              landlordRoutingNumber: l.landlordRoutingNumber,
              landlordAccountNumberLast4: l.landlordAccountNumberLast4,
            })),
          },
          select: { businessId: true },
          distinct: ['businessId'],
        }),
  ]);

  return {
    landlordAccountIsApplicantAccount: leases.some((lease) =>
      landlordIsApplicant(lease, bankLinks, business),
    ),
    otherBusinessesWithSameLandlordAccount: sameLandlord.length,
    otherBusinessesWithSameBankAccount: sameBank.length,
    otherBusinessesWithSameIdentity: sameIdentity,
  };
}

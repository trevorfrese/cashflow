import type { IsoDate } from '@cashflow/shared';

import type { Tx } from '../db.ts';
import type { RentPlanKind } from '../generated/prisma/enums.ts';

/**
 * One landlord payment per lease and period month.
 *
 * Every payment of rent to a landlord, from a financed payout, a reviewer's re-send, or a
 * pass-through month, first claims a `LandlordDisbursement` row inside the same database
 * transaction, before the payments provider is called. A partial unique index allows one SENT
 * row per lease and period month (see the migration `20261115090000_pass_through_plans`),
 * so:
 *
 *   - a held payout released twice, or two job runs at the same moment, cannot both send it:
 *     the second insert waits on the first transaction and then fails, and the payout job
 *     also locks the payout row (`lockPayout`), so the second run reads it as PAID;
 *   - two plans on the same lease (a paused plan and a new one, a pass-through plan and its
 *     financed successor) cannot both pay the same month;
 *   - a payment the landlord's bank sent back is marked RETURNED and stops counting, so a
 *     reviewer can send it again under its own key.
 *
 * The provider call is idempotent by key as well, and the ledger posting has its own unique
 * key. This is the layer that holds across plans and kinds, which neither of those can.
 */

export interface DisbursementClaim {
  leaseId: string;
  periodMonth: string;
  rentPlanId: string;
  kind: RentPlanKind;
  sourceId: string;
  /** The provider and ledger key of this send. */
  idempotencyKey: string;
  amountCents: number;
  effectiveDate: IsoDate;
}

export type ClaimResult =
  | { ok: true; id: string }
  /** The month was already paid to this landlord, by this send or another. */
  | {
      ok: false;
      existing: { id: string; rentPlanId: string; sourceId: string; idempotencyKey: string };
    };

/**
 * Claim the right to pay a landlord for a month. Call inside the transaction that will call
 * the provider and post the ledger, before the provider call. When it returns `ok: false`,
 * pay nothing. A concurrent claim for the same month makes the insert fail with a unique
 * violation, which aborts the transaction: callers treat that as "already paid".
 */
export async function claimDisbursement(tx: Tx, claim: DisbursementClaim): Promise<ClaimResult> {
  const existing = await tx.landlordDisbursement.findFirst({
    where: { leaseId: claim.leaseId, periodMonth: claim.periodMonth, status: 'SENT' },
    select: { id: true, rentPlanId: true, sourceId: true, idempotencyKey: true },
  });
  if (existing) return { ok: false, existing };
  const row = await tx.landlordDisbursement.create({
    data: {
      leaseId: claim.leaseId,
      periodMonth: claim.periodMonth,
      rentPlanId: claim.rentPlanId,
      kind: claim.kind,
      sourceId: claim.sourceId,
      idempotencyKey: claim.idempotencyKey,
      amountCents: claim.amountCents,
      effectiveDate: claim.effectiveDate,
    },
  });
  return { ok: true, id: row.id };
}

/** The provider accepted the payment: record its reference. */
export function confirmDisbursement(tx: Tx, id: string, providerRef: string) {
  return tx.landlordDisbursement.update({ where: { id }, data: { providerRef } });
}

/** The provider refused the payment: nothing was sent, so the claim is released. */
export function releaseDisbursement(tx: Tx, id: string) {
  return tx.landlordDisbursement.delete({ where: { id } });
}

/** The landlord's bank sent the payment back. It no longer counts as paid. */
export function markDisbursementReturned(tx: Tx, idempotencyKey: string, at: Date) {
  return tx.landlordDisbursement.updateMany({
    where: { idempotencyKey, status: 'SENT' },
    data: { status: 'RETURNED', returnedAt: at },
  });
}

/** A unique violation from Postgres, through Prisma: another transaction claimed first. */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (e.code === 'P2002' || e.code === '23505') return true;
  if (typeof e.message === 'string' && /unique constraint|23505/i.test(e.message)) return true;
  return e.cause !== undefined && e.cause !== err ? isUniqueViolation(e.cause) : false;
}

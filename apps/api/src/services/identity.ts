import type { AdminIdentity } from '@cashflow/shared';

import { clockNow } from '../dates.ts';
import type { Db, Tx } from '../db.ts';
import { forbidden, notFound, unprocessable } from '../errors.ts';
import type {
  Prisma,
  ScreeningPartyType,
  ScreeningResult,
  VerificationStatus,
} from '../generated/prisma/client.ts';
import type { IdentityProvider } from '../providers/identity/index.ts';
import type { IdentityFacts } from '../underwriting/integrity.ts';
import { recordAudit, type AuditActor } from './audit.ts';

/**
 * Identity verification and sanctions screening.
 *
 * The identity provider answers; this module decides when to ask, stores what came back, and
 * acts on it. Verification state lives on the business and its owners. Screening is a
 * history in `ScreeningResult`: each screening of a party adds a row and supersedes the one
 * before it, so the current result for a party is its row with `supersededAt` null.
 *
 * A hit (POSSIBLE_MATCH or MATCH) on a party tied to a running plan freezes that plan from
 * further advances with the existing freeze (`advanceFrozenAt`, reason `SCREENING_REVIEW`),
 * so the payout job holds what falls due. Nothing lifts it but a reviewer clearing the hit.
 */

/** `RentPlan.advanceFrozenReason` set by a screening hit. */
export const SCREENING_FREEZE_REASON = 'SCREENING_REVIEW';

const SYSTEM: AuditActor = { type: 'system', id: 'identity' };

/** Worst first. */
const VERIFICATION_RANK: Record<VerificationStatus, number> = {
  FAILED: 3,
  REVIEW: 2,
  UNVERIFIED: 1,
  VERIFIED: 0,
};

function worst(statuses: VerificationStatus[]): VerificationStatus {
  return statuses.reduce<VerificationStatus>(
    (acc, s) => (VERIFICATION_RANK[s] > VERIFICATION_RANK[acc] ? s : acc),
    'VERIFIED',
  );
}

/** A current hit nobody has cleared. Rows for a proposed landlord are in `leaseChangeId`. */
export const OPEN_HIT: Prisma.ScreeningResultWhereInput = {
  supersededAt: null,
  clearedAt: null,
  result: { in: ['POSSIBLE_MATCH', 'MATCH'] },
};

interface ScreenArgs {
  businessId: string;
  partyType: ScreeningPartyType;
  /** Business id, owner id, lease id, or a lease change id for a proposed landlord. */
  partyRef: string;
  name: string;
  aliases?: string[];
  leaseChangeId?: string;
  actor?: AuditActor;
  /** When the screening happened. Defaults to now. */
  at?: Date;
}

/**
 * Screen one party and store the result. Supersedes the party's previous current row. A hit
 * with the same provider reference as one a reviewer already cleared for this business is
 * stored as cleared, so a false positive does not come back on every rescreen. A new hit
 * writes a high severity audit event and freezes the plans the party is tied to.
 */
export async function screenParty(
  ctx: { db: Db; providers: { identity: IdentityProvider } },
  args: ScreenArgs,
): Promise<ScreeningResult> {
  const aliases = (args.aliases ?? []).filter(
    (a) => a.trim() !== '' && a.trim().toLowerCase() !== args.name.trim().toLowerCase(),
  );
  const output = await ctx.providers.identity.screenParty({
    partyType: args.partyType,
    name: args.name,
    aliases,
    country: 'US',
  });
  const at = args.at ?? clockNow();
  const actor = args.actor ?? SYSTEM;
  return ctx.db.$transaction(async (tx) => {
    await tx.screeningResult.updateMany({
      where: { partyType: args.partyType, partyRef: args.partyRef, supersededAt: null },
      data: { supersededAt: at },
    });
    const isHit = output.result !== 'CLEAR';
    const priorClearance = isHit
      ? await tx.screeningResult.findFirst({
          where: {
            businessId: args.businessId,
            partyType: args.partyType,
            providerRef: output.matchReference,
            clearedAt: { not: null },
          },
          orderBy: { clearedAt: 'desc' },
        })
      : null;
    const row = await tx.screeningResult.create({
      data: {
        businessId: args.businessId,
        partyType: args.partyType,
        partyRef: args.partyRef,
        nameScreened: [args.name, ...aliases].join(' / '),
        country: 'US',
        result: output.result,
        provider: ctx.providers.identity.name,
        providerRef: output.matchReference,
        leaseChangeId: args.leaseChangeId ?? null,
        screenedAt: at,
        clearedBy: priorClearance?.clearedBy ?? null,
        clearedAt: priorClearance?.clearedAt ?? null,
        clearedReason: priorClearance
          ? `Carried forward from screening ${priorClearance.id}: ${priorClearance.clearedReason ?? ''}`.trim()
          : null,
      },
    });
    await recordAudit(tx, {
      actor,
      eventType: 'PARTY_SCREENED',
      subjectType: 'business',
      subjectId: args.businessId,
      payload: {
        screeningId: row.id,
        partyType: args.partyType,
        partyRef: args.partyRef,
        result: output.result,
        provider: row.provider,
        clearanceCarriedForward: priorClearance !== null,
      },
      at,
    });
    if (isHit && !priorClearance) {
      await recordAudit(tx, {
        actor,
        eventType: 'SCREENING_HIT',
        subjectType: 'screening',
        subjectId: row.id,
        payload: {
          businessId: args.businessId,
          partyType: args.partyType,
          partyRef: args.partyRef,
          result: output.result,
          providerRef: output.matchReference,
          leaseChangeId: args.leaseChangeId ?? null,
        },
        severity: 'high',
        at,
      });
      // A proposed landlord is not a payee yet: the pending change already holds the payout.
      if (!args.leaseChangeId) await freezePlansForHit(tx, row, actor, at);
    }
    return row;
  });
}

/** The plans a screened party is tied to: one lease's for a landlord, all for the others. */
function plansOfParty(row: Pick<ScreeningResult, 'businessId' | 'partyType' | 'partyRef'>) {
  return {
    businessId: row.businessId,
    status: { not: 'CLOSED' as const },
    ...(row.partyType === 'LANDLORD' ? { leaseId: row.partyRef } : {}),
  };
}

async function freezePlansForHit(tx: Tx, row: ScreeningResult, actor: AuditActor, at: Date) {
  const plans = await tx.rentPlan.findMany({
    where: { ...plansOfParty(row), advanceFrozenAt: null },
    select: { id: true },
  });
  for (const plan of plans) {
    await tx.rentPlan.update({
      where: { id: plan.id },
      data: { advanceFrozenAt: at, advanceFrozenReason: SCREENING_FREEZE_REASON },
    });
    await recordAudit(tx, {
      actor,
      eventType: 'PLAN_ADVANCE_FROZEN',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: { reason: SCREENING_FREEZE_REASON, screeningId: row.id },
      at,
    });
  }
}

/** Open hits that bear on a plan: the business, its owners, and the landlord on its lease. */
export function openHitsForPlan(tx: Tx, plan: { businessId: string; leaseId: string }) {
  return tx.screeningResult.findMany({
    where: {
      ...OPEN_HIT,
      businessId: plan.businessId,
      leaseChangeId: null,
      OR: [
        { partyType: { in: ['BUSINESS', 'OWNER'] } },
        { partyType: 'LANDLORD', partyRef: plan.leaseId },
      ],
    },
  });
}

/** Open hits on a business, its owners, and the landlords of its leases that have not ended. */
export async function openHitsForBusiness(tx: Tx, businessId: string) {
  const [hits, leases] = await Promise.all([
    tx.screeningResult.findMany({ where: { ...OPEN_HIT, businessId, leaseChangeId: null } }),
    tx.lease.findMany({ where: { businessId, status: { not: 'ENDED' } }, select: { id: true } }),
  ]);
  const live = new Set(leases.map((l) => l.id));
  return hits.filter((h) => h.partyType !== 'LANDLORD' || live.has(h.partyRef));
}

export interface IdentityRunResult {
  status: VerificationStatus;
  reasons: string[];
  hits: number;
}

/**
 * Run the business and its owners through the identity provider and screen them. Called
 * when a business is created, when its identity fields change, and when an application is
 * submitted. The status stored on the business is the worst across the business and its
 * owners, so one field answers "can this business be approved without a person looking".
 */
export async function runBusinessIdentity(
  ctx: { db: Db; providers: { identity: IdentityProvider } },
  businessId: string,
  options: { actor?: AuditActor; at?: Date } = {},
): Promise<IdentityRunResult> {
  const { db, providers } = ctx;
  const at = options.at ?? clockNow();
  const actor = options.actor ?? SYSTEM;
  const business = await db.business.findUnique({
    where: { id: businessId },
    include: { owners: { orderBy: { createdAt: 'asc' } } },
  });
  if (!business) throw notFound('Business');

  const [entity, owners] = await Promise.all([
    providers.identity.verifyBusiness({
      legalName: business.legalName,
      dba: business.dba,
      address: {
        line1: business.addressLine1,
        line2: business.addressLine2,
        city: business.city,
        state: business.state,
        postalCode: business.postalCode,
      },
      taxIdLast4: business.taxIdLast4,
      formationDate: business.foundedOn,
    }),
    providers.identity.verifyOwners(
      business.owners.map((o) => ({
        ownerId: o.id,
        fullName: o.fullName,
        title: o.title,
        ownershipBps: o.ownershipBps,
      })),
    ),
  ]);

  const reasons = [...entity.reasons];
  const statuses: VerificationStatus[] = [entity.status];
  if (business.owners.length === 0) {
    statuses.push('REVIEW');
    reasons.push('OWNERS_MISSING');
  }
  for (const owner of owners) {
    statuses.push(owner.status);
    for (const r of owner.reasons) reasons.push(`OWNER:${r}`);
  }
  const status = worst(statuses);

  await db.$transaction(async (tx) => {
    await tx.business.update({
      where: { id: business.id },
      data: {
        verificationStatus: status,
        verificationCheckedAt: at,
        verificationProvider: providers.identity.name,
        verificationRef: entity.reference,
        verificationReasons: reasons,
      },
    });
    for (const owner of owners) {
      await tx.beneficialOwner.update({
        where: { id: owner.ownerId },
        data: {
          verificationStatus: owner.status,
          verificationRef: owner.reference,
          verifiedAt: at,
        },
      });
    }
    await recordAudit(tx, {
      actor,
      eventType: 'IDENTITY_CHECKED',
      subjectType: 'business',
      subjectId: business.id,
      payload: {
        status,
        previousStatus: business.verificationStatus,
        reasons,
        provider: providers.identity.name,
        owners: owners.length,
      },
      severity: status === 'FAILED' ? 'warning' : 'info',
      at,
    });
  });

  let hits = 0;
  const screened = await screenParty(ctx, {
    businessId: business.id,
    partyType: 'BUSINESS',
    partyRef: business.id,
    name: business.legalName,
    aliases: business.dba ? [business.dba] : [],
    actor,
    at,
  });
  if (screened.result !== 'CLEAR' && screened.clearedAt === null) hits += 1;
  for (const owner of business.owners) {
    const row = await screenParty(ctx, {
      businessId: business.id,
      partyType: 'OWNER',
      partyRef: owner.id,
      name: owner.fullName,
      actor,
      at,
    });
    if (row.result !== 'CLEAR' && row.clearedAt === null) hits += 1;
  }
  return { status, reasons, hits };
}

/** Screen the landlord on a lease as the payee: the landlord's name and the account holder. */
export function screenLandlord(
  ctx: { db: Db; providers: { identity: IdentityProvider } },
  lease: {
    id: string;
    businessId: string;
    landlordName: string;
    landlordAccountHolderName: string;
  },
  options: { actor?: AuditActor; at?: Date; leaseChangeId?: string } = {},
) {
  return screenParty(ctx, {
    businessId: lease.businessId,
    partyType: 'LANDLORD',
    partyRef: options.leaseChangeId ?? lease.id,
    name: lease.landlordName,
    aliases: [lease.landlordAccountHolderName],
    leaseChangeId: options.leaseChangeId,
    actor: options.actor,
    at: options.at,
  });
}

/**
 * What the underwriting engine is told about identity: the stored verification status and
 * the worst open screening hit. Read from the database; the engine stays pure.
 */
export async function gatherIdentityFacts(tx: Tx, businessId: string): Promise<IdentityFacts> {
  const [business, hits] = await Promise.all([
    tx.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { verificationStatus: true, verificationReasons: true },
    }),
    openHitsForBusiness(tx, businessId),
  ]);
  return {
    verification: business.verificationStatus,
    verificationReasons: business.verificationReasons,
    screening: hits.some((h) => h.result === 'MATCH')
      ? 'MATCH'
      : hits.length > 0
        ? 'POSSIBLE_MATCH'
        : 'CLEAR',
    openHits: hits.length,
  };
}

/**
 * A reviewer clears a screening hit: the match is not the party. Records who and why, and
 * releases every plan that was frozen for screening and has no other open hit. A MATCH can
 * only be cleared by an admin.
 */
export async function clearScreening(
  db: Db,
  args: { screeningId: string; identity: AdminIdentity; reason: string },
) {
  return db.$transaction(async (tx) => {
    const row = await tx.screeningResult.findUnique({ where: { id: args.screeningId } });
    if (!row) throw notFound('Screening result');
    if (row.result === 'CLEAR') {
      throw unprocessable('SCREENING_NOT_A_HIT', 'This screening came back clear');
    }
    if (row.clearedAt !== null) {
      throw unprocessable('SCREENING_ALREADY_CLEARED', 'This hit has already been cleared');
    }
    if (row.supersededAt !== null) {
      throw unprocessable(
        'SCREENING_SUPERSEDED',
        'A later screening of this party replaced this one. Clear the current result',
      );
    }
    if (row.result === 'MATCH' && args.identity.role !== 'admin') {
      throw forbidden('Only an admin can clear a confirmed match');
    }
    const at = clockNow();
    const actor: AuditActor = { type: args.identity.role, id: args.identity.actor };
    const cleared = await tx.screeningResult.update({
      where: { id: row.id },
      data: { clearedBy: args.identity.actor, clearedAt: at, clearedReason: args.reason },
    });
    await recordAudit(tx, {
      actor,
      eventType: 'SCREENING_CLEARED',
      subjectType: 'screening',
      subjectId: row.id,
      payload: {
        businessId: row.businessId,
        partyType: row.partyType,
        partyRef: row.partyRef,
        result: row.result,
        reason: args.reason,
        role: args.identity.role,
      },
      at,
    });

    const released: string[] = [];
    if (!row.leaseChangeId) {
      const frozen = await tx.rentPlan.findMany({
        where: {
          businessId: row.businessId,
          status: { not: 'CLOSED' },
          advanceFrozenReason: SCREENING_FREEZE_REASON,
        },
      });
      for (const plan of frozen) {
        const remaining = await openHitsForPlan(tx, plan);
        if (remaining.length > 0) continue;
        await tx.rentPlan.update({
          where: { id: plan.id },
          data: { advanceFrozenAt: null, advanceFrozenReason: null },
        });
        await recordAudit(tx, {
          actor,
          eventType: 'PLAN_ADVANCE_RELEASED',
          subjectType: 'rent_plan',
          subjectId: plan.id,
          payload: {
            frozenAt: plan.advanceFrozenAt?.toISOString() ?? null,
            frozenReason: plan.advanceFrozenReason,
            reason: `Screening hit ${row.id} cleared: ${args.reason}`,
            screeningId: row.id,
          },
          at,
        });
        released.push(plan.id);
      }
    }
    return { screening: cleared, releasedPlanIds: released };
  });
}

/**
 * The owner's view of verification: three states and plain words. A failed check, a check
 * in review, and an open screening hit all read the same, on purpose: the owner is told the
 * account is under review and to get in touch, never what was found.
 */
export function ownerVerificationView(
  business: { verificationStatus: VerificationStatus; verificationReasons: string[] },
  openHits: number,
): { status: 'VERIFIED' | 'NEEDS_INFO' | 'UNDER_REVIEW'; message: string | null } {
  if (openHits === 0 && business.verificationStatus === 'VERIFIED') {
    return { status: 'VERIFIED', message: null };
  }
  const missing = business.verificationReasons.filter(
    (r) => r === 'TAX_ID_MISSING' || r === 'OWNERS_MISSING',
  );
  const onlyMissing =
    openHits === 0 &&
    (business.verificationStatus === 'UNVERIFIED' ||
      (business.verificationStatus === 'REVIEW' &&
        missing.length === business.verificationReasons.length));
  if (onlyMissing) {
    return {
      status: 'NEEDS_INFO',
      message:
        'We need a few more details to verify your business: the last 4 digits of its tax id and at least one owner.',
    };
  }
  return {
    status: 'UNDER_REVIEW',
    message:
      'Your account is under review. There is nothing you need to do right now. If you have questions, contact support.',
  };
}

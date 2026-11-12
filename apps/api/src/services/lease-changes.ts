import {
  addDays,
  buildInstallmentSchedule,
  formatCents,
  type AdminIdentity,
  type CashFlowSummary,
  type IsoDate,
  type LeaseChangeField,
  type UpdateLeaseRequest,
} from '@cashflow/shared';

import { CONTROLS_POLICY } from '../controls/policy.ts';
import { clockNow, effectiveAt, todayIso } from '../dates.ts';
import type { Db, Tx } from '../db.ts';
import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import type { Lease, LeaseChange, Prisma, RentPlan } from '../generated/prisma/client.ts';
import { openLeaseChangeAlert } from '../monitoring/service.ts';
import type { Providers } from '../providers/index.ts';
import { checkNewPlan } from '../underwriting/exposure.ts';
import { landlordIsApplicant } from '../underwriting/integrity.ts';
import { CURRENT_POLICY } from '../underwriting/policy.ts';
import { planFeeBps } from '../underwriting/pricing.ts';
import { recordAudit, type AuditActor } from './audit.ts';
import { currentDecision } from './decisions.ts';
import { screenLandlord } from './identity.ts';
import { gatherExposureContext } from './portfolio-state.ts';

/**
 * Lease change control.
 *
 * Landlord payouts read the lease when they run, so whoever can edit a lease can choose
 * where the next month's rent goes. On a lease with a running plan, a change to the
 * landlord's identity or payout account therefore does not apply when it is asked for. It
 * becomes a `LeaseChange` that waits out a cooling-off period (`CONTROLS_POLICY`):
 *
 *   - while it is pending, payouts on the lease are held (`LEASE_CHANGE_PENDING`);
 *   - the proposed landlord is screened;
 *   - an audit event is written and an alert is opened;
 *   - the owner can cancel it;
 *   - it applies on its own when the period ends (the `lease-changes` job), or earlier when
 *     a reviewer approves it, and never if a reviewer rejects it or the proposed landlord
 *     has an open screening hit.
 *
 * A lease with no running plan pays nobody, so there the change applies at once.
 *
 * Rent is separate. A decrease, or an increase that the current approval and the exposure
 * rules cover, moves the plan to the new rent from the next period that has not been paid. An
 * increase they do not cover is recorded on the plan as pending and holds its payouts
 * (CashFlow fronts a whole month's rent or nothing) until a new decision covers it or the
 * rent is put back.
 */

type Ctx = { db: Db; providers: Providers };

interface LandlordColumns {
  landlordName?: string;
  landlordEmail?: string;
  landlordAccountHolderName?: string;
  landlordRoutingNumber?: string;
  landlordAccountNumberLast4?: string;
  landlordPayoutToken?: string;
}

const OPEN_PLAN = { status: { not: 'CLOSED' as const } };

/** The landlord columns a request would actually change, and which fields they belong to. */
export function landlordDiff(
  lease: Lease,
  body: UpdateLeaseRequest,
): { columns: LandlordColumns; fields: LeaseChangeField[] } {
  const columns: LandlordColumns = {};
  const fields: LeaseChangeField[] = [];
  if (body.landlordName !== undefined && body.landlordName !== lease.landlordName) {
    columns.landlordName = body.landlordName;
    fields.push('landlordName');
  }
  if (body.landlordEmail !== undefined && body.landlordEmail !== lease.landlordEmail) {
    columns.landlordEmail = body.landlordEmail;
    fields.push('landlordEmail');
  }
  const p = body.landlordPayout;
  if (p) {
    if (p.accountHolderName !== lease.landlordAccountHolderName) {
      columns.landlordAccountHolderName = p.accountHolderName;
    }
    if (p.routingNumber !== lease.landlordRoutingNumber) {
      columns.landlordRoutingNumber = p.routingNumber;
    }
    if (p.accountNumberLast4 !== lease.landlordAccountNumberLast4) {
      columns.landlordAccountNumberLast4 = p.accountNumberLast4;
    }
    if (p.providerToken !== lease.landlordPayoutToken) {
      columns.landlordPayoutToken = p.providerToken;
    }
    if (
      columns.landlordAccountHolderName !== undefined ||
      columns.landlordRoutingNumber !== undefined ||
      columns.landlordAccountNumberLast4 !== undefined ||
      columns.landlordPayoutToken !== undefined
    ) {
      fields.push('landlordPayout');
    }
  }
  return { columns, fields };
}

/** The current values of the columns a change touches, without the payout token. */
function previousOf(lease: Lease, columns: LandlordColumns) {
  const out: Record<string, string | boolean> = {};
  for (const key of Object.keys(columns) as (keyof LandlordColumns)[]) {
    if (key === 'landlordPayoutToken') out.payoutTokenChanged = true;
    else out[key] = lease[key];
  }
  return out;
}

export interface LeaseUpdateResult {
  lease: Lease;
  pendingChange: LeaseChange | null;
}

/**
 * Apply an owner's edit to a lease. Property and date fields apply at once. Landlord and
 * payout fields apply at once only when no plan is running; otherwise they become a pending
 * change. Rent follows the rules in the module comment.
 */
export async function updateLease(
  ctx: Ctx,
  args: { leaseId: string; userId: string; body: UpdateLeaseRequest; asOf?: IsoDate },
): Promise<LeaseUpdateResult> {
  const { db } = ctx;
  const asOf = args.asOf ?? todayIso();
  const at = effectiveAt(asOf);
  const actor: AuditActor = { type: 'user', id: args.userId };
  const b = args.body;

  const lease = await db.lease.findUnique({
    where: { id: args.leaseId },
    include: {
      business: { include: { bankLinks: { where: { status: 'LINKED' } } } },
      rentPlans: { where: OPEN_PLAN, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  if (!lease) throw notFound('Lease');
  if (lease.business.ownerUserId !== args.userId) throw forbidden();
  const plan = lease.rentPlans[0] ?? null;
  const { columns, fields } = landlordDiff(lease, b);

  if (fields.length > 0) {
    const pending = await db.leaseChange.findFirst({
      where: { leaseId: lease.id, status: 'PENDING' },
    });
    if (pending) {
      throw conflict(
        'LEASE_CHANGE_PENDING',
        'A change to the landlord details on this lease is already waiting to take effect. Cancel it before asking for another',
        { leaseChangeId: pending.id, effectiveOn: pending.effectiveOn },
      );
    }
    const proposed = { ...lease, ...columns };
    if (landlordIsApplicant(proposed, lease.business.bankLinks, lease.business)) {
      throw unprocessable(
        'LANDLORD_ACCOUNT_MATCH',
        'The landlord payout account matches a bank account linked to this business. Rent has to be paid to the landlord',
      );
    }
  }

  const rentChanged =
    b.monthlyRentCents !== undefined && b.monthlyRentCents !== lease.monthlyRentCents;
  const immediate: Prisma.LeaseUpdateInput = {
    propertyLine1: b.propertyAddress?.line1,
    propertyLine2: b.propertyAddress?.line2,
    propertyCity: b.propertyAddress?.city,
    propertyState: b.propertyAddress?.state,
    propertyPostalCode: b.propertyAddress?.postalCode,
    dueDayOfMonth: b.dueDayOfMonth,
    startsOn: b.startsOn,
    endsOn: b.endsOn,
    ...(plan ? {} : columns),
    ...(rentChanged ? { monthlyRentCents: b.monthlyRentCents } : {}),
  };

  const result = await db.$transaction(async (tx) => {
    let updated = await tx.lease.update({ where: { id: lease.id }, data: immediate });
    let pendingChange: LeaseChange | null = null;

    if (rentChanged) {
      await applyRentChange(ctx, tx, {
        lease: updated,
        plan,
        fromCents: lease.monthlyRentCents,
        toCents: b.monthlyRentCents!,
        industry: lease.business.industry,
        asOf,
        actor,
      });
    }

    if (fields.length > 0 && plan) {
      pendingChange = await tx.leaseChange.create({
        data: {
          leaseId: lease.id,
          businessId: lease.businessId,
          requestedByUserId: args.userId,
          changes: columns as Prisma.InputJsonValue,
          previous: previousOf(lease, columns) as Prisma.InputJsonValue,
          fields,
          requestedAt: at,
          effectiveOn: addDays(asOf, CONTROLS_POLICY.leaseChangeCoolingOffDays),
        },
      });
      await recordAudit(tx, {
        actor,
        eventType: 'LEASE_CHANGE_REQUESTED',
        subjectType: 'lease',
        subjectId: lease.id,
        payload: {
          leaseChangeId: pendingChange.id,
          businessId: lease.businessId,
          rentPlanId: plan.id,
          fields,
          previous: previousOf(lease, columns),
          proposed: previousOf({ ...lease, ...columns }, columns),
          effectiveOn: pendingChange.effectiveOn,
        },
        severity: 'warning',
        at,
      });
    } else if (fields.length > 0) {
      await recordAudit(tx, {
        actor,
        eventType: 'LEASE_UPDATED',
        subjectType: 'lease',
        subjectId: lease.id,
        payload: {
          businessId: lease.businessId,
          fields,
          previous: previousOf(lease, columns),
          appliedAtOnce: true,
          reason: 'No running plan on this lease',
        },
        at,
      });
      updated = await tx.lease.findUniqueOrThrow({ where: { id: lease.id } });
    }
    return { lease: updated, pendingChange };
  });

  // Screening calls the identity provider, so it runs after the change is stored.
  if (result.pendingChange) {
    // The alert is up now, not at the next monitor run. The monitor keeps it current.
    await db.$transaction((tx) => openLeaseChangeAlert(tx, result.pendingChange!.id, at));
    await screenLandlord(
      ctx,
      { ...lease, ...columns },
      { actor, at, leaseChangeId: result.pendingChange.id },
    );
  } else if (fields.includes('landlordName') || fields.includes('landlordPayout')) {
    await screenLandlord(ctx, result.lease, { actor, at });
  }
  return result;
}

interface RentChangeArgs {
  lease: Lease;
  plan: RentPlan | null;
  fromCents: number;
  toCents: number;
  industry: Parameters<typeof gatherExposureContext>[2]['industry'];
  asOf: IsoDate;
  actor: AuditActor;
}

/** Why the plan cannot simply move to `rentCents`, or null when it can. */
async function rentIncreaseRefusal(
  ctx: Ctx,
  tx: Tx,
  plan: RentPlan,
  rentCents: number,
  industry: RentChangeArgs['industry'],
): Promise<string | null> {
  const decision = await currentDecision(tx, plan.applicationId);
  const limit = decision?.outcome === 'APPROVED' ? (decision.approvedMonthlyLimitCents ?? 0) : 0;
  if (rentCents > limit) return 'RENT_OVER_LIMIT';
  const policy = CURRENT_POLICY;
  if (!policy.exposure) return null;
  // The plan's own rent is left out: the question is whether we would carry this lease at
  // the new rent, not whether we would add it on top of itself.
  const context = await gatherExposureContext(tx, ctx.providers, {
    businessId: plan.businessId,
    industry,
    excludePlanId: plan.id,
  });
  const refusal = checkNewPlan(policy.exposure, {
    rentCents,
    approvedLimitCents: limit,
    observedRentCents:
      (decision?.cashFlow as unknown as CashFlowSummary | null)?.observedRentCents ?? null,
    // We have been paying this landlord: the lease is known, the old rent is not a ceiling.
    leaseVerified: true,
    context,
  });
  if (!refusal) return null;
  return refusal.code === 'EXPOSURE_CAP' ? `EXPOSURE_CAP:${refusal.cap}` : refusal.code;
}

/**
 * Move a plan to a new rent: the plan row, its fee, and every period that has been
 * generated and not yet paid to the landlord, including one that is held. A period that
 * has been paid keeps the rent it was paid at, and one that came back from the landlord's
 * bank is left for a reviewer.
 */
export async function repricePlan(
  tx: Tx,
  plan: RentPlan,
  rentCents: number,
  feeBpsFromDecision?: number,
): Promise<RentPlan> {
  const base = feeBpsFromDecision ?? plan.feeBps;
  const feeBps = planFeeBps(CURRENT_POLICY, base, rentCents);
  if (feeBps === null) {
    throw unprocessable(
      'RENT_BELOW_MINIMUM',
      'This rent is too small for our minimum fee to stay within the maximum fee rate',
    );
  }
  const updated = await tx.rentPlan.update({
    where: { id: plan.id },
    data: { monthlyRentCents: rentCents, feeBps, pendingRentCents: null, pendingRentSince: null },
  });
  const future = await tx.landlordPayout.findMany({
    where: {
      rentPlanId: plan.id,
      status: { in: ['SCHEDULED', 'HELD', 'FAILED'] },
      returnCode: null,
    },
  });
  for (const payout of future) {
    const schedule = buildInstallmentSchedule({
      rentCents,
      feeBps,
      dueDate: payout.scheduledFor,
      installmentsPerMonth: updated.installmentsPerMonth,
    });
    await tx.installment.deleteMany({ where: { payoutId: payout.id } });
    await tx.landlordPayout.update({
      where: { id: payout.id },
      data: {
        amountCents: schedule.payoutCents,
        installments: {
          create: schedule.installments.map((i) => ({
            rentPlanId: plan.id,
            periodMonth: schedule.periodMonth,
            sequence: i.sequence,
            principalCents: i.principalCents,
            feeCents: i.feeCents,
            totalCents: i.totalCents,
            dueDate: i.dueDate,
          })),
        },
      },
    });
  }
  return updated;
}

async function applyRentChange(ctx: Ctx, tx: Tx, args: RentChangeArgs): Promise<void> {
  const { lease, plan, fromCents, toCents, asOf, actor } = args;
  const at = effectiveAt(asOf);
  if (!plan) {
    await recordAudit(tx, {
      actor,
      eventType: 'RENT_CHANGED',
      subjectType: 'lease',
      subjectId: lease.id,
      payload: { businessId: lease.businessId, fromCents, toCents, rentPlanId: null },
      at,
    });
    return;
  }
  // A pass-through plan fronts nothing, so there is no limit to check: months not yet
  // collected move to the new rent, and a month already collected keeps its amount.
  if (plan.kind === 'PASS_THROUGH') {
    await tx.rentPlan.update({
      where: { id: plan.id },
      data: { monthlyRentCents: toCents, pendingRentCents: null, pendingRentSince: null },
    });
    await tx.passThroughPeriod.updateMany({
      where: { rentPlanId: plan.id, status: 'SCHEDULED', collectionAttempts: 0 },
      data: { amountCents: toCents },
    });
    await recordAudit(tx, {
      actor,
      eventType: 'RENT_CHANGED',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        leaseId: lease.id,
        businessId: lease.businessId,
        fromCents: plan.monthlyRentCents,
        toCents,
        appliesFrom: 'The next month that has not been collected',
      },
      at,
    });
    return;
  }
  // Compared with what the plan fronts, not with the lease's last value: putting the rent
  // back after a pending increase is a return to the plan's rent.
  const refusal =
    toCents > plan.monthlyRentCents
      ? await rentIncreaseRefusal(ctx, tx, plan, toCents, args.industry)
      : null;
  if (refusal) {
    await tx.rentPlan.update({
      where: { id: plan.id },
      data: { pendingRentCents: toCents, pendingRentSince: plan.pendingRentSince ?? at },
    });
    await recordAudit(tx, {
      actor,
      eventType: 'RENT_INCREASE_PENDING',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        leaseId: lease.id,
        businessId: lease.businessId,
        planRentCents: plan.monthlyRentCents,
        requestedRentCents: toCents,
        reason: refusal,
      },
      severity: 'warning',
      at,
    });
    return;
  }
  if (toCents !== plan.monthlyRentCents) await repricePlan(tx, plan, toCents);
  else if (plan.pendingRentCents !== null) {
    await tx.rentPlan.update({
      where: { id: plan.id },
      data: { pendingRentCents: null, pendingRentSince: null },
    });
  }
  await recordAudit(tx, {
    actor,
    eventType: 'RENT_CHANGED',
    subjectType: 'rent_plan',
    subjectId: plan.id,
    payload: {
      leaseId: lease.id,
      businessId: lease.businessId,
      fromCents: plan.monthlyRentCents,
      toCents,
      appliesFrom: 'The next rent period that has not been paid to the landlord',
    },
    at,
  });
}

/**
 * A new approval may cover a rent increase that was waiting for one. Called in the
 * transaction that stores an APPROVED decision: every plan of the business whose pending
 * rent is within the new limit moves to that rent, is repriced at the new decision's fee,
 * and is pointed at the application that approved it.
 */
export async function applyApprovedRentIncreases(
  tx: Tx,
  args: {
    businessId: string;
    applicationId: string;
    decisionId: string;
    approvedMonthlyLimitCents: number;
    feeBps: number;
    actor: AuditActor;
    asOf: IsoDate;
  },
): Promise<number> {
  const plans = await tx.rentPlan.findMany({
    where: {
      businessId: args.businessId,
      kind: 'FINANCED',
      ...OPEN_PLAN,
      pendingRentCents: { not: null, lte: args.approvedMonthlyLimitCents },
    },
  });
  for (const plan of plans) {
    const toCents = plan.pendingRentCents!;
    await repricePlan(tx, plan, toCents, args.feeBps);
    await tx.rentPlan.update({
      where: { id: plan.id },
      data: { applicationId: args.applicationId },
    });
    await recordAudit(tx, {
      actor: args.actor,
      eventType: 'RENT_CHANGED',
      subjectType: 'rent_plan',
      subjectId: plan.id,
      payload: {
        businessId: args.businessId,
        fromCents: plan.monthlyRentCents,
        toCents,
        decisionId: args.decisionId,
        applicationId: args.applicationId,
        previousApplicationId: plan.applicationId,
        reason: 'A new decision covers the rent increase',
      },
      at: effectiveAt(args.asOf),
    });
  }
  return plans.length;
}

async function loadPending(tx: Tx, changeId: string) {
  const change = await tx.leaseChange.findUnique({
    where: { id: changeId },
    include: { lease: { include: { business: true } } },
  });
  if (!change) throw notFound('Lease change');
  if (change.status !== 'PENDING') {
    throw unprocessable(
      'LEASE_CHANGE_NOT_PENDING',
      `This change is ${change.status.toLowerCase()}, not pending`,
    );
  }
  return change;
}

/** The screening of the proposed landlord on a change, if it has run. */
export function proposedScreening(tx: Tx, changeId: string) {
  return tx.screeningResult.findFirst({
    where: { leaseChangeId: changeId },
    orderBy: { screenedAt: 'desc' },
  });
}

async function closeProposedScreening(tx: Tx, changeId: string, at: Date) {
  await tx.screeningResult.updateMany({
    where: { leaseChangeId: changeId, supersededAt: null },
    data: { supersededAt: at },
  });
}

/** The owner changes their mind, or did not ask for the change in the first place. */
export async function cancelLeaseChange(
  db: Db,
  args: { leaseId: string; userId: string },
): Promise<Lease> {
  return db.$transaction(async (tx) => {
    const lease = await tx.lease.findUnique({
      where: { id: args.leaseId },
      include: { business: true },
    });
    if (!lease) throw notFound('Lease');
    if (lease.business.ownerUserId !== args.userId) throw forbidden();
    const pending = await tx.leaseChange.findFirst({
      where: { leaseId: lease.id, status: 'PENDING' },
    });
    if (!pending) throw notFound('Pending change');
    const at = clockNow();
    await tx.leaseChange.update({
      where: { id: pending.id },
      data: { status: 'CANCELLED', cancelledAt: at },
    });
    await closeProposedScreening(tx, pending.id, at);
    await recordAudit(tx, {
      actor: { type: 'user', id: args.userId },
      eventType: 'LEASE_CHANGE_CANCELLED',
      subjectType: 'lease',
      subjectId: lease.id,
      payload: { leaseChangeId: pending.id, businessId: lease.businessId, fields: pending.fields },
      at,
    });
    return lease;
  });
}

export type ApplyOutcome = 'applied' | 'blocked_by_screening';

/**
 * Make a pending change take effect: the lease takes the new landlord details and the
 * landlord is screened again as the payee of record. Refuses while the proposed landlord
 * has an open screening hit.
 */
export async function applyLeaseChange(
  ctx: Ctx,
  args: { changeId: string; actor: AuditActor; at: Date; decision?: { reason: string } },
): Promise<ApplyOutcome> {
  const applied = await ctx.db.$transaction(async (tx) => {
    const change = await loadPending(tx, args.changeId);
    const screening = await proposedScreening(tx, change.id);
    if (screening && screening.result !== 'CLEAR' && screening.clearedAt === null) return null;
    const lease = await tx.lease.update({
      where: { id: change.leaseId },
      data: change.changes as Prisma.LeaseUpdateInput,
    });
    await tx.leaseChange.update({
      where: { id: change.id },
      data: {
        status: 'APPLIED',
        appliedAt: args.at,
        ...(args.decision
          ? { decidedBy: args.actor.id, decidedAt: args.at, decisionReason: args.decision.reason }
          : {}),
      },
    });
    await closeProposedScreening(tx, change.id, args.at);
    await recordAudit(tx, {
      actor: args.actor,
      eventType: 'LEASE_CHANGE_APPLIED',
      subjectType: 'lease',
      subjectId: lease.id,
      payload: {
        leaseChangeId: change.id,
        businessId: change.businessId,
        fields: change.fields,
        early: args.decision !== undefined,
        reason: args.decision?.reason ?? 'Cooling-off period ended',
        effectiveOn: change.effectiveOn,
      },
      at: args.at,
    });
    return lease;
  });
  if (!applied) return 'blocked_by_screening';
  await screenLandlord(ctx, applied, { actor: args.actor, at: args.at });
  return 'applied';
}

/** A reviewer approves a pending change before its period ends, or rejects it. */
export async function decideLeaseChange(
  ctx: Ctx,
  args: {
    changeId: string;
    identity: AdminIdentity;
    decision: 'APPROVE' | 'REJECT';
    reason: string;
  },
): Promise<void> {
  const actor: AuditActor = { type: args.identity.role, id: args.identity.actor };
  const at = clockNow();
  if (args.decision === 'APPROVE') {
    const outcome = await applyLeaseChange(ctx, {
      changeId: args.changeId,
      actor,
      at,
      decision: { reason: args.reason },
    });
    if (outcome === 'blocked_by_screening') {
      throw unprocessable(
        'SCREENING_HIT_OPEN',
        'The proposed landlord has an open screening hit. Clear it before approving the change',
      );
    }
    return;
  }
  await ctx.db.$transaction(async (tx) => {
    const change = await loadPending(tx, args.changeId);
    await tx.leaseChange.update({
      where: { id: change.id },
      data: {
        status: 'REJECTED',
        decidedBy: args.identity.actor,
        decidedAt: at,
        decisionReason: args.reason,
      },
    });
    await closeProposedScreening(tx, change.id, at);
    await recordAudit(tx, {
      actor,
      eventType: 'LEASE_CHANGE_REJECTED',
      subjectType: 'lease',
      subjectId: change.leaseId,
      payload: {
        leaseChangeId: change.id,
        businessId: change.businessId,
        fields: change.fields,
        reason: args.reason,
      },
      severity: 'warning',
      at,
    });
  });
}

/** Apply every pending change whose cooling-off period has ended as of `asOf`. */
export async function applyDueLeaseChanges(ctx: Ctx, asOf: IsoDate) {
  const due = await ctx.db.leaseChange.findMany({
    where: { status: 'PENDING', effectiveOn: { lte: asOf } },
    orderBy: { requestedAt: 'asc' },
    select: { id: true },
  });
  const counts = { due: due.length, applied: 0, blockedByScreening: 0 };
  for (const { id } of due) {
    const outcome = await applyLeaseChange(ctx, {
      changeId: id,
      actor: { type: 'job', id: 'lease-changes' },
      at: effectiveAt(asOf),
    });
    if (outcome === 'applied') counts.applied += 1;
    else counts.blockedByScreening += 1;
  }
  return counts;
}

/** Owner wording for a pending landlord change. */
export function pendingChangeMessage(effectiveOn: IsoDate): string {
  return `You asked to change your landlord's details. For your security the change takes effect on ${effectiveOn}, and rent payments to this landlord wait until then. If you did not ask for this, cancel the change and contact support.`;
}

/** Owner wording for a rent increase waiting on a decision. */
export function pendingRentMessage(planRentCents: number, requestedCents: number): string {
  const usd = (c: number) => formatCents(c, { showCents: false });
  return `Your rent went up to ${usd(requestedCents)}, which is more than the ${usd(planRentCents)} a month you are approved for. Rent payments are on hold until you apply for the new amount and it is approved.`;
}

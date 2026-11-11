import { addDays, type IsoDate } from '@cashflow/shared';

import type { Tx } from '../db.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { ACCOUNTS, RECEIVABLE_PREFIX } from '../ledger/accounts.ts';
import { accountBalance, allowanceBalance, trialBalance } from '../ledger/service.ts';
import type { Providers } from '../providers/index.ts';
import { UNPAID } from '../services/delinquency.ts';
import { gatherPoolState } from '../services/portfolio-state.ts';
import { ACTIVE_SERVICING_POLICY } from '../servicing/policy.ts';
import type { MonitoringPolicy } from './policy.ts';
import { ALERTED_EVENT_TYPES } from './rules/events.ts';
import type {
  ApplicationFact,
  BooksFact,
  ExhaustedFact,
  ExposureFact,
  JobFact,
  LeaseChangeFact,
  MonitoringInputs,
  PlanFact,
  RetentionFact,
  ScreeningFact,
} from './types.ts';

/**
 * The thin data layer under the rules: every database read monitoring makes, turned into
 * plain facts. No thresholds and no judgments here; those are the rules'.
 *
 * It loads whole tables in places (plans with their installments, leases, bank links). That
 * is right for a book of hundreds of plans and would want narrowing to aggregates long
 * before a book of hundreds of thousands.
 */

const day = (d: Date): IsoDate => d.toISOString().slice(0, 10);
const dayOrNull = (d: Date | null): IsoDate | null => (d ? day(d) : null);
const startOf = (date: IsoDate) => new Date(`${date}T00:00:00.000Z`);

const OPEN_PLAN = { status: { not: 'CLOSED' as const } };

/** How far back audit events are read for the event alerts. */
export const EVENT_LOOKBACK_DAYS = 90;

export async function leaseChangeFacts(
  tx: Tx,
  where: Prisma.LeaseChangeWhereInput,
): Promise<LeaseChangeFact[]> {
  const rows = await tx.leaseChange.findMany({
    where,
    include: {
      lease: {
        include: {
          business: { select: { legalName: true } },
          rentPlans: {
            where: OPEN_PLAN,
            select: {
              payouts: {
                where: { status: { in: ['SCHEDULED', 'HELD', 'FAILED'] }, returnCode: null },
                orderBy: { scheduledFor: 'asc' },
                select: { id: true, scheduledFor: true, amountCents: true, status: true },
              },
            },
          },
        },
      },
    },
    orderBy: { requestedAt: 'asc' },
  });
  return rows.map((c) => ({
    id: c.id,
    leaseId: c.leaseId,
    businessId: c.businessId,
    businessName: c.lease.business.legalName,
    status: c.status as 'PENDING' | 'APPLIED',
    fields: c.fields,
    requestedOn: day(c.requestedAt),
    effectiveOn: c.effectiveOn,
    appliedOn: dayOrNull(c.appliedAt),
    approvedBy: c.decidedBy,
    upcomingPayouts: c.lease.rentPlans
      .flatMap((p) => p.payouts)
      .sort((a, b) => (a.scheduledFor < b.scheduledFor ? -1 : 1)),
  }));
}

async function applicationFacts(
  tx: Tx,
  asOf: IsoDate,
  policy: MonitoringPolicy,
): Promise<ApplicationFact[]> {
  const window = Math.max(policy.fraud.velocityWindowDays, policy.fraud.reapplyWindowDays);
  const rows = await tx.underwritingApplication.findMany({
    where: {
      OR: [
        { status: { in: ['SUBMITTED', 'IN_REVIEW'] } },
        { createdAt: { gte: startOf(addDays(asOf, -window)) } },
        {
          decisions: {
            some: {
              supersededAt: null,
              outcome: 'DECLINED',
              kind: { not: 'PERIODIC_REVIEW' },
              decidedAt: { gte: startOf(addDays(asOf, -window)) },
            },
          },
        },
      ],
    },
    include: {
      business: { select: { legalName: true, ownerUserId: true } },
      decisions: {
        where: { supersededAt: null, kind: { not: 'PERIODIC_REVIEW' } },
        orderBy: { decidedAt: 'desc' },
        take: 1,
        select: { outcome: true, decidedAt: true },
      },
    },
  });
  return rows.map((a) => ({
    id: a.id,
    businessId: a.businessId,
    businessName: a.business.legalName,
    ownerUserId: a.business.ownerUserId,
    status: a.status,
    createdOn: day(a.createdAt),
    submittedOn: dayOrNull(a.submittedAt),
    declinedOn: a.decisions[0]?.outcome === 'DECLINED' ? day(a.decisions[0].decidedAt) : null,
  }));
}

async function exhaustedFacts(tx: Tx): Promise<ExhaustedFact[]> {
  const max = ACTIVE_SERVICING_POLICY.retry.maxAttempts;
  if (max === null) return [];
  const rows = await tx.installment.findMany({
    where: { status: { in: UNPAID }, payout: { status: 'PAID' }, attemptCount: { gte: max } },
    include: {
      rentPlan: {
        select: {
          id: true,
          businessId: true,
          business: {
            select: {
              legalName: true,
              bankLinks: {
                where: { status: 'LINKED' },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { id: true },
              },
            },
          },
        },
      },
    },
    orderBy: { dueDate: 'asc' },
  });
  const byPlan = new Map<string, ExhaustedFact>();
  for (const i of rows) {
    // Attempts count against the account they were made on. A newly linked account starts
    // again, so an installment that used its attempts on the old one is not exhausted.
    const link = i.rentPlan.business.bankLinks[0]?.id ?? null;
    if (link !== null && i.attemptBankLinkId !== link) continue;
    const fact = byPlan.get(i.rentPlanId) ?? {
      rentPlanId: i.rentPlanId,
      businessId: i.rentPlan.businessId,
      businessName: i.rentPlan.business.legalName,
      installments: 0,
      owedCents: 0,
      oldestDueDate: i.dueDate,
    };
    fact.installments += 1;
    fact.owedCents += i.totalCents;
    byPlan.set(i.rentPlanId, fact);
  }
  return [...byPlan.values()];
}

/** Every plan with its installments, as the portfolio rules and the operator views read it. */
export async function planFacts(tx: Tx): Promise<PlanFact[]> {
  const plans = await tx.rentPlan.findMany({
    include: {
      business: { select: { legalName: true, industry: true } },
      application: {
        select: {
          decisions: {
            where: { supersededAt: null, kind: { not: 'PERIODIC_REVIEW' } },
            orderBy: { decidedAt: 'desc' },
            take: 1,
            select: { snapshot: true },
          },
        },
      },
      payouts: {
        orderBy: { scheduledFor: 'asc' },
        include: { installments: { orderBy: { sequence: 'asc' } } },
      },
    },
  });
  return plans.map((plan) => {
    const paid = plan.payouts.filter((p) => p.status === 'PAID' && p.paidAt !== null);
    const firstPayout = paid[0] ?? null;
    const snapshot = plan.application.decisions[0]?.snapshot as {
      pricing?: { expectedLossBps?: number } | null;
    } | null;
    return {
      planId: plan.id,
      businessId: plan.businessId,
      businessName: plan.business.legalName,
      industry: plan.business.industry,
      status: plan.status,
      monthlyRentCents: plan.monthlyRentCents,
      originatedOn: firstPayout ? day(firstPayout.paidAt!) : null,
      expectedLossBps: snapshot?.pricing?.expectedLossBps ?? null,
      periodsFronted: paid.length,
      frontedCents: paid.reduce((sum, p) => sum + p.amountCents, 0),
      installments: plan.payouts.flatMap((payout) =>
        payout.installments.map((i) => ({
          principalCents: i.principalCents,
          dueDate: i.dueDate,
          status: i.status,
          first: firstPayout !== null && payout.id === firstPayout.id && i.sequence === 1,
          frontedOn: payout.status === 'PAID' ? dayOrNull(payout.paidAt) : null,
          paidOn: i.status === 'PAID' ? dayOrNull(i.paidAt) : null,
          chargedOffOn: dayOrNull(i.chargedOffAt),
        })),
      ),
    };
  });
}

/** Pool capital and committed rent by industry and by business. */
export async function exposureFacts(tx: Tx, providers: Providers): Promise<ExposureFact> {
  const pool = await gatherPoolState(tx, providers);
  const plans = await tx.rentPlan.findMany({
    where: { status: { in: ['ACTIVE', 'PAUSED'] } },
    select: {
      businessId: true,
      monthlyRentCents: true,
      business: { select: { legalName: true, industry: true } },
    },
  });
  const byIndustry = new Map<string, number>();
  const byBusiness = new Map<string, { businessName: string; committedCents: number }>();
  for (const p of plans) {
    byIndustry.set(
      p.business.industry,
      (byIndustry.get(p.business.industry) ?? 0) + p.monthlyRentCents,
    );
    const row = byBusiness.get(p.businessId) ?? {
      businessName: p.business.legalName,
      committedCents: 0,
    };
    row.committedCents += p.monthlyRentCents;
    byBusiness.set(p.businessId, row);
  }
  return {
    capitalCents: pool.cashCents + pool.receivableCents,
    committedCents: pool.committedCents,
    byIndustry: [...byIndustry.entries()].map(([industry, committedCents]) => ({
      industry,
      committedCents,
    })),
    byBusiness: [...byBusiness.entries()].map(([businessId, row]) => ({ businessId, ...row })),
  };
}

async function booksFacts(tx: Tx): Promise<BooksFact> {
  const tb = await trialBalance(tx);
  const [allowanceCents, poolCents, lastCash, lastSweep, triggers] = [
    await allowanceBalance(tx),
    await accountBalance(tx, ACCOUNTS.CAPITAL_POOL),
    await tx.ledgerTransaction.findFirst({
      where: { entries: { some: { account: { code: ACCOUNTS.CASH } } } },
      orderBy: { postedAt: 'desc' },
      select: { postedAt: true },
    }),
    await tx.jobRun.findFirst({
      where: { name: 'collect-installments', ok: true, finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    }),
    await tx.$queryRaw<Array<{ table: string }>>`
      SELECT c.relname AS "table"
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND NOT t.tgisinternal
        AND t.tgenabled <> 'D'
        AND t.tgname = c.relname || '_append_only'
    `,
  ];

  // What each receivable account should hold, from the installments: principal still owed
  // on rent that was fronted, less principal collected on a payout that later came back
  // (that money is the business's, and sits on the account as a credit until refunded).
  const owed = await tx.installment.findMany({
    where: {
      OR: [
        { status: { in: UNPAID }, payout: { status: 'PAID' } },
        { status: 'PAID', payout: { status: 'FAILED', returnCode: { not: null } } },
      ],
    },
    select: {
      principalCents: true,
      status: true,
      rentPlan: { select: { businessId: true } },
      repayments: { where: { status: 'SUCCEEDED', recovery: true }, select: { id: true }, take: 1 },
    },
  });
  const expected = new Map<string, number>();
  for (const i of owed) {
    // A recovery was booked to income, not to the receivable, so it left no credit there.
    if (i.status === 'PAID' && i.repayments.length > 0) continue;
    const sign = i.status === 'PAID' ? -1 : 1;
    expected.set(
      i.rentPlan.businessId,
      (expected.get(i.rentPlan.businessId) ?? 0) + sign * i.principalCents,
    );
  }
  const businesses = await tx.business.findMany({ select: { id: true, legalName: true } });
  const names = new Map(businesses.map((b) => [b.id, b.legalName]));
  const receivables = tb.accounts
    .filter((a) => a.account.code.startsWith(RECEIVABLE_PREFIX))
    .map((a) => {
      const businessId = a.account.code.slice(RECEIVABLE_PREFIX.length);
      return {
        businessId,
        businessName: names.get(businessId) ?? businessId,
        ledgerCents: a.balanceCents,
        expectedCents: expected.get(businessId) ?? 0,
      };
    });
  // Installments that say something is owed with no receivable account at all.
  for (const [businessId, expectedCents] of expected) {
    if (expectedCents !== 0 && !receivables.some((r) => r.businessId === businessId)) {
      receivables.push({
        businessId,
        businessName: names.get(businessId) ?? businessId,
        ledgerCents: 0,
        expectedCents,
      });
    }
  }

  return {
    totalDebitsCents: tb.totalDebitsCents,
    totalCreditsCents: tb.totalCreditsCents,
    cashCents: tb.accounts.find((a) => a.account.code === ACCOUNTS.CASH)?.balanceCents ?? 0,
    lastCashPostingAt: lastCash?.postedAt.toISOString() ?? null,
    lastSweepAt: lastSweep?.finishedAt?.toISOString() ?? null,
    allowanceCents,
    poolCents,
    receivables,
    appendOnlyTriggers: triggers.map((t) => t.table),
  };
}

async function jobFacts(tx: Tx, names: readonly string[], self: string): Promise<JobFact[]> {
  const out: JobFact[] = [];
  // The monitor cannot report on itself: its own run is the one in progress.
  for (const name of names.filter((n) => n !== self)) {
    const lastRun = await tx.jobRun.findFirst({
      where: { name },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
    const lastOk = await tx.jobRun.findFirst({
      where: { name, ok: true },
      orderBy: { asOf: 'desc' },
      select: { asOf: true },
    });
    out.push({
      name,
      lastRun: lastRun ? { asOf: lastRun.asOf, ok: lastRun.ok, error: lastRun.error } : null,
      lastOkAsOf: lastOk?.asOf ?? null,
    });
  }
  return out;
}

async function screeningFacts(tx: Tx): Promise<ScreeningFact[]> {
  const rows = await tx.screeningResult.findMany({
    where: { supersededAt: null },
    include: {
      business: {
        select: {
          legalName: true,
          owners: { select: { id: true } },
          rentPlans: { where: OPEN_PLAN, select: { leaseId: true } },
        },
      },
    },
  });
  return rows.map((s) => {
    const openLeases = new Set(s.business.rentPlans.map((p) => p.leaseId));
    const activeParty =
      s.partyType === 'LANDLORD'
        ? openLeases.has(s.partyRef)
        : openLeases.size > 0 &&
          (s.partyType === 'BUSINESS' || s.business.owners.some((o) => o.id === s.partyRef));
    return {
      id: s.id,
      businessId: s.businessId,
      businessName: s.business.legalName,
      partyType: s.partyType,
      partyRef: s.partyRef,
      result: s.result,
      cleared: s.clearedAt !== null,
      screenedOn: day(s.screenedAt),
      leaseChangeId: s.leaseChangeId,
      activeParty,
    };
  });
}

async function retentionFacts(
  tx: Tx,
  asOf: IsoDate,
  policy: MonitoringPolicy,
): Promise<RetentionFact[]> {
  const from = startOf(addDays(asOf, -Math.round(policy.compliance.retentionMonths * 30.44)));
  const events = await tx.auditEvent.findMany({
    where: { eventType: 'DECISION_MADE', subjectType: 'application', at: { gte: from } },
    orderBy: { at: 'asc' },
    select: { subjectId: true, at: true },
  });
  const first = new Map<string, Date>();
  for (const e of events) if (!first.has(e.subjectId)) first.set(e.subjectId, e.at);
  if (first.size === 0) return [];
  const existing = await tx.underwritingApplication.findMany({
    where: { id: { in: [...first.keys()] } },
    select: { id: true },
  });
  const present = new Set(existing.map((a) => a.id));
  return [...first.entries()].map(([applicationId, at]) => ({
    applicationId,
    decidedOn: day(at),
    exists: present.has(applicationId),
  }));
}

export interface GatherArgs {
  asOf: IsoDate;
  policy: MonitoringPolicy;
  providers: Providers;
  /** Every scheduled job by name, and the name of the job doing the monitoring. */
  jobNames: readonly string[];
  self: string;
}

/** Everything the rules read, as of `asOf`. Queries run one after another on `tx`. */
export async function gatherMonitoringInputs(tx: Tx, args: GatherArgs): Promise<MonitoringInputs> {
  const { asOf, policy } = args;
  const leaseChanges = await leaseChangeFacts(tx, {
    OR: [
      { status: 'PENDING' },
      {
        status: 'APPLIED',
        appliedAt: { gte: startOf(addDays(asOf, -policy.fraud.payoutProximityDays)) },
      },
    ],
  });
  const leases = await tx.lease.findMany({
    where: { status: { not: 'ENDED' } },
    include: {
      business: { select: { legalName: true, ownerUserId: true } },
      rentPlans: { where: OPEN_PLAN, select: { id: true }, take: 1 },
    },
  });
  const bankLinks = await tx.bankLink.findMany({
    where: { status: 'LINKED' },
    include: { business: { select: { legalName: true, dba: true, ownerUserId: true } } },
  });
  const events = await tx.auditEvent.findMany({
    where: {
      eventType: { in: ALERTED_EVENT_TYPES },
      at: { gte: startOf(addDays(asOf, -EVENT_LOOKBACK_DAYS)) },
    },
    orderBy: { at: 'asc' },
  });
  const debitWindow = Math.max(
    policy.payments.returnWindowDays,
    policy.payments.repeatedFailureWindowDays,
  );
  const repayments = await tx.repayment.findMany({
    where: {
      bankLinkId: { not: null },
      createdAt: { gte: startOf(addDays(asOf, -(debitWindow - 1))) },
    },
    select: {
      id: true,
      bankLinkId: true,
      status: true,
      returnCode: true,
      createdAt: true,
      installment: { select: { rentPlanId: true, rentPlan: { select: { businessId: true } } } },
    },
  });
  const businesses = await tx.business.findMany({
    select: {
      id: true,
      legalName: true,
      verificationStatus: true,
      verificationReasons: true,
      rentPlans: { where: OPEN_PLAN, select: { id: true }, take: 1 },
    },
  });

  return {
    asOf,
    leaseChanges,
    landlordAccounts: leases.map((l) => ({
      leaseId: l.id,
      businessId: l.businessId,
      businessName: l.business.legalName,
      ownerUserId: l.business.ownerUserId,
      landlordName: l.landlordName,
      holderName: l.landlordAccountHolderName,
      routingNumber: l.landlordRoutingNumber,
      last4: l.landlordAccountNumberLast4,
      payoutToken: l.landlordPayoutToken,
      hasOpenPlan: l.rentPlans.length > 0,
    })),
    bankAccounts: bankLinks.map((b) => ({
      bankLinkId: b.id,
      businessId: b.businessId,
      businessName: b.business.legalName,
      dba: b.business.dba,
      ownerUserId: b.business.ownerUserId,
      accountToken: b.providerAccountToken,
      mask: b.accountMask,
    })),
    applications: await applicationFacts(tx, asOf, policy),
    auditEvents: events.map((e) => {
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      return {
        id: e.id,
        on: day(e.at),
        eventType: e.eventType,
        subjectType: e.subjectType,
        subjectId: e.subjectId,
        severity: typeof payload.severity === 'string' ? payload.severity : null,
        payload,
      };
    }),
    debits: repayments.map((r) => ({
      id: r.id,
      bankLinkId: r.bankLinkId!,
      rentPlanId: r.installment.rentPlanId,
      businessId: r.installment.rentPlan.businessId,
      on: day(r.createdAt),
      status: r.status,
      returnCode: r.returnCode,
    })),
    exhausted: await exhaustedFacts(tx),
    plans: await planFacts(tx),
    exposure: await exposureFacts(tx, args.providers),
    books: await booksFacts(tx),
    jobs: await jobFacts(tx, args.jobNames, args.self),
    screenings: await screeningFacts(tx),
    identities: businesses.map((b) => ({
      businessId: b.id,
      businessName: b.legalName,
      verificationStatus: b.verificationStatus,
      reasons: b.verificationReasons,
      hasOpenPlan: b.rentPlans.length > 0,
    })),
    retention: await retentionFacts(tx, asOf, policy),
    // The adverse action notice does not exist yet (a later phase stores it). Until it does
    // there is nothing to read, and the rule is off in the policy as well.
    adverseActions: [],
  };
}

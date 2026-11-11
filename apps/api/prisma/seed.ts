/**
 * Demo data. Safe to run repeatedly: it wipes and recreates the demo users' data.
 *
 *   Sign in as demo@cashflow.local / demo-password-123
 *
 * Blue Door Bakery: approved, lease linked, three months of paid history, next period scheduled.
 * Cedar Street Cycles: approved and paying until a month ago, when its debits began to fail.
 *   Today it is in the DELINQUENT bucket and its latest landlord payout is held.
 * Juniper Print Studio: paid one month, then failed the next. Written off at 90 days past
 *   due, plan closed, and one of the two written off installments paid by hand since.
 * Northside Barbers: declined (too new, rent too high relative to revenue).
 * Lakeview Yoga: needs more info (no bank account connected yet).
 *
 * The three plans are built by replaying the jobs one day at a time from the oldest plan's
 * start to today, so the ledger holds real payout, collection, provision, charge-off, and
 * recovery postings, each dated on the day it belongs to.
 */
import { addDays, dueDateInMonth, parseIsoDate, type IsoDate } from '@cashflow/shared';
import pino from 'pino';

import { hashPassword } from '../src/auth/password.ts';
import { loadConfig } from '../src/config.ts';
import { todayIso } from '../src/dates.ts';
import { createDb } from '../src/db.ts';
import type { Industry } from '../src/generated/prisma/enums.ts';
import { runAllJobs } from '../src/jobs/index.ts';
import { ACCOUNTS, ensureSystemAccounts } from '../src/ledger/accounts.ts';
import {
  accountBalance,
  allowanceBalance,
  receivablesBalance,
  trialBalance,
} from '../src/ledger/service.ts';
import { createProviders } from '../src/providers/index.ts';
import { collectInstallment } from '../src/services/collections.ts';
import { delinquencySummary } from '../src/services/provisioning.ts';
import { createRentPlan } from '../src/services/rent-plan.ts';
import { underwriteApplication } from '../src/services/underwriting.ts';
import { ACTIVE_SERVICING_POLICY } from '../src/servicing/policy.ts';

const config = loadConfig();
const log = pino({ level: 'error' });
const db = createDb(config.DATABASE_URL);
const providers = createProviders(config);
const ctx = { config, db, providers, log };

const DEMO_EMAIL = 'demo@cashflow.local';
const DEMO_PASSWORD = 'demo-password-123';
const POOL_CENTS = 25_000_000; // $250,000

function monthsAgo(n: number, from = todayIso()): string {
  const [y, m] = from.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

/** The same day of the month, `n` months earlier. Only used with days 1 to 28. */
function monthsBefore(date: IsoDate, n: number): IsoDate {
  const { year, month, day } = parseIsoDate(date);
  const total = year * 12 + (month - 1) - n;
  return dueDateInMonth(Math.floor(total / 12), (total % 12) + 1, day);
}

const usd = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface PlanSeed {
  legalName: string;
  dba: string;
  industry: Industry;
  addressLine1: string;
  postalCode: string;
  foundedOn: string;
  monthlyRevenueCents: number;
  timeInBusinessMonths: number;
  rentCents: number;
  dueDayOfMonth: number;
  /** The plan is opened as of this date; its first rent date is the next due day. */
  planStart: IsoDate;
  bankToken: string;
  posToken?: string;
  landlordName: string;
  landlordPayoutToken: string;
}

/** A business that is approved on healthy data and opens a plan in the past. */
async function seedPlan(userId: string, seed: PlanSeed) {
  const business = await db.business.create({
    data: {
      ownerUserId: userId,
      legalName: seed.legalName,
      dba: seed.dba,
      industry: seed.industry,
      addressLine1: seed.addressLine1,
      city: 'Portland',
      state: 'OR',
      postalCode: seed.postalCode,
      foundedOn: seed.foundedOn,
      statedMonthlyRevenueCents: seed.monthlyRevenueCents,
      status: 'ACTIVE',
    },
  });
  const bank = await providers.bankLink.exchangePublicToken(seed.bankToken);
  const bankLink = await db.bankLink.create({
    data: {
      businessId: business.id,
      provider: providers.bankLink.name,
      providerItemId: bank.providerItemId,
      providerAccountToken: bank.providerAccountToken,
      institutionName: bank.institutionName,
      accountMask: bank.accountMask,
      availableBalanceCents: bank.availableBalanceCents,
    },
  });
  let commerceLink = null;
  if (seed.posToken) {
    const pos = await providers.commerce.exchangePublicToken(seed.posToken, 'SQUARE');
    commerceLink = await db.commerceLink.create({
      data: {
        businessId: business.id,
        provider: providers.commerce.name,
        platform: pos.platform,
        providerItemId: pos.providerItemId,
        locationName: pos.locationName,
        connectedSince: pos.connectedSince,
      },
    });
  }
  const draft = await db.underwritingApplication.create({
    data: {
      businessId: business.id,
      bankLinkId: bankLink.id,
      commerceLinkId: commerceLink?.id,
      statedMonthlyRevenueCents: seed.monthlyRevenueCents,
      timeInBusinessMonths: seed.timeInBusinessMonths,
      requestedMonthlyRentCents: seed.rentCents,
    },
  });
  const application = await underwriteApplication({
    db,
    providers,
    applicationId: draft.id,
    bankLink,
    commerceLink,
  });
  if (application.status !== 'APPROVED') {
    throw new Error(`Seed expected ${seed.dba} to be approved, got ${application.status}`);
  }
  const lease = await db.lease.create({
    data: {
      businessId: business.id,
      landlordName: seed.landlordName,
      landlordEmail: 'leases@example.com',
      propertyLine1: seed.addressLine1,
      propertyCity: 'Portland',
      propertyState: 'OR',
      propertyPostalCode: seed.postalCode,
      monthlyRentCents: seed.rentCents,
      dueDayOfMonth: seed.dueDayOfMonth,
      startsOn: seed.planStart,
      landlordAccountHolderName: `${seed.landlordName} LLC`,
      landlordRoutingNumber: '123456789',
      landlordAccountNumberLast4: seed.landlordPayoutToken.length.toString().padStart(4, '4'),
      landlordPayoutToken: seed.landlordPayoutToken,
    },
  });
  const plan = await createRentPlan(
    { db, providers },
    {
      userId,
      leaseId: lease.id,
      applicationId: application.id,
      installmentsPerMonth: 2,
      asOf: seed.planStart,
    },
  );
  return { business, bankLink, plan, goodToken: bank.providerAccountToken };
}

async function main() {
  const today = todayIso();
  process.stdout.write(`Seeding demo data as of ${today}\n`);

  // Dates. The bakery and the print studio pay rent on the 1st. The cycle shop's rent day is
  // yesterday's day of the month (the 28th at most), so its latest payout fell due yesterday
  // and is still inside the window in which a held payout can be released.
  const bakeryStart = monthsAgo(3);
  const yesterday = parseIsoDate(addDays(today, -1));
  const cyclesDueDay = Math.min(28, yesterday.day);
  const cyclesLastDue = dueDateInMonth(yesterday.year, yesterday.month, cyclesDueDay);
  const cyclesSecondDue = monthsBefore(cyclesLastDue, 1);
  const cyclesFirstDue = monthsBefore(cyclesLastDue, 2);
  const studioFirstDue = monthsAgo(5);
  const studioSecondDue = monthsAgo(4);
  const studioChargeOff = addDays(
    studioSecondDue,
    ACTIVE_SERVICING_POLICY.chargeOffAfterDays ?? 90,
  );
  const studioRecovery = addDays(studioChargeOff, 10);
  const replayFrom = addDays(studioFirstDue, -3);

  // Start clean so the seed is repeatable.
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "LedgerEntry", "LedgerTransaction", "LedgerAccount",
      "Repayment", "Installment", "LandlordPayout", "RentPlan",
      "Lease", "UnderwritingDecision", "ApplicationReview", "UnderwritingApplication",
      "BankLink", "CommerceLink", "Business", "RefreshToken", "User", "JobRun", "AuditEvent"
    RESTART IDENTITY CASCADE
  `);
  await ensureSystemAccounts(db);
  // The pool was funded before the first plan opened.
  await db.$transaction((tx) =>
    providers.capital.fund(tx, POOL_CENTS, 'Seed: initial capital pool', replayFrom),
  );

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const demo = await db.user.create({
    data: { email: DEMO_EMAIL, passwordHash, fullName: 'Dana Rivera' },
  });

  // ---- Blue Door Bakery: the happy path with history ----
  // It also connects its Square account, so its decision shows two sources.
  await seedPlan(demo.id, {
    legalName: 'Blue Door Bakery LLC',
    dba: 'Blue Door Bakery',
    industry: 'RESTAURANT',
    addressLine1: '412 Pine St',
    postalCode: '97204',
    foundedOn: '2021-03-01',
    monthlyRevenueCents: 6_000_000,
    timeInBusinessMonths: 68,
    rentCents: 1_000_000,
    dueDayOfMonth: 1,
    planStart: bakeryStart,
    bankToken: 'seed_blue_door_healthy_rev_60000_rent_10000',
    posToken: 'seed_blue_door_square_healthy_sales_60000',
    landlordName: 'Harbor View Properties',
    landlordPayoutToken: 'mock_landlord_harbor_view',
  });

  // ---- Cedar Street Cycles: delinquent, with a held payout ----
  // Pays its first period and the first half of its second. Then its debits fail.
  const cycles = await seedPlan(demo.id, {
    legalName: 'Cedar Street Cycles LLC',
    dba: 'Cedar Street Cycles',
    industry: 'RETAIL',
    addressLine1: '1530 SE Cedar St',
    postalCode: '97214',
    foundedOn: '2020-06-01',
    monthlyRevenueCents: 5_200_000,
    timeInBusinessMonths: 60,
    rentCents: 480_000,
    dueDayOfMonth: cyclesDueDay,
    planStart: addDays(cyclesFirstDue, -3),
    bankToken: 'seed_cedar_cycles_healthy_rev_52000_rent_4800',
    landlordName: 'Eastside Commercial',
    landlordPayoutToken: 'mock_landlord_eastside',
  });

  // ---- Juniper Print Studio: charged off, with a partial recovery ----
  // Pays its first period. Both installments of the second fail and are written off.
  const studio = await seedPlan(demo.id, {
    legalName: 'Juniper Print Studio LLC',
    dba: 'Juniper Print Studio',
    industry: 'PROFESSIONAL_SERVICES',
    addressLine1: '77 NW Juniper Ave',
    postalCode: '97209',
    foundedOn: '2019-09-01',
    monthlyRevenueCents: 4_400_000,
    timeInBusinessMonths: 72,
    rentCents: 390_000,
    dueDayOfMonth: 1,
    planStart: addDays(studioFirstDue, -3),
    bankToken: 'seed_juniper_print_healthy_rev_44000_rent_3900',
    landlordName: 'Pearl District Holdings',
    landlordPayoutToken: 'mock_landlord_pearl',
  });

  const setAccountToken = (bankLinkId: string, token: string) =>
    db.bankLink.update({ where: { id: bankLinkId }, data: { providerAccountToken: token } });

  // Replay every day from the oldest plan's start to today. Things that happen to a
  // business on a given day happen before that day's jobs run.
  for (let asOf = replayFrom; asOf <= today; asOf = addDays(asOf, 1)) {
    if (asOf === addDays(cyclesSecondDue, 1)) {
      await setAccountToken(cycles.bankLink.id, 'mock_acct_cedar_fail');
    }
    if (asOf === addDays(studioSecondDue, -1)) {
      await setAccountToken(studio.bankLink.id, 'mock_acct_juniper_fail');
    }
    if (asOf === studioRecovery) {
      // The owner comes back and pays the older of the two written off installments.
      await setAccountToken(studio.bankLink.id, studio.goodToken);
      const owed = await db.installment.findFirstOrThrow({
        where: { rentPlanId: studio.plan.id, status: 'CHARGED_OFF' },
        orderBy: { dueDate: 'asc' },
      });
      const outcome = await collectInstallment(ctx, owed.id, asOf, { manual: true });
      if (outcome !== 'paid') throw new Error(`Seed expected a recovery, got ${outcome}`);
    }
    const result = await runAllJobs(ctx, asOf);
    for (const [name, job] of Object.entries(result)) {
      if (name !== 'asOf' && !(job as { ok: boolean }).ok) {
        throw new Error(
          `Seed: job ${name} failed on ${asOf}: ${(job as { error?: string }).error}`,
        );
      }
    }
  }

  // The stories above are what the demo is for. Fail loudly if the replay told another one.
  const cyclesPlan = await db.rentPlan.findUniqueOrThrow({
    where: { id: cycles.plan.id },
    include: { payouts: { where: { status: 'HELD' } } },
  });
  if (cyclesPlan.delinquencyStatus !== 'DELINQUENT' || cyclesPlan.payouts.length !== 1) {
    throw new Error(
      `Seed expected Cedar Street Cycles to be DELINQUENT with one held payout, got ${cyclesPlan.delinquencyStatus} with ${cyclesPlan.payouts.length}`,
    );
  }
  const studioPlan = await db.rentPlan.findUniqueOrThrow({ where: { id: studio.plan.id } });
  if (studioPlan.status !== 'CLOSED' || studioPlan.delinquencyStatus !== 'CHARGED_OFF') {
    throw new Error(
      `Seed expected Juniper Print Studio to be closed and charged off, got ${studioPlan.status} ${studioPlan.delinquencyStatus}`,
    );
  }

  // ---- Northside Barbers: declined ----
  const barbers = await db.business.create({
    data: {
      ownerUserId: demo.id,
      legalName: 'Northside Barbers Inc',
      industry: 'SALON',
      addressLine1: '88 N Mississippi Ave',
      city: 'Portland',
      state: 'OR',
      postalCode: '97227',
      foundedOn: monthsAgo(7),
      statedMonthlyRevenueCents: 900_000,
    },
  });
  const barbersBank = await providers.bankLink.exchangePublicToken(
    'seed_northside_overdrafts_rev_9000_rent_3500',
  );
  const barbersLink = await db.bankLink.create({
    data: {
      businessId: barbers.id,
      provider: providers.bankLink.name,
      providerItemId: barbersBank.providerItemId,
      providerAccountToken: barbersBank.providerAccountToken,
      institutionName: barbersBank.institutionName,
      accountMask: barbersBank.accountMask,
      availableBalanceCents: barbersBank.availableBalanceCents,
    },
  });
  const barbersDraft = await db.underwritingApplication.create({
    data: {
      businessId: barbers.id,
      bankLinkId: barbersLink.id,
      statedMonthlyRevenueCents: 900_000,
      timeInBusinessMonths: 7,
      requestedMonthlyRentCents: 350_000,
    },
  });
  await underwriteApplication({
    db,
    providers,
    applicationId: barbersDraft.id,
    bankLink: barbersLink,
  });

  // ---- Lakeview Yoga: needs info ----
  const yoga = await db.business.create({
    data: {
      ownerUserId: demo.id,
      legalName: 'Lakeview Yoga Collective LLC',
      dba: 'Lakeview Yoga',
      industry: 'FITNESS',
      addressLine1: '2200 SE Hawthorne Blvd',
      city: 'Portland',
      state: 'OR',
      postalCode: '97214',
      foundedOn: '2022-09-01',
      statedMonthlyRevenueCents: 2_100_000,
    },
  });
  const yogaDraft = await db.underwritingApplication.create({
    data: {
      businessId: yoga.id,
      statedMonthlyRevenueCents: 2_100_000,
      timeInBusinessMonths: 50,
      requestedMonthlyRentCents: 380_000,
    },
  });
  await underwriteApplication({ db, providers, applicationId: yogaDraft.id, bankLink: null });

  const pool = await accountBalance(db, ACCOUNTS.CAPITAL_POOL);
  const fees = await accountBalance(db, ACCOUNTS.FEE_REVENUE);
  const payouts = await db.landlordPayout.count({ where: { status: 'PAID' } });
  const installments = await db.installment.count({ where: { status: 'PAID' } });
  const summary = await delinquencySummary(db, today);
  const tb = await trialBalance(db);
  process.stdout.write(
    [
      `Demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`,
      `Landlord payouts made: ${payouts}, installments collected: ${installments}`,
      `Capital pool: ${usd(pool)}, fee revenue: ${usd(fees)}`,
      `Receivables: ${usd(await receivablesBalance(db))}, allowance: ${usd(await allowanceBalance(db))}`,
      `Charged off: ${usd(summary.chargedOffCents)}, recovered: ${usd(summary.recoveredCents)}, provision expense: ${usd(summary.provisionExpenseCents)}`,
      `Plans by bucket: ${summary.buckets.map((b) => `${b.status} ${b.plans}`).join(', ')}. Held payouts: ${summary.heldPayouts}`,
      `Trial balance: debits ${usd(tb.totalDebitsCents)}, credits ${usd(tb.totalCreditsCents)}, ${tb.balanced ? 'balanced' : 'UNBALANCED'}`,
      '',
    ].join('\n'),
  );
  if (!tb.balanced) throw new Error('Seed failed: the trial balance does not balance');
}

try {
  await main();
} finally {
  await db.$disconnect();
}

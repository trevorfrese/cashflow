/**
 * Demo data. Safe to run repeatedly: it wipes and recreates the demo users' data.
 *
 *   Sign in as demo@cashflow.local / demo-password-123
 *
 * Blue Door Bakery: approved, lease linked, three months of paid history, next period scheduled.
 * Northside Barbers: declined (too new, rent too high relative to revenue).
 * Lakeview Yoga: needs more info (no bank account connected yet).
 */
import { followingDueDate, nextRentDueDate, addDays } from '@cashflow/shared';
import pino from 'pino';

import { hashPassword } from '../src/auth/password.ts';
import { loadConfig } from '../src/config.ts';
import { todayIso } from '../src/dates.ts';
import { createDb } from '../src/db.ts';
import { runAllJobs } from '../src/jobs/index.ts';
import { underwriteApplication } from '../src/services/underwriting.ts';
import { ACCOUNTS, ensureSystemAccounts } from '../src/ledger/accounts.ts';
import { accountBalance } from '../src/ledger/service.ts';
import { createProviders } from '../src/providers/index.ts';
import { createRentPlan } from '../src/services/rent-plan.ts';

const config = loadConfig();
const log = pino({ level: 'warn' });
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

async function main() {
  const today = todayIso();
  process.stdout.write(`Seeding demo data as of ${today}\n`);

  // Start clean so the seed is repeatable.
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "LedgerEntry", "LedgerTransaction", "LedgerAccount",
      "Repayment", "Installment", "LandlordPayout", "RentPlan",
      "Lease", "UnderwritingDecision", "UnderwritingApplication", "BankLink",
      "Business", "RefreshToken", "User", "JobRun"
    RESTART IDENTITY CASCADE
  `);
  await ensureSystemAccounts(db);
  await db.$transaction((tx) =>
    providers.capital.fund(tx, POOL_CENTS, 'Seed: initial capital pool'),
  );

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const demo = await db.user.create({
    data: { email: DEMO_EMAIL, passwordHash, fullName: 'Dana Rivera' },
  });

  // ---- Blue Door Bakery: the happy path with history ----
  const bakery = await db.business.create({
    data: {
      ownerUserId: demo.id,
      legalName: 'Blue Door Bakery LLC',
      dba: 'Blue Door Bakery',
      industry: 'RESTAURANT',
      addressLine1: '412 Pine St',
      city: 'Portland',
      state: 'OR',
      postalCode: '97204',
      foundedOn: '2021-03-01',
      statedMonthlyRevenueCents: 6_000_000,
      status: 'ACTIVE',
    },
  });
  const bakeryBank = await providers.bankLink.exchangePublicToken(
    'seed_blue_door_healthy_rev_60000_rent_10000',
  );
  const bakeryLink = await db.bankLink.create({
    data: {
      businessId: bakery.id,
      provider: providers.bankLink.name,
      providerItemId: bakeryBank.providerItemId,
      providerAccountToken: bakeryBank.providerAccountToken,
      institutionName: bakeryBank.institutionName,
      accountMask: bakeryBank.accountMask,
      availableBalanceCents: bakeryBank.availableBalanceCents,
    },
  });
  const bakeryDraft = await db.underwritingApplication.create({
    data: {
      businessId: bakery.id,
      bankLinkId: bakeryLink.id,
      statedMonthlyRevenueCents: 6_000_000,
      timeInBusinessMonths: 68,
      requestedMonthlyRentCents: 1_000_000,
    },
  });
  const bakeryApp = await underwriteApplication({
    db,
    providers,
    applicationId: bakeryDraft.id,
    bankLink: bakeryLink,
  });
  if (bakeryApp.status !== 'APPROVED') {
    throw new Error(`Seed expected Blue Door Bakery to be approved, got ${bakeryApp.status}`);
  }
  const planStart = monthsAgo(3);
  const bakeryLease = await db.lease.create({
    data: {
      businessId: bakery.id,
      landlordName: 'Harbor View Properties',
      landlordEmail: 'leases@harborview.example.com',
      propertyLine1: '412 Pine St',
      propertyCity: 'Portland',
      propertyState: 'OR',
      propertyPostalCode: '97204',
      monthlyRentCents: 1_000_000,
      dueDayOfMonth: 1,
      startsOn: planStart,
      landlordAccountHolderName: 'Harbor View Properties LLC',
      landlordRoutingNumber: '123456789',
      landlordAccountNumberLast4: '4321',
      landlordPayoutToken: 'mock_landlord_harbor_view',
    },
  });
  await createRentPlan(db, {
    userId: demo.id,
    leaseId: bakeryLease.id,
    applicationId: bakeryApp.id,
    installmentsPerMonth: 2,
    asOf: planStart,
  });

  // Replay history: run the jobs on each due date and each second-installment date up to today.
  let due = nextRentDueDate(1, planStart);
  const replayDates: string[] = [];
  while (due <= today) {
    replayDates.push(due, addDays(due, 14));
    due = followingDueDate(due, 1);
  }
  for (const asOf of replayDates.filter((d) => d <= today).sort()) {
    await runAllJobs(ctx, asOf);
  }
  await runAllJobs(ctx, today);

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
  process.stdout.write(
    [
      `Demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`,
      `Landlord payouts made: ${payouts}, installments collected: ${installments}`,
      `Capital pool: ${(pool / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}, fee revenue: ${(fees / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })}`,
      '',
    ].join('\n'),
  );
}

try {
  await main();
} finally {
  await db.$disconnect();
}

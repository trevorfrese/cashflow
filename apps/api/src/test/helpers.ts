import type { FastifyInstance, InjectOptions } from 'fastify';

import { buildApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { createDb, type Db } from '../db.ts';
import { ensureSystemAccounts } from '../ledger/accounts.ts';
import type { MockPaymentsProvider } from '../providers/payments/mock.ts';
import { createProviders, type Providers } from '../providers/index.ts';

export interface TestHarness {
  app: FastifyInstance;
  db: Db;
  providers: Providers;
  payments: MockPaymentsProvider;
  close: () => Promise<void>;
}

/**
 * Builds the app against the test database. `env` overrides single variables for one suite,
 * for example `{ ENABLE_DEV_TOOLS: 'true' }`.
 */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestHarness> {
  const config = loadConfig({ ...process.env, ...env });
  const db = createDb(config.DATABASE_URL);
  const providers = createProviders(config);
  const app = await buildApp({ config, db, providers, logger: false });
  await app.ready();
  return {
    app,
    db,
    providers,
    payments: providers.payments as MockPaymentsProvider,
    close: async () => {
      await app.close();
      await db.$disconnect();
    },
  };
}

/** Empties every table and recreates the system ledger accounts. */
export async function resetDb(db: Db): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE
      "LedgerEntry", "LedgerTransaction", "LedgerAccount",
      "Repayment", "Installment", "LandlordPayout", "RentPlan",
      "Lease", "UnderwritingDecision", "ApplicationReview", "UnderwritingApplication",
      "BankLink", "CommerceLink", "BeneficialOwner", "ScreeningResult", "LeaseChange",
      "Business", "RefreshToken", "User", "JobRun", "AuditEvent", "Alert", "CircuitBreaker",
      "DataSnapshot", "ConnectionAuthorization", "PassThroughPeriod", "GraduationOffer",
      "LandlordDisbursement", "AdverseActionNotice"
    RESTART IDENTITY CASCADE
  `);
  await ensureSystemAccounts(db);
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/** Thin wrapper over app.inject that sends JSON and parses JSON. */
export function client(
  app: FastifyInstance,
  session?: Session,
  extraHeaders: Record<string, string> = {},
) {
  const call = async <T = unknown>(
    method: InjectOptions['method'],
    url: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> => {
    const res = await app.inject({
      method,
      url,
      payload: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
        ...extraHeaders,
      },
    });
    const text = res.body;
    return { status: res.statusCode, body: (text ? JSON.parse(text) : null) as T };
  };
  return {
    get: <T = unknown>(url: string) => call<T>('GET', url),
    post: <T = unknown>(url: string, body?: unknown) => call<T>('POST', url, body),
    patch: <T = unknown>(url: string, body?: unknown) => call<T>('PATCH', url, body),
  };
}

/** The person the suites act as on operator routes, unless a test names another. */
export const TEST_ACTOR = 'test-operator@cashflow.example';

/**
 * A client for the operator routes: the bearer token for the role and the X-Admin-Actor
 * header naming who is acting. The tokens are set in `setup-env.ts`.
 */
export function adminClient(
  app: FastifyInstance,
  options: { role?: 'admin' | 'reviewer'; actor?: string } = {},
) {
  const token =
    (options.role ?? 'admin') === 'admin'
      ? process.env.ADMIN_API_TOKEN
      : process.env.REVIEWER_API_TOKEN;
  return client(app, undefined, {
    authorization: `Bearer ${token}`,
    'x-admin-actor': options.actor ?? TEST_ACTOR,
  });
}

/** Add capital to the pool through the operator route. */
export async function fundPool(app: FastifyInstance, amountCents: number): Promise<void> {
  const res = await adminClient(app).post('/v1/admin/capital/fund', {
    amountCents,
    description: 'test funding',
  });
  if (res.status !== 200) throw new Error(`fund failed: ${res.status} ${JSON.stringify(res.body)}`);
}

let counter = 0;

export async function registerUser(
  app: FastifyInstance,
  overrides: { email?: string } = {},
): Promise<Session> {
  counter += 1;
  const res = await client(app).post<{
    user: { id: string };
    tokens: { accessToken: string; refreshToken: string };
  }>('/v1/auth/register', {
    email: overrides.email ?? `owner${counter}-${Date.now()}@example.com`,
    password: 'a-long-test-password',
    fullName: 'Test Owner',
  });
  if (res.status !== 201)
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    accessToken: res.body.tokens.accessToken,
    refreshToken: res.body.tokens.refreshToken,
    userId: res.body.user.id,
  };
}

export const demoBusiness = {
  legalName: 'Blue Door Bakery LLC',
  dba: 'Blue Door Bakery',
  industry: 'RESTAURANT',
  address: { line1: '412 Pine St', city: 'Portland', state: 'OR', postalCode: '97204' },
  foundedOn: '2021-03-01',
  statedMonthlyRevenueCents: 4_800_000,
  taxIdLast4: '4821',
  owners: [{ fullName: 'Dana Rivera', title: 'Owner', ownershipBps: 10_000 }],
};

export const demoLease = (businessId: string, overrides: Record<string, unknown> = {}) => ({
  businessId,
  landlordName: 'Harbor View Properties',
  landlordEmail: 'leases@harborview.example.com',
  propertyAddress: { line1: '412 Pine St', city: 'Portland', state: 'OR', postalCode: '97204' },
  monthlyRentCents: 620_000,
  dueDayOfMonth: 1,
  startsOn: '2026-01-01',
  landlordPayout: {
    accountHolderName: 'Harbor View Properties LLC',
    routingNumber: '123456789',
    accountNumberLast4: '4321',
    providerToken: 'mock_landlord_harbor',
  },
  ...overrides,
});

/**
 * Walks a fresh user through approval and returns ids needed to build a plan. Pass a
 * different `bankToken` for a second business in one test: the same token is the same bank
 * account, which the integrity checks refer.
 */
export async function approvedBusiness(
  app: FastifyInstance,
  session: Session,
  options: { bankToken?: string; business?: Record<string, unknown> } = {},
) {
  const api = client(app, session);
  const business = await api.post<{ id: string }>('/v1/businesses', {
    ...demoBusiness,
    ...options.business,
  });
  const bankLink = await api.post<{ id: string }>('/v1/bank-links', {
    businessId: business.body.id,
    publicToken: options.bankToken ?? 'mock_healthy_rev_48000_rent_6200',
  });
  const application = await api.post<{ id: string }>('/v1/underwriting/applications', {
    businessId: business.body.id,
    statedMonthlyRevenueCents: demoBusiness.statedMonthlyRevenueCents,
    timeInBusinessMonths: 36,
    requestedMonthlyRentCents: 620_000,
    bankLinkId: bankLink.body.id,
  });
  const submitted = await api.post<{
    status: string;
    decision: { feeBps: number; approvedMonthlyLimitCents: number };
  }>(`/v1/underwriting/applications/${application.body.id}/submit`);
  if (submitted.body.status !== 'APPROVED') {
    throw new Error(`expected approval, got ${JSON.stringify(submitted.body)}`);
  }
  return {
    businessId: business.body.id,
    bankLinkId: bankLink.body.id,
    applicationId: application.body.id,
    decision: submitted.body.decision,
  };
}

/**
 * A rent due day that falls today or within the next three days, and the date it falls on.
 * Days after the 28th are skipped so the same day exists in every month.
 */
export function soonDue(today: string = new Date().toISOString().slice(0, 10)): {
  dueDay: number;
  date: string;
} {
  for (let i = 0; i < 4; i++) {
    const date = new Date(`${today}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + i);
    if (date.getUTCDate() <= 28) {
      return { dueDay: date.getUTCDate(), date: date.toISOString().slice(0, 10) };
    }
  }
  throw new Error('unreachable: four consecutive days always include one on or before the 28th');
}

/** Run jobs through the operator route: all of them, or one by name. */
export async function runJobsAsOf(app: FastifyInstance, asOf: string, only?: string) {
  const res = await adminClient(app).post<Record<string, { ok: boolean; error?: string }>>(
    '/v1/admin/jobs/run',
    { asOf, ...(only ? { only } : {}) },
  );
  if (res.status !== 200) throw new Error(`jobs failed: ${res.status} ${JSON.stringify(res.body)}`);
  for (const [name, job] of Object.entries(res.body)) {
    if (name !== 'asOf' && !job.ok) throw new Error(`job ${name} failed on ${asOf}: ${job.error}`);
  }
  return res.body;
}

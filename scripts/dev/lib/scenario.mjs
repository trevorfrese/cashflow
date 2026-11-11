// The commands that mirror the dev menu: personas, sessions, the clock, resets, and the
// scripted happy path. Everything goes over HTTP to the running API, as the app would.
import { ENV_FILES, resolveConfig } from './config.mjs';
import { liveState } from './status.mjs';
import { DevError, http, readEnvFile, rel } from './util.mjs';

export function apiBase(env = process.env) {
  return liveState()?.config.urls.api ?? resolveConfig(env).urls.api;
}

const describe = (res) =>
  res.status === 0
    ? `no response (${res.error ?? 'connection failed'})`
    : `HTTP ${res.status} ${res.body ? JSON.stringify(res.body) : res.text.slice(0, 400)}`;

/** Calls a dev route. Turns the two predictable failures into instructions. */
export async function dev(pathname, { method = 'GET', body, env, timeoutMs = 120_000 } = {}) {
  const base = apiBase(env);
  const res = await http(`${base}/v1/dev${pathname}`, { method, body, timeoutMs });
  if (res.status === 0) {
    throw new DevError(
      `The API is not reachable at ${base}.`,
      'Start it with ./dev (or ./dev --only api), then try again. ./dev status shows what is running.',
    );
  }
  if (res.status === 404 && res.body?.error?.code === 'NOT_FOUND') {
    throw new DevError(
      `The API at ${base} is running without dev tools, so /v1/dev${pathname} does not exist.`,
      `Set ENABLE_DEV_TOOLS=true in ${rel(ENV_FILES.api)} and restart the API (./dev stop, then ./dev).`,
    );
  }
  if (!res.ok) {
    const message = res.body?.error?.message ?? describe(res);
    const err = new DevError(message, `${method} /v1/dev${pathname} answered ${res.status}.`);
    err.response = res;
    throw err;
  }
  return res.body;
}

// ---- Smoke: the happy path, scripted ----

class StepFailed extends Error {
  constructor(step, detail, response) {
    super(`${step}: ${detail}`);
    this.step = step;
    this.detail = detail;
    this.response = response;
  }
}

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (date, days) => {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};

/**
 * Walks a fresh applicant from nothing to a paid landlord and collected installments, then
 * checks the books. Returns `{ ok, steps, clock }`. Each step is `{ name, ok, ms, detail }`.
 * On a failure the last step carries the failing response. Moves the simulated clock
 * forward to the last installment date; pass `reset` to rebuild the demo data afterwards.
 */
export async function runSmoke({
  env = process.env,
  reset = false,
  onStep = () => undefined,
} = {}) {
  const base = apiBase(env);
  const steps = [];
  let session = null;

  const call = async (
    step,
    method,
    pathname,
    { body, expect = [200, 201], auth = true, headers = {} } = {},
  ) => {
    const res = await http(`${base}${pathname}`, {
      method,
      body,
      timeoutMs: 120_000,
      headers: {
        ...(auth && session ? { authorization: `Bearer ${session.tokens.accessToken}` } : {}),
        ...headers,
      },
    });
    if (!expect.includes(res.status)) {
      throw new StepFailed(step, `${method} ${pathname} answered ${describe(res)}`, {
        status: res.status,
        body: res.body ?? res.text,
      });
    }
    return res.body;
  };
  const step = async (name, fn) => {
    const began = Date.now();
    try {
      const detail = await fn();
      const done = { name, ok: true, ms: Date.now() - began, detail: detail ?? '' };
      steps.push(done);
      onStep(done);
    } catch (err) {
      const failed = {
        name,
        ok: false,
        ms: Date.now() - began,
        detail: err instanceof StepFailed ? err.detail : String(err.message ?? err),
        response: err instanceof StepFailed ? err.response : undefined,
      };
      steps.push(failed);
      onStep(failed);
      throw err;
    }
  };
  const check = (name, condition, detail, response) => {
    if (!condition) throw new StepFailed(name, detail, response);
  };

  let clockStart = null;
  let clockEnd = null;
  const ids = {};
  try {
    await step('API is healthy', async () => {
      const health = await call('health', 'GET', '/health', { auth: false });
      check('health', health?.ok === true, 'GET /health did not answer ok: true', health);
      return `providers: ${Object.values(health.providers).join(', ')}`;
    });

    await step('Dev tools are on, clock read', async () => {
      const clock = await call('clock', 'GET', '/v1/dev/clock', { auth: false });
      clockStart = clock.today;
      return `today is ${clock.today}${clock.aheadDays > 0 ? ` (${clock.aheadDays} days ahead)` : ''}`;
    });

    let walk = null;
    await step('Fresh applicant account (persona fresh-approved, rebuilt)', async () => {
      session = await call('persona', 'POST', '/v1/dev/personas/fresh-approved/reset', {
        auth: false,
      });
      walk = session.persona.walkthrough;
      check(
        'persona',
        walk && walk.outcome === 'APPROVED',
        'fresh-approved has no approved preset',
        session.persona,
      );
      const businesses = await call('persona', 'GET', '/v1/businesses');
      check(
        'persona',
        businesses.length === 0,
        'the fresh account already owns a business',
        businesses,
      );
      return session.user.email;
    });

    await step('Business profile created', async () => {
      const business = await call('business', 'POST', '/v1/businesses', { body: walk.business });
      ids.businessId = business.id;
      return business.legalName;
    });

    await step('Healthy sandbox bank connected', async () => {
      const link = await call('bank', 'POST', '/v1/bank-links', {
        body: { businessId: ids.businessId, publicToken: walk.bankPublicToken },
      });
      ids.bankLinkId = link.id;
      return `${link.institutionName} ending ${link.accountMask}`;
    });

    await step('Healthy sandbox point of sale connected', async () => {
      const dollars = Math.round(walk.business.statedMonthlyRevenueCents / 100);
      const link = await call('pos', 'POST', '/v1/commerce-links', {
        body: {
          businessId: ids.businessId,
          platform: 'SQUARE',
          publicToken: `mock_square_healthy_sales_${dollars}_dev_walk`,
        },
      });
      ids.commerceLinkId = link.id;
      return link.locationName;
    });

    let decision = null;
    await step('Application submitted and approved', async () => {
      const draft = await call('application', 'POST', '/v1/underwriting/applications', {
        body: {
          businessId: ids.businessId,
          statedMonthlyRevenueCents: walk.business.statedMonthlyRevenueCents,
          timeInBusinessMonths: walk.timeInBusinessMonths,
          requestedMonthlyRentCents: walk.requestedMonthlyRentCents,
          bankLinkId: ids.bankLinkId,
          commerceLinkId: ids.commerceLinkId,
        },
      });
      const decided = await call(
        'application',
        'POST',
        `/v1/underwriting/applications/${draft.id}/submit`,
      );
      check(
        'application',
        decided.status === 'APPROVED',
        `expected APPROVED, got ${decided.status}`,
        decided,
      );
      ids.applicationId = decided.id;
      decision = decided.decision;
      check(
        'application',
        decision.approvedMonthlyLimitCents >= walk.requestedMonthlyRentCents,
        `approved for ${decision.approvedMonthlyLimitCents} cents, below the ${walk.requestedMonthlyRentCents} requested`,
        decided,
      );
      return `limit ${decision.approvedMonthlyLimitCents} cents a month, fee ${decision.feeBps} bps, grade ${decision.grade}`;
    });

    // Rent falls due tomorrow on the simulated calendar (skipping the 29th to 31st, which
    // not every month has), so the first period is scheduled as soon as the plan opens.
    let dueDate = addDays(clockStart, 1);
    while (Number(dueDate.slice(8, 10)) > 28) dueDate = addDays(dueDate, 1);

    await step('Lease linked', async () => {
      const lease = await call('lease', 'POST', '/v1/leases', {
        body: {
          businessId: ids.businessId,
          landlordName: 'Foster Road Properties',
          landlordEmail: 'leases@example.com',
          propertyAddress: walk.business.address,
          monthlyRentCents: walk.requestedMonthlyRentCents,
          dueDayOfMonth: Number(dueDate.slice(8, 10)),
          startsOn: clockStart,
          landlordPayout: {
            accountHolderName: 'Foster Road Properties LLC',
            routingNumber: '123456789',
            accountNumberLast4: '4417',
            providerToken: 'mock_landlord_foster_road',
          },
        },
      });
      ids.leaseId = lease.id;
      return `${lease.monthlyRentCents} cents due on day ${lease.dueDayOfMonth}`;
    });

    let installments = [];
    await step('Rent plan started', async () => {
      const plan = await call('plan', 'POST', '/v1/rent-plans', {
        body: { leaseId: ids.leaseId, applicationId: ids.applicationId, installmentsPerMonth: 2 },
      });
      ids.planId = plan.id;
      const detail = await call('plan', 'GET', `/v1/rent-plans/${plan.id}`);
      check(
        'plan',
        detail.nextPayout?.scheduledFor === dueDate,
        `expected the first payout on ${dueDate}`,
        detail,
      );
      installments = await call('plan', 'GET', `/v1/rent-plans/${plan.id}/installments`);
      check(
        'plan',
        installments.length === 2,
        `expected 2 installments, got ${installments.length}`,
        installments,
      );
      return `landlord payout scheduled for ${dueDate}, installments due ${installments.map((i) => i.dueDate).join(' and ')}`;
    });

    await step(`Clock advanced to the due date (${dueDate})`, async () => {
      const result = await call('advance', 'POST', '/v1/dev/clock/advance', {
        body: { toDate: dueDate },
        auth: false,
      });
      check(
        'advance',
        result.jobFailures.length === 0,
        'a job failed during the advance',
        result.jobFailures,
      );
      clockEnd = result.to;
      return result.changes.slice(0, 3).join('; ');
    });

    await step('Landlord paid in full', async () => {
      const payouts = await call('payout', 'GET', `/v1/rent-plans/${ids.planId}/payouts`);
      const payout = payouts.find((p) => p.scheduledFor === dueDate);
      check(
        'payout',
        payout?.status === 'PAID',
        `expected the payout to be PAID, got ${payout?.status}`,
        payouts,
      );
      check(
        'payout',
        payout.amountCents === walk.requestedMonthlyRentCents,
        `expected ${walk.requestedMonthlyRentCents} cents to the landlord, got ${payout.amountCents}`,
        payout,
      );
      return `${payout.amountCents} cents on ${dueDate}`;
    });

    const lastDue = installments
      .map((i) => i.dueDate)
      .sort()
      .at(-1);
    await step(`Clock advanced to the last installment (${lastDue})`, async () => {
      if (lastDue <= clockEnd) return 'already there';
      const result = await call('advance', 'POST', '/v1/dev/clock/advance', {
        body: { toDate: lastDue },
        auth: false,
      });
      check(
        'advance',
        result.jobFailures.length === 0,
        'a job failed during the advance',
        result.jobFailures,
      );
      clockEnd = result.to;
      return `${result.days} days, ${result.summary.installmentsCollected} installments collected across the book`;
    });

    await step('Installments collected', async () => {
      const after = await call('installments', 'GET', `/v1/rent-plans/${ids.planId}/installments`);
      const mine = after.filter((i) => installments.some((x) => x.id === i.id));
      check(
        'installments',
        mine.length === 2 && mine.every((i) => i.status === 'PAID'),
        `expected both installments PAID, got ${mine.map((i) => i.status).join(', ')}`,
        mine,
      );
      const plan = await call('installments', 'GET', `/v1/rent-plans/${ids.planId}`);
      check(
        'installments',
        plan.delinquencyStatus === 'CURRENT',
        `plan is ${plan.delinquencyStatus}`,
        plan,
      );
      return `${mine.reduce((sum, i) => sum + i.totalCents, 0)} cents repaid, plan current`;
    });

    await step('Trial balance balances (operator API)', async () => {
      const token = env.ADMIN_API_TOKEN ?? readEnvFile(ENV_FILES.api).ADMIN_API_TOKEN;
      check(
        'ledger',
        Boolean(token),
        `no ADMIN_API_TOKEN in the environment or in ${rel(ENV_FILES.api)}`,
      );
      const tb = await call('ledger', 'GET', '/v1/admin/ledger/trial-balance', {
        auth: false,
        headers: { authorization: `Bearer ${token}`, 'x-admin-actor': 'dev-smoke' },
      });
      check('ledger', tb.balanced === true, 'the trial balance does not balance', {
        totalDebitsCents: tb.totalDebitsCents,
        totalCreditsCents: tb.totalCreditsCents,
      });
      return `debits ${tb.totalDebitsCents} = credits ${tb.totalCreditsCents} cents`;
    });

    if (reset) {
      await step('Demo data rebuilt, clock back on the real date', async () => {
        const result = await call('reset', 'POST', '/v1/dev/reset', { auth: false });
        clockEnd = result.clock.today;
        return `${result.seconds.toFixed(1)}s`;
      });
    }
    return { ok: true, steps, clock: { from: clockStart, to: clockEnd }, ids };
  } catch (err) {
    if (!(err instanceof StepFailed) && steps.every((s) => s.ok)) throw err;
    return { ok: false, steps, clock: { from: clockStart, to: clockEnd }, ids };
  }
}

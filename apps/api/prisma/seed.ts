/**
 * Demo data. Safe to run repeatedly: it wipes the database and rebuilds every persona.
 *
 *   Sign in as demo@cashflow.local / demo-password-123
 *
 * The personas, what each demonstrates, and how each is built are in `src/dev/personas.ts`.
 * Each is its own login with the same password:
 *
 *   demo@cashflow.local             Blue Door Bakery: active plan, three months of history
 *   delinquent@cashflow.local       Cedar Street Cycles: delinquent, landlord payout held
 *   charged-off@cashflow.local      Juniper Print Studio: written off, one payment recovered
 *   landlord-change@cashflow.local  Alder & Ash Florist: payout change in cooling-off, payout held
 *   declined@cashflow.local         Northside Barbers: declined for overdrafts
 *   needs-info@cashflow.local       Lakeview Yoga: no bank connected
 *   manual-review@cashflow.local    Tidewater Sign Works: referred 34 days ago, never reviewed
 *   identity-review@cashflow.local  Meridian Supply: possible watchlist match
 *   counter-offer@cashflow.local    Sellwood Books: approved for less than the lease rent
 *   fresh-*@cashflow.local          four logins with nothing created, for walking onboarding
 *
 * The work is in `src/dev/seed.ts`, which `POST /v1/dev/reset` also calls.
 */
import pino from 'pino';

import { loadConfig } from '../src/config.ts';
import { createDb } from '../src/db.ts';
import { seedDemoData } from '../src/dev/seed.ts';
import { createProviders } from '../src/providers/index.ts';

const config = loadConfig();
const log = pino({ level: 'error' });
const db = createDb(config.DATABASE_URL);
const providers = createProviders(config);

try {
  process.stdout.write('Seeding demo data\n');
  const summary = await seedDemoData({ config, db, providers, log });
  process.stdout.write(`As of ${summary.today}\n${summary.lines.join('\n')}\n`);
} finally {
  await db.$disconnect();
}

/**
 * Demo data. Safe to run repeatedly: it wipes the database and rebuilds every persona.
 *
 *   Sign in as demo@cashflow.local / demo-password-123
 *
 * The personas, what each demonstrates, and how each is built are in `src/dev/personas.ts`,
 * and listed in AGENTS.md. Each is its own login with the same password: `demo@cashflow.local`
 * for the active plan, `<key>@cashflow.local` for the rest (`./dev personas` prints them).
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

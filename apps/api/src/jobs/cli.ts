/**
 * One-off job runner for cron, demos, and tests.
 *
 *   pnpm --filter @cashflow/api job:run                 # as of today
 *   pnpm --filter @cashflow/api job:run --as-of 2026-12-01
 *   pnpm --filter @cashflow/api job:run --only reunderwrite     # one job by name
 */
import { parseIsoDate } from '@cashflow/shared';
import pino from 'pino';

import { loadConfig } from '../config.ts';
import { todayIso } from '../dates.ts';
import { createDb } from '../db.ts';
import { createProviders } from '../providers/index.ts';
import { JOBS, runAllJobs, type JobName } from './index.ts';

function readAsOf(argv: string[]): string {
  const idx = argv.indexOf('--as-of');
  if (idx === -1) return todayIso();
  const value = argv[idx + 1];
  if (!value) throw new Error('--as-of needs a YYYY-MM-DD value');
  parseIsoDate(value);
  return value;
}

function readOnly(argv: string[]): JobName | null {
  const idx = argv.indexOf('--only');
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (!value || !(value in JOBS)) {
    throw new Error(`--only needs one of: ${Object.keys(JOBS).join(', ')}`);
  }
  return value as JobName;
}

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const db = createDb(config.DATABASE_URL);
const providers = createProviders(config);

try {
  const argv = process.argv.slice(2);
  const ctx = { config, db, providers, log };
  const only = readOnly(argv);
  const result = only
    ? await JOBS[only](ctx, readAsOf(argv))
    : await runAllJobs(ctx, readAsOf(argv));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await db.$disconnect();
}

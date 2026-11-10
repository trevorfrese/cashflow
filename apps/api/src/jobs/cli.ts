/**
 * One-off job runner for cron, demos, and tests.
 *
 *   pnpm --filter @cashflow/api job:run                 # as of today
 *   pnpm --filter @cashflow/api job:run --as-of 2026-12-01
 */
import { parseIsoDate } from '@cashflow/shared';
import pino from 'pino';

import { loadConfig } from '../config.ts';
import { todayIso } from '../dates.ts';
import { createDb } from '../db.ts';
import { createProviders } from '../providers/index.ts';
import { runAllJobs } from './index.ts';

function readAsOf(argv: string[]): string {
  const idx = argv.indexOf('--as-of');
  if (idx === -1) return todayIso();
  const value = argv[idx + 1];
  if (!value) throw new Error('--as-of needs a YYYY-MM-DD value');
  parseIsoDate(value);
  return value;
}

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL });
const db = createDb(config.DATABASE_URL);
const providers = createProviders(config);

try {
  const result = await runAllJobs({ config, db, providers, log }, readAsOf(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await db.$disconnect();
}

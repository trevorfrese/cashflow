// Runs once before the integration project. Rebuilds the dedicated test database from the
// current migrations: drop the schema, recreate it, and apply migrations with `migrate deploy`.
import 'dotenv/config';
import { execSync } from 'node:child_process';

import pg from 'pg';

export default async function globalSetup() {
  const testUrl =
    process.env.DATABASE_URL_TEST ?? 'postgresql://cashflow:cashflow@localhost:5432/cashflow_test';
  if (!/_test\b/.test(testUrl)) {
    throw new Error(`Refusing to reset a non-test database: ${testUrl}`);
  }

  const client = new pg.Client({ connectionString: testUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: testUrl },
  });
}

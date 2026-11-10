// Runs in every integration test worker before the test file. Points the app at the test
// database and fills in the minimum config so loadConfig() succeeds without a real .env.
import 'dotenv/config';

const testUrl =
  process.env.DATABASE_URL_TEST ?? 'postgresql://cashflow:cashflow@localhost:5432/cashflow_test';
if (!/_test\b/.test(testUrl)) {
  throw new Error(`Refusing to run integration tests against a non-test database: ${testUrl}`);
}
process.env.DATABASE_URL = testUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-secret-not-for-production-use';
process.env.ENABLE_ADMIN = 'true';
process.env.JOBS_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.UNDERWRITING_PROVIDER = 'mock';
process.env.BANK_LINK_PROVIDER = 'mock';
process.env.PAYMENTS_PROVIDER = 'mock';
process.env.CAPITAL_PROVIDER = 'mock';

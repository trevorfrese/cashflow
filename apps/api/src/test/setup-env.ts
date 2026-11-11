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
process.env.IDENTITY_PROVIDER = 'mock';
// Operator tokens for the suites. Not secrets: they exist only in the test process.
process.env.ADMIN_API_TOKEN = 'test-admin-token-0123456789abcdef0123456789';
process.env.REVIEWER_API_TOKEN = 'test-reviewer-token-0123456789abcdef01234';
// Rate limiting is off so hundreds of requests from one address do not trip it. The tests
// that cover it build their own app with it on.
process.env.RATE_LIMIT_ENABLED = 'false';

import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.ts';

const base = {
  DATABASE_URL: 'postgresql://cashflow:cashflow@localhost:5432/cashflow',
  JWT_SECRET: 'unit-test-secret-not-for-production',
};

describe('ENABLE_DEV_TOOLS', () => {
  it('is off unless the environment turns it on', () => {
    expect(loadConfig({ ...base }).ENABLE_DEV_TOOLS).toBe(false);
    expect(loadConfig({ ...base, ENABLE_DEV_TOOLS: '' }).ENABLE_DEV_TOOLS).toBe(false);
    expect(loadConfig({ ...base, ENABLE_DEV_TOOLS: 'false' }).ENABLE_DEV_TOOLS).toBe(false);
  });

  it('turns on in development and test', () => {
    expect(loadConfig({ ...base, ENABLE_DEV_TOOLS: 'true' }).ENABLE_DEV_TOOLS).toBe(true);
    expect(
      loadConfig({ ...base, NODE_ENV: 'test', ENABLE_DEV_TOOLS: 'true' }).ENABLE_DEV_TOOLS,
    ).toBe(true);
  });

  it('refuses to start in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', ENABLE_DEV_TOOLS: 'true' })).toThrow(
      /Refusing to start: ENABLE_DEV_TOOLS=true with NODE_ENV=production/,
    );
    for (const on of ['1', 'yes', 'on', 'TRUE']) {
      expect(() => loadConfig({ ...base, NODE_ENV: 'production', ENABLE_DEV_TOOLS: on })).toThrow(
        /Refusing to start/,
      );
    }
  });

  it('starts in production with the flag off', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).ENABLE_DEV_TOOLS).toBe(false);
  });
});

describe('CONNECTION_TOKEN_KEY', () => {
  it('is not needed while every data provider is a mock', () => {
    expect(loadConfig(base).CONNECTION_TOKEN_KEY).toBeUndefined();
  });

  it('is required by any real data adapter', () => {
    for (const env of [
      { COMMERCE_PROVIDER: 'square' },
      { DELEGATED_SEAT_PROVIDER: 'toast' },
      { BANK_LINK_PROVIDER: 'plaid' },
    ]) {
      expect(() => loadConfig({ ...base, ...env })).toThrow(/CONNECTION_TOKEN_KEY/);
      expect(() =>
        loadConfig({ ...base, ...env, CONNECTION_TOKEN_KEY: 'k'.repeat(40) }),
      ).not.toThrow();
    }
  });

  it('rejects a short key', () => {
    expect(() => loadConfig({ ...base, CONNECTION_TOKEN_KEY: 'short' })).toThrow(/32/);
  });
});

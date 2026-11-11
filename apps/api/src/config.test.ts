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

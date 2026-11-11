import { describe, expect, it } from 'vitest';

import { loadConfig, MIN_ADMIN_TOKEN_LENGTH } from '../config.ts';
import { roleForToken, tokensEqual } from './admin.ts';

const base = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'x'.repeat(32) };
const ADMIN = 'a'.repeat(40);
const REVIEWER = 'r'.repeat(40);

describe('operator tokens', () => {
  it('compares tokens of any length without throwing', () => {
    expect(tokensEqual(ADMIN, ADMIN)).toBe(true);
    expect(tokensEqual(ADMIN, `${ADMIN}x`)).toBe(false);
    expect(tokensEqual('', ADMIN)).toBe(false);
  });

  it('maps a token to its role, and anything else to none', () => {
    const config = { ADMIN_API_TOKEN: ADMIN, REVIEWER_API_TOKEN: REVIEWER };
    expect(roleForToken(ADMIN, config)).toBe('admin');
    expect(roleForToken(REVIEWER, config)).toBe('reviewer');
    expect(roleForToken('nope', config)).toBeNull();
    expect(
      roleForToken(REVIEWER, { ADMIN_API_TOKEN: ADMIN, REVIEWER_API_TOKEN: undefined }),
    ).toBeNull();
    // An unset token never matches an empty one.
    expect(
      roleForToken('', { ADMIN_API_TOKEN: undefined, REVIEWER_API_TOKEN: undefined }),
    ).toBeNull();
  });
});

describe('configuration', () => {
  it('refuses to start with the operator routes enabled and no admin token', () => {
    expect(() => loadConfig({ ...base, ENABLE_ADMIN: 'true' })).toThrow(/ADMIN_API_TOKEN/);
    expect(() => loadConfig({ ...base, ENABLE_ADMIN: 'true', ADMIN_API_TOKEN: '' })).toThrow(
      /ADMIN_API_TOKEN/,
    );
    // A reviewer token alone is not enough.
    expect(() =>
      loadConfig({ ...base, ENABLE_ADMIN: 'true', REVIEWER_API_TOKEN: REVIEWER }),
    ).toThrow(/ADMIN_API_TOKEN/);
  });

  it('starts with a token, and without one when the routes are off', () => {
    expect(loadConfig({ ...base, ENABLE_ADMIN: 'true', ADMIN_API_TOKEN: ADMIN }).ENABLE_ADMIN).toBe(
      true,
    );
    expect(loadConfig(base).ENABLE_ADMIN).toBe(false);
  });

  it('enforces a minimum token length and distinct tokens', () => {
    const short = 'x'.repeat(MIN_ADMIN_TOKEN_LENGTH - 1);
    expect(() => loadConfig({ ...base, ENABLE_ADMIN: 'true', ADMIN_API_TOKEN: short })).toThrow(
      /at least/,
    );
    expect(() => loadConfig({ ...base, REVIEWER_API_TOKEN: short })).toThrow(/at least/);
    expect(() =>
      loadConfig({ ...base, ADMIN_API_TOKEN: ADMIN, REVIEWER_API_TOKEN: ADMIN }),
    ).toThrow(/different/);
  });

  it('rate limits by default, with tighter limits on auth routes', () => {
    const config = loadConfig(base);
    expect(config.RATE_LIMIT_ENABLED).toBe(true);
    expect(config.RATE_LIMIT_AUTH_MAX).toBeLessThan(config.RATE_LIMIT_MAX);
    expect(config.LOGIN_MAX_FAILURES).toBe(5);
  });
});

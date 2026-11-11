import { describe, expect, it } from 'vitest';

import { PROXIED_ROUTES, upstreamPath } from './routes';

describe('proxied routes', () => {
  it('maps a listed route to the API path', () => {
    expect(upstreamPath('GET', ['alerts'])).toBe('/v1/admin/alerts');
    expect(upstreamPath('get', ['alerts', 'cmw123'])).toBe('/v1/admin/alerts/cmw123');
    expect(upstreamPath('POST', ['alerts', 'cmw123', 'resolve'])).toBe(
      '/v1/admin/alerts/cmw123/resolve',
    );
    expect(upstreamPath('GET', ['businesses', 'b_1', 'rent-plans'])).toBe(
      '/v1/admin/businesses/b_1/rent-plans',
    );
    expect(upstreamPath('GET', ['policy', 'evaluation'])).toBe('/v1/admin/policy/evaluation');
  });

  it('refuses the wrong method', () => {
    expect(upstreamPath('POST', ['alerts'])).toBeNull();
    expect(upstreamPath('GET', ['alerts', 'x', 'resolve'])).toBeNull();
    expect(upstreamPath('DELETE', ['alerts', 'x'])).toBeNull();
  });

  it('does not reach the routes that move money or run jobs', () => {
    expect(upstreamPath('POST', ['capital', 'fund'])).toBeNull();
    expect(upstreamPath('POST', ['jobs', 'run'])).toBeNull();
    expect(upstreamPath('GET', ['ledger', 'trial-balance'])).toBeNull();
    for (const route of PROXIED_ROUTES) {
      expect(route.path).not.toMatch(/capital|jobs|whoami/);
    }
  });

  it('refuses a segment that could escape the admin prefix', () => {
    expect(upstreamPath('GET', [])).toBeNull();
    expect(upstreamPath('GET', ['alerts', '..'])).toBeNull();
    expect(upstreamPath('GET', ['alerts', 'a/b'])).toBeNull();
    expect(upstreamPath('GET', ['alerts', '%2e%2e'])).toBeNull();
    expect(upstreamPath('GET', ['alerts', 'x?y=1'])).toBeNull();
    expect(upstreamPath('GET', ['alerts', ''])).toBeNull();
    expect(upstreamPath('GET', ['alerts', 'a'.repeat(65)])).toBeNull();
    expect(upstreamPath('GET', ['..', 'auth', 'login'])).toBeNull();
  });
});

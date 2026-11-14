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
    expect(upstreamPath('GET', ['capital'])).toBeNull();
    expect(upstreamPath('POST', ['jobs', 'run'])).toBeNull();
    expect(upstreamPath('POST', ['jobs'])).toBeNull();
    expect(upstreamPath('GET', ['ledger', 'accounts'])).toBeNull();
    for (const route of PROXIED_ROUTES) {
      expect(route.path).not.toMatch(/capital|whoami|jobs\/run/);
      // Jobs and the ledger are read, never written.
      if (/^(jobs|ledger)/.test(route.path)) expect(route.method).toBe('GET');
    }
  });

  it('reaches the read-only operations views', () => {
    expect(upstreamPath('GET', ['jobs'])).toBe('/v1/admin/jobs');
    expect(upstreamPath('GET', ['delinquency', 'plans'])).toBe('/v1/admin/delinquency/plans');
    expect(upstreamPath('GET', ['ledger', 'trial-balance'])).toBe('/v1/admin/ledger/trial-balance');
    expect(upstreamPath('GET', ['businesses', 'b_1', 'limit'])).toBe(
      '/v1/admin/businesses/b_1/limit',
    );
  });

  it('reaches the tighten-only controls, and only by POST', () => {
    expect(upstreamPath('POST', ['circuit-breaker', 'trip'])).toBe(
      '/v1/admin/circuit-breaker/trip',
    );
    expect(upstreamPath('POST', ['rent-plans', 'p_1', 'freeze'])).toBe(
      '/v1/admin/rent-plans/p_1/freeze',
    );
    expect(upstreamPath('POST', ['businesses', 'b_1', 'limit', 'lower'])).toBe(
      '/v1/admin/businesses/b_1/limit/lower',
    );
    expect(upstreamPath('POST', ['businesses', 'b_1', 'limit', 'remove-cap'])).toBe(
      '/v1/admin/businesses/b_1/limit/remove-cap',
    );
    expect(upstreamPath('GET', ['circuit-breaker', 'trip'])).toBeNull();
    expect(upstreamPath('GET', ['rent-plans', 'p_1', 'freeze'])).toBeNull();
    // There is no route that raises a limit.
    expect(upstreamPath('POST', ['businesses', 'b_1', 'limit', 'raise'])).toBeNull();
    expect(upstreamPath('POST', ['businesses', 'b_1', 'limit'])).toBeNull();
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

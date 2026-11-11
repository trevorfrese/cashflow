import { describe, expect, it } from 'vitest';

import { isSameOrigin, needsOriginCheck } from './csrf';

const request = (headers: Record<string, string>) =>
  new Request('http://localhost:3200/api/admin/alerts/x/resolve', {
    method: 'POST',
    headers: { host: 'localhost:3200', ...headers },
  });

describe('origin check', () => {
  it('accepts a request whose Origin is the host it was sent to', () => {
    expect(isSameOrigin(request({ origin: 'http://localhost:3200' }))).toBe(true);
    expect(isSameOrigin(request({ origin: 'http://LOCALHOST:3200' }))).toBe(true);
  });

  it('refuses another site, another port, and an opaque origin', () => {
    expect(isSameOrigin(request({ origin: 'https://evil.example' }))).toBe(false);
    expect(isSameOrigin(request({ origin: 'http://localhost:3100' }))).toBe(false);
    expect(isSameOrigin(request({ origin: 'http://localhost' }))).toBe(false);
    expect(isSameOrigin(request({ origin: 'null' }))).toBe(false);
    expect(isSameOrigin(request({ origin: 'http://localhost:3200.evil.example' }))).toBe(false);
  });

  it('does not let Sec-Fetch-Site override a foreign Origin', () => {
    expect(
      isSameOrigin(request({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' })),
    ).toBe(false);
  });

  it('falls back to Sec-Fetch-Site when there is no Origin, and refuses when there is neither', () => {
    expect(isSameOrigin(request({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOrigin(request({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isSameOrigin(request({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isSameOrigin(request({}))).toBe(false);
  });

  it('accepts an origin that was explicitly allowed', () => {
    const allowed = ['https://ops.internal.example'];
    expect(isSameOrigin(request({ origin: 'https://ops.internal.example' }), allowed)).toBe(true);
    expect(isSameOrigin(request({ origin: 'https://ops.internal.example/' }), allowed)).toBe(true);
    expect(isSameOrigin(request({ origin: 'https://other.internal.example' }), allowed)).toBe(
      false,
    );
  });

  it('applies to every method that can change state', () => {
    expect(needsOriginCheck('POST')).toBe(true);
    expect(needsOriginCheck('delete')).toBe(true);
    expect(needsOriginCheck('PUT')).toBe(true);
    expect(needsOriginCheck('PATCH')).toBe(true);
    expect(needsOriginCheck('GET')).toBe(false);
    expect(needsOriginCheck('HEAD')).toBe(false);
  });
});

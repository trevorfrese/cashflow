import { describe, expect, it } from 'vitest';

import {
  connectsBySeat,
  healthPill,
  methodPromise,
  pendingActions,
  redirectParams,
  trustLabel,
} from './connections';

describe('connection wording', () => {
  it('says plainly how each platform connects, and never asks for a password', () => {
    expect(methodPromise('SQUARE')).toBe(
      "You will approve read-only access on Square's site. We never see your password.",
    );
    expect(methodPromise('TOAST')).toContain('read-only reports user');
    expect(connectsBySeat('TOAST')).toBe(true);
    expect(connectsBySeat('SHOPIFY')).toBe(false);
  });

  it('labels health and trust', () => {
    expect(healthPill({ health: 'REAUTH_REQUIRED', status: 'LINKED' })).toEqual({
      label: 'Reconnect',
      tone: 'late',
    });
    expect(healthPill({ health: 'HEALTHY', status: 'DISCONNECTED' }).label).toBe('Disconnected');
    expect(trustLabel('HIGH')).toBe('Verified at the source');
    expect(trustLabel('LOW')).toBe('Still being checked');
  });

  it('collects actions once each, connection actions first', () => {
    const conn = (id: string, codes: string[]) => ({
      id,
      actions: codes.map((code) => ({ code, message: `do ${code}` })),
    });
    const list = {
      connections: [
        conn('a', ['CONNECT_PAYOUT_ACCOUNT']),
        conn('b', ['CONNECT_PAYOUT_ACCOUNT', 'RECONNECT']),
      ],
      actions: [{ code: 'CONNECT_BANK', message: 'connect' }],
    } as never;
    expect(pendingActions(list).map((a) => [a.code, a.connectionId])).toEqual([
      ['CONNECT_PAYOUT_ACCOUNT', 'a'],
      ['RECONNECT', 'b'],
      ['CONNECT_BANK', null],
    ]);
  });
});

describe('redirectParams', () => {
  it('reads code, state and error from a redirect', () => {
    expect(redirectParams('cashflow://connect/callback?code=mock_code.abc%3D&state=s1')).toEqual({
      code: 'mock_code.abc=',
      state: 's1',
    });
    expect(redirectParams('/x?error=access_denied&state=s2#frag')).toEqual({
      error: 'access_denied',
      state: 's2',
    });
    expect(redirectParams('/x')).toEqual({});
  });
});

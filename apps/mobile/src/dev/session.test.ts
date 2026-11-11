import type { AuthTokens, User } from '@cashflow/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { replaceSession, SELECTED_BUSINESS_KEY } from './session';

const user: User = {
  id: 'user-new',
  email: 'delinquent@cashflow.local',
  fullName: 'Dana Rivera',
  createdAt: '2026-01-01T00:00:00.000Z',
};
const tokens: AuthTokens = {
  accessToken: 'new-access',
  refreshToken: 'new-refresh',
  expiresIn: 900,
};

function harness() {
  const log: string[] = [];
  const queryClient = new QueryClient();
  queryClient.setQueryData(['businesses'], [{ id: 'biz-old', legalName: 'Blue Door Bakery LLC' }]);
  queryClient.setQueryData(['rent-plans', 'plan-old'], { id: 'plan-old' });
  queryClient.setQueryData(['businesses', 'biz-old', 'applications'], [{ id: 'app-old' }]);
  const cancel = queryClient.cancelQueries.bind(queryClient);
  const clear = queryClient.clear.bind(queryClient);
  const deps = {
    queryClient: {
      cancelQueries: async () => {
        log.push('cancel');
        await cancel();
      },
      clear: () => {
        log.push('clear');
        clear();
      },
    },
    tokenStore: {
      save: async (t: AuthTokens) => {
        log.push(`tokens:${t.accessToken}`);
      },
    },
    storage: {
      remove: async (key: string) => {
        log.push(`remove:${key}`);
      },
    },
    setUser: (u: User) => {
      // What the app would see at the moment it learns who the user is.
      log.push(`user:${u.id}:cached=${queryClient.getQueryCache().getAll().length}`);
    },
  };
  return { log, queryClient, deps };
}

describe('replaceSession', () => {
  it('drops every cached query from the previous account', async () => {
    const { queryClient, deps } = harness();
    expect(queryClient.getQueryCache().getAll().length).toBe(3);
    await replaceSession({ user, tokens }, deps);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
    expect(queryClient.getQueryData(['businesses'])).toBeUndefined();
    expect(queryClient.getQueryData(['rent-plans', 'plan-old'])).toBeUndefined();
  });

  it('has the new tokens in place and the cache empty before the app sees the new user', async () => {
    const { log, deps } = harness();
    await replaceSession({ user, tokens }, deps);
    expect(log).toEqual([
      'cancel',
      'tokens:new-access',
      'clear',
      `remove:${SELECTED_BUSINESS_KEY}`,
      'user:user-new:cached=0',
    ]);
  });

  it('forgets which business the previous account had selected', async () => {
    const { log, deps } = harness();
    await replaceSession({ user, tokens }, deps);
    expect(log).toContain('remove:cashflow.selectedBusinessId');
  });

  it('does not tell the app about the user when saving the tokens fails', async () => {
    const { log, deps } = harness();
    deps.tokenStore.save = async () => {
      throw new Error('keychain unavailable');
    };
    await expect(replaceSession({ user, tokens }, deps)).rejects.toThrow('keychain unavailable');
    expect(log.some((entry) => entry.startsWith('user:'))).toBe(false);
  });
});

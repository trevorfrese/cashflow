import type { LoginRequest, RegisterRequest, User as UserT } from '@cashflow/shared';
import { AuthResponse, User } from '@cashflow/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { api, tokenStore } from './api';

type AuthState = {
  /** Undefined while the stored session is being restored. */
  user: UserT | null | undefined;
  signIn: (input: LoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserT | null | undefined>(undefined);
  const queryClient = useQueryClient();

  const signOut = useCallback(async () => {
    const tokens = await tokenStore.load();
    if (tokens) {
      // Best effort: revoke the refresh token on the server, then forget it locally either way.
      await api('/auth/logout', {
        method: 'POST',
        body: { refreshToken: tokens.refreshToken },
        auth: false,
      }).catch(() => undefined);
    }
    await tokenStore.clear();
    queryClient.clear();
    setUser(null);
  }, [queryClient]);

  useEffect(() => {
    tokenStore.setSessionExpiredHandler(() => {
      queryClient.clear();
      setUser(null);
    });
    return () => tokenStore.setSessionExpiredHandler(null);
  }, [queryClient]);

  // Restore the session on launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tokens = await tokenStore.load();
      if (!tokens) {
        if (!cancelled) setUser(null);
        return;
      }
      try {
        const me = await api('/me', { schema: User });
        if (!cancelled) setUser(me);
      } catch {
        await tokenStore.clear();
        if (!cancelled) setUser(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (input: LoginRequest) => {
    const res = await api('/auth/login', {
      method: 'POST',
      body: input,
      schema: AuthResponse,
      auth: false,
    });
    await tokenStore.save(res.tokens);
    setUser(res.user);
  }, []);

  const register = useCallback(async (input: RegisterRequest) => {
    const res = await api('/auth/register', {
      method: 'POST',
      body: input,
      schema: AuthResponse,
      auth: false,
    });
    await tokenStore.save(res.tokens);
    setUser(res.user);
  }, []);

  const value = useMemo(
    () => ({ user, signIn, register, signOut }),
    [user, signIn, register, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

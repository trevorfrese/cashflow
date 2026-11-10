import type { Business } from '@cashflow/shared';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { useAuth } from './auth';
import { useBusinesses } from './queries';
import { storage } from './storage';

const KEY = 'cashflow.selectedBusinessId';

type BusinessState = {
  businesses: Business[];
  business: Business | undefined;
  isLoading: boolean;
  error: unknown;
  select: (id: string) => void;
  refetch: () => void;
};

const Ctx = createContext<BusinessState | null>(null);

/** Remembers which of the owner's businesses the app is showing. Mounted once, above the router. */
export function BusinessProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const query = useBusinesses(Boolean(user));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    storage.get(KEY).then((v) => {
      setSelectedId(v);
      setRestored(true);
    });
  }, []);

  const businesses = useMemo(() => query.data ?? [], [query.data]);
  const business = businesses.find((b) => b.id === selectedId) ?? businesses[0];

  const value = useMemo<BusinessState>(
    () => ({
      businesses,
      business,
      isLoading: query.isLoading || !restored,
      error: query.error,
      select: (id) => {
        setSelectedId(id);
        void storage.set(KEY, id);
      },
      refetch: () => void query.refetch(),
    }),
    [businesses, business, query, restored],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBusiness(): BusinessState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useBusiness must be used inside BusinessProvider');
  return ctx;
}

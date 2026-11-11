'use client';

import type { AdminRole } from '@cashflow/shared';
import { createContext, useContext, type ReactNode } from 'react';

export interface Operator {
  actor: string;
  role: AdminRole;
}

const OperatorContext = createContext<Operator | null>(null);

/** Who is signed in, resolved on the server from the session cookie. Never the token. */
export function OperatorProvider({
  operator,
  children,
}: {
  operator: Operator;
  children: ReactNode;
}) {
  return <OperatorContext.Provider value={operator}>{children}</OperatorContext.Provider>;
}

export function useOperator(): Operator {
  const operator = useContext(OperatorContext);
  if (!operator) throw new Error('useOperator needs the console layout above it');
  return operator;
}

/**
 * True when the signed in role can do admin only actions. This decides what the console
 * offers. The API decides what is allowed, whatever the console shows.
 */
export function useIsAdmin(): boolean {
  return useOperator().role === 'admin';
}
